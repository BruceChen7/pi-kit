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
import { registerChildReportTool } from "./child.ts";
import { resolveConfiguredModel } from "./config.ts";
import {
  buildChildPrompt,
  MANIFEST_FILE,
  MAX_PROMPT_LENGTH,
  MAX_SCOPE_LENGTH,
  MAX_TASK_LENGTH,
  RUN_DIR_PREFIX,
  readSquadReport,
  SQUAD_ENTRY_TYPE,
  type SquadAgentState,
  type SquadManifest,
  type SquadState,
  STATE_VERSION,
  shellQuote,
  validateStartParams,
} from "./shared.ts";

const DEFAULT_WAIT_MS = 5 * 60_000;
const MAX_WAIT_MS = 30 * 60_000;
const BLOCKED_GRACE_MS = 1_500;
const POLL_INTERVAL_MS = 500;

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

function publicSquadDetails(state: SquadState) {
  return {
    squadId: state.squadId,
    status: state.status,
    tabId: state.tabId,
    tabLabel: state.tabLabel,
    cwd: state.cwd,
    model: state.model,
    modelSource: state.modelSource,
    agents: state.agents.map((agent) => ({
      paneId: agent.paneId,
      label: agent.label,
      scope: agent.scope,
      status: agent.lastAgentStatus,
    })),
    failure: state.failure,
  };
}

function formatAgentList(state: SquadState): string {
  return state.agents
    .map(
      (agent) =>
        `- ${agent.label}: ${agent.scope} (pane ${agent.paneId || "not created"})`,
    )
    .join("\n");
}

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

function formatReport(
  report: Awaited<ReturnType<typeof readSquadReport>>,
  sourcePath: string,
): string {
  if (!report) return "";
  const evidence =
    report.evidence.length > 0
      ? report.evidence.map((item) => `- ${item}`).join("\n")
      : "- None reported";
  const risks =
    report.risksOrUnknowns.length > 0
      ? report.risksOrUnknowns.map((item) => `- ${item}`).join("\n")
      : "- None reported";
  return [
    `# Squad Report: ${report.label}`,
    `## Scope`,
    report.scope,
    `## Recommended next step`,
    report.recommendedNextStep,
    `## Findings`,
    report.findings,
    `## Evidence`,
    evidence,
    `## Risks / Unknowns`,
    risks,
    ``,
    `Structured report: ${sourcePath}`,
  ].join("\n");
}

