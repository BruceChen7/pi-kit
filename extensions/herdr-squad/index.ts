import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createLogger } from "../shared/logger.ts";
import { loadSettings } from "../shared/settings.ts";
import { registerChildReportTool } from "./child.ts";
import { resolveConfiguredModel } from "./config.ts";
import { readSquadReport } from "./io.ts";
import {
  BLOCKED_GRACE_MS,
  buildAgentCommand,
  buildChildPrompt,
  buildSplitPlan,
  COLLECT_DEFAULT_LINES,
  COLLECT_HEADROOM_BYTES,
  COLLECT_PER_AGENT_MIN_BYTES,
  DEFAULT_WAIT_MS,
  formatAgentList,
  formatReport,
  HERDR_CLI_TIMEOUT_MS,
  MANIFEST_FILE,
  MAX_PROMPT_LENGTH,
  MAX_SCOPE_LENGTH,
  MAX_TASK_LENGTH,
  MAX_WAIT_MS,
  POLL_INTERVAL_MS,
  publicSquadDetails,
  RUN_DIR_PREFIX,
  resolveSplitTarget,
  SQUAD_ENTRY_TYPE,
  type SquadAgentState,
  type SquadManifest,
  type SquadState,
  STATE_VERSION,
  validateStartParams,
} from "./shared.ts";

const AssignmentSchema = Type.Object({
  label: Type.String({
    description: "Short unique agent label",
    minLength: 1,
    maxLength: 80,
  }),
  scope: Type.String({
    description: "Exclusive, non-overlapping investigation scope",
    minLength: 1,
    maxLength: MAX_SCOPE_LENGTH,
  }),
  prompt: Type.String({
    description: "Specific read-only investigation instructions",
    minLength: 1,
    maxLength: MAX_PROMPT_LENGTH,
  }),
});

const StartParams = Type.Object({
  task: Type.String({
    description: "Full parent task",
    minLength: 1,
    maxLength: MAX_TASK_LENGTH,
  }),
  count: Type.Integer({
    description: "Exact number of visible agents",
    minimum: 1,
    maximum: 4,
  }),
  assignments: Type.Array(AssignmentSchema, { minItems: 1, maxItems: 4 }),
  title: Type.Optional(
    Type.String({ description: "Short tab title", maxLength: 80 }),
  ),
  model: Type.Optional(
    Type.String({
      description:
        "Optional child model override, for example provider/model or model:thinking",
      minLength: 1,
      maxLength: 200,
    }),
  ),
  focus: Type.Optional(
    Type.Boolean({
      description: "Focus the squad tab after launch; defaults to false",
    }),
  ),
});

const SquadIdParams = Type.Object({
  squadId: Type.String({
    description: "Opaque squad ID returned by herdr_squad_start",
    minLength: 8,
    maxLength: 80,
  }),
  timeoutMs: Type.Optional(
    Type.Integer({
      description: "Overall wait timeout in milliseconds",
      minimum: 1_000,
      maximum: MAX_WAIT_MS,
    }),
  ),
});

const CollectParams = Type.Object({
  squadId: Type.String({
    description: "Opaque squad ID returned by herdr_squad_start",
    minLength: 8,
    maxLength: 80,
  }),
  lines: Type.Optional(
    Type.Integer({
      description:
        "Terminal-tail lines used only when a structured report is missing",
      minimum: 40,
      maximum: 2_000,
    }),
  ),
});

// biome-ignore lint/suspicious/noExplicitAny: Herdr JSON responses are loosely typed
type JsonObject = Record<string, any>;

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Herdr squad wait cancelled"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Herdr squad wait cancelled"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const log = createLogger("herdr-squad", { stderr: null });

export default function (pi: ExtensionAPI) {
  if (registerChildReportTool(pi)) {
    log.info("Loaded in child-agent mode — parent tools skipped");
    return;
  }
  log.info("Loaded in parent mode — registering orchestrator tools");

  const squads = new Map<string, SquadState>();

  function updateSquad(
    squadId: string,
    updater: (state: SquadState) => SquadState,
  ): SquadState {
    const state = squads.get(squadId);
    if (!state) throw new Error(`Unknown Herdr squad ID: ${squadId}`);
    const snapshot = structuredClone(state);
    const updated = updater(snapshot);
    updated.updatedAt = new Date().toISOString();
    squads.set(squadId, updated);
    pi.appendEntry(SQUAD_ENTRY_TYPE, { state: structuredClone(updated) });
    return updated;
  }

  function saveState(state: SquadState): void {
    const snapshot = structuredClone(state);
    snapshot.updatedAt = new Date().toISOString();
    squads.set(snapshot.squadId, snapshot);
    pi.appendEntry(SQUAD_ENTRY_TYPE, { state: structuredClone(snapshot) });
  }

  function getSquad(squadId: string): SquadState {
    const state = squads.get(squadId);
    if (!state) throw new Error(`Unknown Herdr squad ID: ${squadId}`);
    return structuredClone(state);
  }

  async function runHerdr(
    args: string[],
    signal?: AbortSignal,
    timeout = HERDR_CLI_TIMEOUT_MS,
  ) {
    log.debug("herdr exec", { args: args.slice(0, 3), timeout });
    const result = await pi.exec("herdr", args, { signal, timeout });
    if (result.code !== 0) {
      log.error("herdr CLI failed", {
        args: args.slice(0, 3),
        code: result.code,
        stderr: (result.stderr || "").trim().slice(0, 200),
      });
      throw new Error(
        [
          `herdr ${args.slice(0, 2).join(" ")} failed:`,
          (result.stderr || result.stdout).trim() || `exit ${result.code}`,
        ].join(" "),
      );
    }
    return result;
  }

  async function herdr(
    args: string[],
    signal?: AbortSignal,
    timeout = HERDR_CLI_TIMEOUT_MS,
  ): Promise<JsonObject> {
    const result = await runHerdr(args, signal, timeout);
    try {
      return JSON.parse(result.stdout) as JsonObject;
    } catch {
      log.error("herdr JSON parse failed", {
        args: args.slice(0, 3),
        stdout: (result.stdout || "").slice(0, 200),
      });
      throw new Error(
        `herdr ${args.slice(0, 2).join(" ")} returned invalid JSON`,
      );
    }
  }

  async function refreshLivePanes(
    state: SquadState,
    signal?: AbortSignal,
  ): Promise<{ tabFound: boolean; missing: string[] }> {
    if (state.inTab) {
      // In-tab mode: tabId is already known (user's own tab), just verify panes
      let panes: JsonObject[] = [];
      try {
        const response = await herdr(
          ["pane", "list", "--workspace", state.workspaceId],
          signal,
        );
        panes = (response.result?.panes ?? []).filter(
          (pane: JsonObject) => pane.tab_id === state.tabId,
        );
      } catch {
        if (signal?.aborted) throw new Error("Herdr squad operation cancelled");
        return {
          tabFound: false,
          missing: state.agents.map((agent) => agent.label),
        };
      }
      const missing: string[] = [];
      for (const agent of state.agents) {
        const pane =
          panes.find((candidate) => candidate.label === agent.paneLabel) ??
          panes.find(
            (candidate) =>
              candidate.pane_id === agent.paneId &&
              candidate.label === undefined,
          );
        if (!pane?.pane_id) {
          missing.push(agent.label);
          continue;
        }
        agent.paneId = String(pane.pane_id);
        agent.lastAgentStatus =
          typeof pane.agent_status === "string" ? pane.agent_status : "unknown";
      }
      return { tabFound: true, missing };
    }

    let tabs: JsonObject[] = [];
    try {
      const response = await herdr(
        ["tab", "list", "--workspace", state.workspaceId],
        signal,
      );
      tabs = response.result?.tabs ?? [];
    } catch {
      if (signal?.aborted) throw new Error("Herdr squad operation cancelled");
      return {
        tabFound: false,
        missing: state.agents.map((agent) => agent.label),
      };
    }

    const tab = tabs.find((candidate) => candidate.label === state.tabLabel);
    if (!tab?.tab_id)
      return {
        tabFound: false,
        missing: state.agents.map((agent) => agent.label),
      };
    state.tabId = String(tab.tab_id);

    let panes: JsonObject[] = [];
    try {
      const response = await herdr(
        ["pane", "list", "--workspace", state.workspaceId],
        signal,
      );
      panes = (response.result?.panes ?? []).filter(
        (pane: JsonObject) => pane.tab_id === state.tabId,
      );
    } catch {
      if (signal?.aborted) throw new Error("Herdr squad operation cancelled");
      return {
        tabFound: true,
        missing: state.agents.map((agent) => agent.label),
      };
    }

    const missing: string[] = [];
    for (const agent of state.agents) {
      const pane =
        panes.find((candidate) => candidate.label === agent.paneLabel) ??
        panes.find(
          (candidate) =>
            candidate.pane_id === agent.paneId && candidate.label === undefined,
        );
      if (!pane?.pane_id) {
        missing.push(agent.label);
        continue;
      }
      agent.paneId = String(pane.pane_id);
      agent.lastAgentStatus =
        typeof pane.agent_status === "string" ? pane.agent_status : "unknown";
    }
    return { tabFound: true, missing };
  }

  pi.on("session_start", (_event, ctx) => {
    const snapshots = ctx.sessionManager
      .getBranch()
      .filter(
        // biome-ignore lint/suspicious/noExplicitAny: Pi session entry type is unknown
        (entry: any) =>
          entry.type === "custom" &&
          entry.customType === SQUAD_ENTRY_TYPE &&
          entry.data?.state,
      )
      .map(
        // biome-ignore lint/suspicious/noExplicitAny: Pi session entry type is unknown
        (entry: any) => entry.data.state as SquadState,
      )
      .filter(
        (state) =>
          state.version === STATE_VERSION &&
          typeof state.squadId === "string" &&
          state.status !== "disposed",
      )
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    log.info(`Restored ${snapshots.length} squad(s) from session`);
    for (const state of snapshots) {
      state.modelSource ??= "pi-default";
      squads.set(state.squadId, state);
      log.debug(`Restored squad ${state.squadId}`, {
        status: state.status,
        agents: state.agents.length,
      });
    }
  });

  log.info("Registering tool: herdr_squad_start");
  pi.registerTool({
    name: "herdr_squad_start",
    label: "Start Herdr Squad",
    description: [
      "Create and launch 1-4 visible, strictly read-only Pi investigation agents",
      "in a new Herdr tab. An explicit model overrides project/global Herdr squad",
      "config; otherwise Pi's default is used. Returns an opaque squadId. Call this",
      "tool alone; wait for its result before calling herdr_squad_wait.",
    ].join(" "),
    promptSnippet: "Launch a visible read-only Herdr investigation squad",
    promptGuidelines: [
      [
        "Call herdr_squad_start only after defining distinct non-overlapping scopes,",
        "and call it in a separate tool round before herdr_squad_wait.",
      ].join(" "),
      [
        "Always include task with the full parent request (copied or faithfully",
        "summarized), plus count and exactly count assignments. task is required",
        "even when assignment prompts are self-contained.",
      ].join(" "),
    ],
    parameters: StartParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const v = validateStartParams(
        {
          task: params.task,
          count: params.count,
          assignments: params.assignments.map((a) => ({
            label: a.label,
            scope: a.scope,
            prompt: a.prompt,
          })),
          title: params.title,
          model: params.model,
        },
        process.env,
        { randomUUID: () => crypto.randomUUID(), randomBytes },
        () => {
          const { global, project } = loadSettings(ctx.cwd);
          return resolveConfiguredModel(
            global as Record<string, unknown>,
            project as Record<string, unknown>,
            ctx.isProjectTrusted(),
          );
        },
      );

      log.info(`Squad ${v.squadId} validation passed`, {
        model: v.model,
        modelSource: v.modelSource,
        count: params.count,
        agents: v.agents.map((a) => a.label),
      });

      const parentResponse = await herdr(
        ["pane", "get", v.parentPaneId],
        signal,
      );
      const parentPane = parentResponse.result?.pane;
      if (!parentPane?.workspace_id || parentPane.pane_id !== v.parentPaneId) {
        log.error("Parent pane validation failed", {
          parentPaneId: v.parentPaneId,
          pane: parentPane,
        });
        throw new Error("Could not validate the parent Herdr pane");
      }
      const workspaceId = String(parentPane.workspace_id);
      const parentTabId = String(parentPane.tab_id);
      log.info("Parent pane validated", {
        workspaceId,
        paneId: v.parentPaneId,
        tabId: parentTabId,
      });
      const runDir = await mkdtemp(join(tmpdir(), RUN_DIR_PREFIX));
      const manifest: SquadManifest = {
        version: 1,
        squadId: v.squadId,
        agents: v.manifestAgents,
      };
      await writeFile(
        join(runDir, MANIFEST_FILE),
        `${JSON.stringify(manifest, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );

      const agents: SquadAgentState[] = v.agents.map((agent) => ({
        ...agent,
        reportPath: join(runDir, agent.reportPath),
        promptPath: join(runDir, agent.promptPath),
      }));

      for (const agent of agents) {
        await writeFile(
          agent.promptPath,
          buildChildPrompt(
            v.task,
            agent.label,
            agent.scope,
            v.normalizedAssignments.find((a) => a.label === agent.label)
              ?.prompt ?? "",
          ),
          { encoding: "utf8", mode: 0o600 },
        );
      }

      const splitPlan = buildSplitPlan(params.count);
      const inTab = splitPlan.some((op) => op.targetRef === "parent");

      let state: SquadState | undefined;
      let createdTab = false;
      try {
        const buildInitState = (
          overrides: Partial<
            Pick<SquadState, "tabId" | "rootPaneId" | "inTab">
          >,
        ): SquadState => ({
          version: STATE_VERSION,
          squadId: v.squadId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          cwd: ctx.cwd,
          workspaceId,
          tabLabel: v.tabLabel,
          runDir,
          task: v.task,
          title: v.title,
          model: v.model,
          modelSource: v.modelSource,
          status: "launching",
          agents,
          ...overrides,
        });

        if (inTab) {
          state = buildInitState({
            tabId: parentTabId,
            rootPaneId: "",
            inTab: true,
          });
          onUpdate?.({
            content: [
              {
                type: "text",
                text: `Splitting current pane for ${params.count} agent(s)...`,
              },
            ],
            details: {},
          });
        } else {
          onUpdate?.({
            content: [
              {
                type: "text",
                text: `Creating Herdr squad tab with ${params.count} pane(s)...`,
              },
            ],
            details: {},
          });
          const tabResponse = await herdr(
            [
              "tab",
              "create",
              "--workspace",
              workspaceId,
              "--cwd",
              ctx.cwd,
              "--label",
              v.tabLabel,
              "--no-focus",
            ],
            signal,
          );
          const tab = tabResponse.result?.tab;
          const rootPane = tabResponse.result?.root_pane;
          if (!tab?.tab_id || !rootPane?.pane_id) {
            log.error("Tab creation response missing IDs", {
              tab,
              rootPane,
            });
            throw new Error(
              "Herdr tab creation response did not include tab and root pane IDs",
            );
          }
          createdTab = true;
          log.info("Tab created", {
            tabId: tab.tab_id,
            tabLabel: v.tabLabel,
            rootPaneId: rootPane.pane_id,
          });
          agents[0].paneId = String(rootPane.pane_id);
          state = buildInitState({
            tabId: String(tab.tab_id),
            rootPaneId: String(rootPane.pane_id),
          });
        }
        for (const op of splitPlan) {
          const targetPaneId = resolveSplitTarget(
            op,
            v.parentPaneId,
            agents,
            state.rootPaneId,
          );
          const split = await herdr(
            [
              "pane",
              "split",
              targetPaneId,
              "--direction",
              op.direction,
              "--cwd",
              ctx.cwd,
              "--no-focus",
            ],
            signal,
          );
          agents[op.targetIndex].paneId = String(
            split.result?.pane?.pane_id || "",
          );
          if (!agents[op.targetIndex].paneId) {
            log.error("Pane split failed — no pane ID returned", {
              direction: op.direction,
              targetIndex: op.targetIndex,
            });
            throw new Error("Pane split did not return a pane ID");
          }
          log.debug("Split done", {
            paneId: agents[op.targetIndex].paneId,
            direction: op.direction,
          });
        }

        for (const agent of agents) {
          await runHerdr(
            ["pane", "rename", agent.paneId, agent.paneLabel],
            signal,
          );
          log.debug("Pane renamed", {
            paneId: agent.paneId,
            label: agent.paneLabel,
          });
        }

        for (let index = 0; index < agents.length; index++) {
          const agent = agents[index];
          const identity = v.manifestAgents[index];
          const command = buildAgentCommand(
            runDir,
            v.squadId,
            agent.agentId,
            identity.token,
            agent.label,
            agent.promptPath,
            state.model,
          );
          await runHerdr(["pane", "run", agent.paneId, command], signal);
          log.debug(`Agent ${agent.label} launched`, {
            paneId: agent.paneId,
            agentId: agent.agentId,
          });
        }

        state.status = "running";
        if (params.focus === true)
          await runHerdr(["tab", "focus", state.tabId], signal);
        saveState(state);
        log.info(`Squad ${v.squadId} started successfully`, {
          agents: state.agents.length,
          tab: v.tabLabel,
        });
        return {
          content: [
            {
              type: "text",
              text: [
                `Started read-only Herdr squad ${v.squadId}.`,
                `Tab: ${v.tabLabel}`,
                `Model: ${state.model ?? "Pi default"} (${state.modelSource})`,
                formatAgentList(state),
                ``,
                `Call herdr_squad_wait with this squadId in the next tool round.`,
              ].join("\n"),
            },
          ],
          details: publicSquadDetails(state),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error(`Squad ${v.squadId} launch failed`, {
          error: message,
          createdTab,
        });
        if (!createdTab) {
          await rm(runDir, { recursive: true, force: true });
          throw error;
        }
        if (state) {
          state.status = "partial";
          state.failure = message;
          saveState(state);
          return {
            content: [
              {
                type: "text",
                text: [
                  `Herdr squad ${state.squadId} launch was partial: ${message}`,
                  formatAgentList(state),
                  `The created tab was left open for inspection. Use this squadId to` +
                    ` wait for or collect any agents that did launch.`,
                ].join("\n"),
              },
            ],
            details: publicSquadDetails(state),
          };
        }
        throw error;
      }
    },
  });

  log.info("Registering tool: herdr_squad_wait");
  pi.registerTool({
    name: "herdr_squad_wait",
    label: "Wait for Herdr Squad",
    description: [
      "Wait for every child in a previously started Herdr squad to submit its",
      "structured report. Uses one overall timeout and reports blockers. Call",
      "alone after herdr_squad_start has returned.",
    ].join(" "),
    promptSnippet: "Wait for a Herdr squad's structured reports",
    promptGuidelines: [
      [
        "Call herdr_squad_wait only after herdr_squad_start has returned a squadId,",
        "and wait for its result before calling herdr_squad_collect.",
      ].join(" "),
    ],
    parameters: SquadIdParams,
    async execute(_toolCallId, params, signal, onUpdate) {
      let state = getSquad(params.squadId);
      const timeoutMs = params.timeoutMs ?? DEFAULT_WAIT_MS;
      const deadline = Date.now() + timeoutMs;
      const blockedSince = new Map<string, number>();

      log.info(`Waiting for squad ${params.squadId}`, {
        timeoutMs,
        agents: state.agents.length,
      });

      try {
        while (true) {
          if (signal?.aborted) {
            log.warn(`Squad ${params.squadId} wait cancelled by signal`);
            throw new Error("Herdr squad wait cancelled");
          }
          const results = await Promise.allSettled(
            state.agents.map((agent) => readSquadReport(agent.reportPath)),
          );
          const reports = results.map((r) =>
            r.status === "fulfilled" ? r.value : undefined,
          );
          const completeCount = reports.filter(Boolean).length;
          if (completeCount === state.agents.length) {
            state.status = "completed";
            delete state.failure;
            saveState(state);
            log.info(
              `Squad ${params.squadId} all ${completeCount} reports ready`,
            );
            return {
              content: [
                {
                  type: "text",
                  text: [
                    `All ${completeCount} Herdr squad reports are ready.`,
                    `Call herdr_squad_collect with squadId ${state.squadId} in the next tool round.`,
                  ].join(" "),
                },
              ],
              details: {
                ...publicSquadDetails(state),
                completeCount,
                timedOut: false,
              },
            };
          }

          const live = await refreshLivePanes(state, signal);
          if (!live.tabFound || live.missing.length > 0) {
            state.status = "partial";
            state.failure = !live.tabFound
              ? "Squad tab is no longer available"
              : `Missing panes: ${live.missing.join(", ")}`;
            saveState(state);
            log.warn(`Squad ${params.squadId} partial`, {
              failure: state.failure,
              completeCount,
            });
            return {
              content: [
                {
                  type: "text",
                  text: [
                    `${completeCount}/${state.agents.length} reports are ready.`,
                    `${state.failure}. Collect the available reports now.`,
                  ].join(" "),
                },
              ],
              details: {
                ...publicSquadDetails(state),
                completeCount,
                timedOut: false,
              },
            };
          }

          const now = Date.now();
          for (let index = 0; index < state.agents.length; index++) {
            if (reports[index]) continue;
            const agent = state.agents[index];
            if (agent.lastAgentStatus === "done") {
              state.status = "partial";
              state.failure = [
                `${agent.label} (pane ${agent.paneId}) terminated with`,
                `Herdr status done without submitting a report`,
              ].join(" ");
              saveState(state);
              log.warn(
                `Squad ${params.squadId}: ${agent.label} done without report`,
              );
              return {
                content: [
                  {
                    type: "text",
                    text: [
                      `${completeCount}/${state.agents.length} reports are ready.`,
                      `${state.failure}. Collect available reports and terminal output now.`,
                    ].join(" "),
                  },
                ],
                details: {
                  ...publicSquadDetails(state),
                  completeCount,
                  terminated: agent.label,
                  terminalStatus: "done",
                  timedOut: false,
                },
              };
            }
            if (agent.lastAgentStatus === "blocked") {
              const since = blockedSince.get(agent.agentId) ?? now;
              blockedSince.set(agent.agentId, since);
              if (now - since >= BLOCKED_GRACE_MS) {
                state.status = "partial";
                state.failure = `${agent.label} is blocked`;
                saveState(state);
                log.warn(`Squad ${params.squadId}: ${agent.label} blocked`);
                return {
                  content: [
                    {
                      type: "text",
                      text: [
                        `${completeCount}/${state.agents.length} reports are ready.`,
                        `${agent.label} is blocked; collect available output and report the blocker.`,
                      ].join(" "),
                    },
                  ],
                  details: {
                    ...publicSquadDetails(state),
                    completeCount,
                    blocked: agent.label,
                    timedOut: false,
                  },
                };
              }
              log.debug(
                `Squad ${params.squadId}: ${agent.label} blocked (grace)`,
              );
            } else {
              blockedSince.delete(agent.agentId);
            }
          }

          onUpdate?.({
            content: [
              {
                type: "text",
                text: `Herdr squad: ${completeCount}/${state.agents.length} reports ready...`,
              },
            ],
            details: { squadId: state.squadId, completeCount },
          });
          if (Date.now() >= deadline) {
            state.status = "partial";
            state.failure = `Timed out after ${timeoutMs}ms`;
            saveState(state);
            log.warn(`Squad ${params.squadId} timed out`, {
              completeCount,
              timeoutMs,
            });
            return {
              content: [
                {
                  type: "text",
                  text: [
                    `${completeCount}/${state.agents.length} reports were ready`,
                    `before the overall timeout. Collect available reports and`,
                    `terminal fallbacks now.`,
                  ].join(" "),
                },
              ],
              details: {
                ...publicSquadDetails(state),
                completeCount,
                timedOut: true,
              },
            };
          }
          await delay(
            Math.min(POLL_INTERVAL_MS, deadline - Date.now()),
            signal,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        state = updateSquad(params.squadId, (s) => {
          s.status = "partial";
          s.failure = message;
          return s;
        });
        log.error(`Squad ${params.squadId} wait failed`, { error: message });
        return {
          content: [
            {
              type: "text",
              text: [
                `Herdr squad wait failed: ${message}`,
                `Collect available reports now.`,
              ].join(" "),
            },
          ],
          details: {
            ...publicSquadDetails(state),
            completeCount: 0,
            timedOut: false,
          },
        };
      }
    },
  });

  log.info("Registering tool: herdr_squad_collect");
  pi.registerTool({
    name: "herdr_squad_collect",
    label: "Collect Herdr Squad",
    description: [
      `Collect structured reports from a Herdr squad, with bounded terminal-tail`,
      `fallbacks. Output is limited to ${DEFAULT_MAX_LINES} lines or`,
      `${formatSize(DEFAULT_MAX_BYTES)}; complete collected output is saved when`,
      `truncation is needed. Call only after herdr_squad_wait returns.`,
    ].join(" "),
    promptSnippet:
      "Collect a Herdr squad's reports and fallback terminal output",
    promptGuidelines: [
      "Call herdr_squad_collect only after the corresponding herdr_squad_wait call has returned.",
    ],
    parameters: CollectParams,
    async execute(_toolCallId, params, signal) {
      const state = getSquad(params.squadId);
      log.info(`Collecting squad ${params.squadId}`, {
        agents: state.agents.length,
        status: state.status,
      });
      const lines = params.lines ?? COLLECT_DEFAULT_LINES;
      const live = await refreshLivePanes(state, signal);
      const missingPanes = new Set(live.missing);
      if (live.missing.length > 0) {
        log.warn(
          `Squad ${params.squadId}: ${live.missing.length} pane(s) missing`,
        );
      }
      const perAgentBytes = Math.max(
        COLLECT_PER_AGENT_MIN_BYTES,
        Math.floor(
          (DEFAULT_MAX_BYTES - COLLECT_HEADROOM_BYTES) / state.agents.length,
        ),
      );
      const sections: string[] = [];
      let structuredCount = 0;

      for (const agent of state.agents) {
        const report = await readSquadReport(agent.reportPath);
        let section: string;
        if (
          report &&
          report.squadId === state.squadId &&
          report.agentId === agent.agentId
        ) {
          structuredCount++;
          section = formatReport(report, agent.reportPath);
        } else {
          let transcript = !live.tabFound
            ? "Terminal output unavailable because the squad tab could not be revalidated."
            : missingPanes.has(agent.label)
              ? "Terminal output unavailable because this pane could not be revalidated."
              : "Terminal output unavailable.";
          if (live.tabFound && !missingPanes.has(agent.label) && agent.paneId) {
            try {
              const result = await pi.exec(
                "herdr",
                [
                  "pane",
                  "read",
                  agent.paneId,
                  "--source",
                  "recent-unwrapped",
                  "--lines",
                  String(lines),
                ],
                { signal, timeout: HERDR_CLI_TIMEOUT_MS },
              );
              if (result.code === 0 && result.stdout.trim())
                transcript = result.stdout.trim();
              else if (result.stderr.trim())
                transcript = `Terminal read failed: ${result.stderr.trim()}`;
            } catch (error) {
              transcript = `Terminal read failed: ${
                error instanceof Error ? error.message : String(error)
              }`;
            }
          }
          const transcriptPath = join(
            state.runDir,
            `terminal-${agent.agentId}.txt`,
          );
          await writeFile(transcriptPath, `${transcript}\n`, {
            encoding: "utf8",
            mode: 0o600,
          });
          section = [
            `# Squad Report Missing: ${agent.label}`,
            `## Scope`,
            agent.scope,
            `## Status`,
            [
              `No valid structured report was submitted.`,
              `Last Herdr status: ${agent.lastAgentStatus ?? "unknown"}.`,
            ].join(" "),
            `## Terminal tail`,
            transcript,
            ``,
            `Terminal snapshot: ${transcriptPath}`,
          ].join("\n");
        }

        const limited = truncateHead(section, {
          maxBytes: perAgentBytes,
          maxLines: DEFAULT_MAX_LINES,
        });
        sections.push(
          limited.truncated
            ? [
                limited.content,
                ``,
                `[Agent section truncated. Full source is available at ${
                  report
                    ? agent.reportPath
                    : join(state.runDir, `terminal-${agent.agentId}.txt`)
                }]`,
              ].join("\n")
            : limited.content,
        );
      }

      const fullCollection = [
        `## Herdr squad collection`,
        `- Squad: ${state.squadId}`,
        `- Tab: ${state.tabLabel}`,
        `- Model: ${state.model ?? "Pi default"} (${state.modelSource})`,
        `- Mode: read-only investigation`,
        `- Structured reports: ${structuredCount}/${state.agents.length}`,
        ``,
        sections.join("\n\n---\n\n"),
      ].join("\n");
      const truncation = truncateHead(fullCollection, {
        maxBytes: DEFAULT_MAX_BYTES,
        maxLines: DEFAULT_MAX_LINES,
      });
      let output = truncation.content;
      let fullOutputPath: string | undefined;
      if (truncation.truncated) {
        fullOutputPath = join(state.runDir, "collection.md");
        await withFileMutationQueue(fullOutputPath, () => {
          const outPath = fullOutputPath as string;
          return writeFile(outPath, `${fullCollection}\n`, {
            encoding: "utf8",
            mode: 0o600,
          });
        });
        output += [
          ``,
          `[Collection truncated: showing ${truncation.outputLines}/${truncation.totalLines}`,
          `lines and ${formatSize(truncation.outputBytes)}/${formatSize(truncation.totalBytes)}.`,
          `Full collection: ${fullOutputPath}]`,
        ].join(" ");
      }

      state.status = "collected";
      if (structuredCount === state.agents.length) delete state.failure;
      state.collectedAt = new Date().toISOString();
      saveState(state);
      log.info(`Squad ${params.squadId} collected`, {
        structuredCount,
        total: state.agents.length,
        truncated: !!fullOutputPath,
      });

      // ── Cleanup: close tab / panes, dispose state ──────────────────
      let tabCloseFailed = false;
      if (state.inTab) {
        // In-tab mode: close agent panes only; herdr auto-collapses the layout
        for (const agent of state.agents) {
          try {
            if (agent.paneId) {
              await runHerdr(["pane", "close", agent.paneId]);
              log.debug(`Agent pane closed`, {
                paneId: agent.paneId,
                label: agent.label,
              });
            }
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            log.warn(`Agent pane close failed`, {
              paneId: agent.paneId,
              label: agent.label,
              error: msg,
            });
          }
        }
      } else {
        try {
          await runHerdr(["tab", "close", state.tabId]);
          log.info(`Squad ${params.squadId} tab closed`, {
            tabId: state.tabId,
          });
        } catch (error) {
          tabCloseFailed = true;
          const msg = error instanceof Error ? error.message : String(error);
          log.warn(`Squad ${params.squadId} tab close failed`, {
            tabId: state.tabId,
            error: msg,
          });
        }
      }

      const disposedState: SquadState = {
        ...state,
        status: "disposed",
        disposedAt: new Date().toISOString(),
      };
      pi.appendEntry(SQUAD_ENTRY_TYPE, { state: disposedState });
      squads.delete(state.squadId);
      log.info(`Squad ${params.squadId} disposed`, {
        tabCloseFailed,
      });

      return {
        content: [{ type: "text", text: output }],
        details: {
          ...publicSquadDetails(disposedState),
          structuredCount,
          fullOutputPath,
          tabCloseFailed,
        },
      };
    },
  });
}