export default function (pi: ExtensionAPI) {
  if (registerChildReportTool(pi)) return;

  const squads = new Map<string, SquadState>();

  function saveState(state: SquadState): void {
    state.updatedAt = new Date().toISOString();
    squads.set(state.squadId, state);
    pi.appendEntry(SQUAD_ENTRY_TYPE, { state: structuredClone(state) });
  }

  function getSquad(squadId: string): SquadState {
    const state = squads.get(squadId);
    if (!state) throw new Error(`Unknown Herdr squad ID: ${squadId}`);
    return state;
  }

  async function runHerdr(
    args: string[],
    signal?: AbortSignal,
    timeout = 15_000,
  ) {
    const result = await pi.exec("herdr", args, { signal, timeout });
    if (result.code !== 0) {
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
    timeout = 15_000,
  ): Promise<JsonObject> {
    const result = await runHerdr(args, signal, timeout);
    try {
      return JSON.parse(result.stdout) as JsonObject;
    } catch {
      throw new Error(
        `herdr ${args.slice(0, 2).join(" ")} returned invalid JSON`,
      );
    }
  }

  async function refreshLivePanes(
    state: SquadState,
    signal?: AbortSignal,
  ): Promise<{ tabFound: boolean; missing: string[] }> {
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
          state.version === STATE_VERSION && typeof state.squadId === "string",
      )
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    for (const state of snapshots) {
      state.modelSource ??= "pi-default";
      squads.set(state.squadId, state);
    }
  });

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
        { randomUUID: crypto.randomUUID, randomBytes },
        () => resolveConfiguredModel(ctx.cwd, ctx.isProjectTrusted()),
      );

      const parentResponse = await herdr(
        ["pane", "get", v.parentPaneId],
        signal,
      );
      const parentPane = parentResponse.result?.pane;
      if (!parentPane?.workspace_id || parentPane.pane_id !== v.parentPaneId)
        throw new Error("Could not validate the parent Herdr pane");
      const workspaceId = String(parentPane.workspace_id);
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

      let state: SquadState | undefined;
      let createdTab = false;
      try {
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
        if (!tab?.tab_id || !rootPane?.pane_id)
          throw new Error(
            "Herdr tab creation response did not include tab and root pane IDs",
          );
        createdTab = true;
        agents[0].paneId = String(rootPane.pane_id);
        state = {
          version: STATE_VERSION,
          squadId: v.squadId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          cwd: ctx.cwd,
          workspaceId,
          tabId: String(tab.tab_id),
          tabLabel: v.tabLabel,
          rootPaneId: String(rootPane.pane_id),
          runDir,
          task: v.task,
          title: v.title,
          model: v.model,
          modelSource: v.modelSource,
          status: "launching",
          agents,
        };

        if (params.count >= 2) {
          const split = await herdr(
            [
              "pane",
              "split",
              state.rootPaneId,
              "--direction",
              "right",
              "--cwd",
              ctx.cwd,
              "--no-focus",
            ],
            signal,
          );
          agents[1].paneId = String(split.result?.pane?.pane_id || "");
          if (!agents[1].paneId)
            throw new Error("Right split did not return a pane ID");
        }
        if (params.count >= 3) {
          const split = await herdr(
            [
              "pane",
              "split",
              state.rootPaneId,
              "--direction",
              "down",
              "--cwd",
              ctx.cwd,
              "--no-focus",
            ],
            signal,
          );
          agents[2].paneId = String(split.result?.pane?.pane_id || "");
          if (!agents[2].paneId)
            throw new Error("Lower-left split did not return a pane ID");
        }
        if (params.count >= 4) {
          const split = await herdr(
            [
              "pane",
              "split",
              agents[1].paneId,
              "--direction",
              "down",
              "--cwd",
              ctx.cwd,
              "--no-focus",
            ],
            signal,
          );
          agents[3].paneId = String(split.result?.pane?.pane_id || "");
          if (!agents[3].paneId)
            throw new Error("Lower-right split did not return a pane ID");
        }

        for (const agent of agents)
          await runHerdr(
            ["pane", "rename", agent.paneId, agent.paneLabel],
            signal,
          );

        for (let index = 0; index < agents.length; index++) {
          const agent = agents[index];
          const identity = v.manifestAgents[index];
          const commandArguments = [
            "env",
            `HERDR_SQUAD_DIR=${runDir}`,
            `HERDR_SQUAD_ID=${v.squadId}`,
            `HERDR_SQUAD_AGENT_ID=${agent.agentId}`,
            `HERDR_SQUAD_TOKEN=${identity.token}`,
            "pi",
            "--name",
            `Squad ${agent.label}`,
          ];
          if (state.model) commandArguments.push("--model", state.model);
          commandArguments.push(
            "--tools",
            "read,grep,find,ls,herdr_squad_report",
            "--no-skills",
            "--no-prompt-templates",
            `@${agent.promptPath}`,
          );
          const command = commandArguments.map(shellQuote).join(" ");
          await runHerdr(["pane", "run", agent.paneId, command], signal);
        }

        state.status = "running";
        if (params.focus === true)
          await runHerdr(["tab", "focus", state.tabId], signal);
        saveState(state);
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
      const state = getSquad(params.squadId);
      const timeoutMs = params.timeoutMs ?? DEFAULT_WAIT_MS;
      const deadline = Date.now() + timeoutMs;
      const blockedSince = new Map<string, number>();

      while (true) {
        if (signal?.aborted) throw new Error("Herdr squad wait cancelled");
        const reports = await Promise.all(
          state.agents.map((agent) => readSquadReport(agent.reportPath)),
        );
        const completeCount = reports.filter(Boolean).length;
        if (completeCount === state.agents.length) {
          state.status = "completed";
          delete state.failure;
          saveState(state);
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
        await delay(Math.min(POLL_INTERVAL_MS, deadline - Date.now()), signal);
      }
    },
  });

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
      const lines = params.lines ?? 240;
      const live = await refreshLivePanes(state, signal);
      const missingPanes = new Set(live.missing);
      const perAgentBytes = Math.max(
        8_000,
        Math.floor((DEFAULT_MAX_BYTES - 4_000) / state.agents.length),
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
                { signal, timeout: 15_000 },
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
      return {
        content: [{ type: "text", text: output }],
        details: {
          ...publicSquadDetails(state),
          structuredCount,
          fullOutputPath,
        },
      };
    },
  });
}
