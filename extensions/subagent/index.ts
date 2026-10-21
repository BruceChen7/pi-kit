/**
 * subagent 扩展入口（Shell）。
 *
 * 职责：读盘拿 agent 文件、组装 profile、注册工具、把 core 的状态机结论
 * 落成真实副作用（起会话、发消息、刷 widget）。
 * 判断逻辑一律在 agents.ts / core.ts / rpc.ts，这里只编排。
 */

import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AgentSession,
  AgentToolResult,
  ExtensionAPI,
  ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createLogger, resolveMinLogLevel } from "../shared/logger.ts";
import {
  getGlobalSettingsPath,
  loadGlobalSettings,
} from "../shared/settings.ts";
import {
  type StructuredPayload,
  structuredResult,
} from "../shared/structured-result.ts";
import {
  type AgentProfile,
  type AgentSource,
  BUILTIN_AGENTS,
  discoverProfiles,
  findProfile,
} from "./agents.ts";
import {
  activeRuns,
  admit,
  appendTranscript,
  createState,
  DEFAULT_MAX_CONCURRENT,
  eventToTranscriptLine,
  extractAssistantText,
  findRun,
  isTerminal,
  renderDoctor,
  renderWidgetLines,
  type SubagentState,
  setStep,
  settle,
  stop,
} from "./core.ts";
import {
  buildRunEvent,
  handleRpc,
  parseRpcRequest,
  RPC_EVENT_CHANNEL,
  RPC_REQUEST_CHANNEL,
  type RpcAction,
  rpcReplyChannel,
} from "./rpc.ts";
import {
  bootChildSession,
  type ChildCapabilities,
  disposeChild,
  steerChild,
} from "./session.ts";
import { registerAgentsCommand } from "./ui.ts";

const WIDGET_KEY = "subagent";
const log = createLogger("subagent", { stderr: null });

export type RunOutcome = {
  runId: string;
  status: "done" | "failed" | "stopped";
  agent: string;
  text: string;
};

export type SubagentRuntime = {
  readState: () => SubagentState;
  refreshWidget: () => void;
  loadProfiles: (cwd?: string) => Promise<{
    profiles: AgentProfile[];
    scannedDirs: string[];
  }>;
  run: (input: {
    agent?: string;
    task: string;
    background: boolean;
  }) => Promise<RunOutcome>;
  steer: (runId: string, text: string) => Promise<boolean>;
  stopRun: (runId: string) => void;
  doctor: () => Promise<string[]>;
  waitFor: (runId: string) => Promise<RunOutcome>;
};

async function readAgentDir(
  dir: string,
  source: AgentSource["source"],
): Promise<AgentSource[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const sources: AgentSource[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const path = join(dir, entry);
    try {
      const content = await readFile(path, "utf8");
      sources.push({ name: entry.slice(0, -3), content, source });
    } catch (error) {
      log.warn("agent file unreadable", {
        path,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return sources;
}

function lastAssistantText(session: AgentSession): string {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const message = session.messages[i] as {
      role?: string;
      content?: unknown;
    };
    if (message?.role !== "assistant") continue;
    const text = extractAssistantText(message.content).trim();
    if (text) return text;
  }
  return "";
}

export function registerSubagent(pi: ExtensionAPI): SubagentRuntime {
  log.info("extension registered", { tool: "subagent" });
  let state = createState();
  let lastContext: ExtensionToolContext | undefined;
  const sessions = new Map<string, AgentSession>();
  const inflight = new Set<string>();
  const pending = new Map<string, (outcome: RunOutcome) => void>();
  const maxConcurrent = DEFAULT_MAX_CONCURRENT;

  const projectDir = (cwd: string): string => join(cwd, ".pi", "agents");
  const userDir = (): string => join(homedir(), ".pi", "agent", "agents");

  const loadProfiles = async (cwd: string) => {
    const dirs = [
      { path: projectDir(cwd), source: "project" as const },
      { path: userDir(), source: "user" as const },
    ];
    const sources: AgentSource[] = [...BUILTIN_AGENTS];
    for (const dir of dirs) {
      sources.push(...(await readAgentDir(dir.path, dir.source)));
    }
    return {
      profiles: discoverProfiles(sources),
      scannedDirs: dirs.map((dir) => dir.path),
    };
  };

  const refreshWidget = (): void => {
    const ctx = lastContext;
    if (!ctx) return;
    const lines = renderWidgetLines(state, Date.now());
    try {
      ctx.ui.setWidget(WIDGET_KEY, lines.length > 0 ? lines : undefined);
    } catch {
      // widget 在非交互宿主里可能不可用，不影响运行本身。
    }
  };

  const resolveWait = (runId: string, outcome: RunOutcome): void => {
    const resolve = pending.get(runId);
    if (!resolve) return;
    pending.delete(runId);
    resolve(outcome);
  };

  const outcomeOf = (
    runId: string,
    fallbackStatus: RunOutcome["status"],
  ): RunOutcome => {
    const run = findRun(state, runId);
    const status = run?.status;
    return {
      runId,
      agent: run?.agent ?? "unknown",
      status:
        status === "done" || status === "failed" || status === "stopped"
          ? status
          : fallbackStatus,
      text: run?.resultText ?? run?.error ?? "",
    };
  };

  const deliver = (runId: string): void => {
    const run = findRun(state, runId);
    if (!run) return;

    const outcome = outcomeOf(runId, "done");
    resolveWait(runId, outcome);
    emitEvent("settled", run);
    if (!run.background) return;

    const header =
      run.status === "done"
        ? `subagent ${run.agent} (${run.runId}) finished`
        : `subagent ${run.agent} (${run.runId}) ${run.status}`;
    const body = run.resultText ?? run.error ?? "(no output)";

    try {
      pi.sendMessage(
        {
          customType: "subagent:result",
          content: [{ type: "text", text: `${header}\n\n${body}` }],
          display: false,
          details: { runId: run.runId, agent: run.agent, status: run.status },
        },
        { triggerTurn: true },
      );
    } catch (error) {
      log.error("result delivery failed", {
        runId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const emitEvent = (
    event: "started" | "settled" | "steered",
    run: { runId: string; agent: string; status?: string } | undefined,
  ): void => {
    if (!run) return;
    try {
      pi.events.emit(
        RPC_EVENT_CHANNEL,
        buildRunEvent({
          event,
          runId: run.runId,
          agent: run.agent,
          status: run.status,
        }),
      );
    } catch (error) {
      log.warn("event emit failed", {
        event,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const applyRpcAction = (action: RpcAction): void => {
    if (action.kind === "run") {
      void runTask({
        agent: action.agent,
        task: action.task,
        background: action.background,
      }).catch((error: unknown) =>
        log.warn("rpc run rejected", {
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
      return;
    }
    if (action.kind === "stop") {
      stopRun(action.runId);
      return;
    }
    void steer(action.runId, action.text).catch(() => undefined);
  };

  const onRpcRequest = (raw: unknown): void => {
    const parsed = parseRpcRequest(raw);
    if (parsed.kind === "error") {
      log.debug("rpc rejected", { id: parsed.id, reason: parsed.error });
      if (parsed.id) {
        try {
          pi.events.emit(rpcReplyChannel(parsed.id), {
            version: 1,
            id: parsed.id,
            ok: false,
            error: parsed.error,
          });
        } catch {
          // 没有订阅者时 emit 失败不影响本会话。
        }
      }
      return;
    }

    const outcome = handleRpc(state, parsed.request);
    log.debug("rpc handled", {
      method: parsed.request.method,
      ok: outcome.reply.ok,
    });
    try {
      pi.events.emit(rpcReplyChannel(parsed.request.id), outcome.reply);
    } catch {
      // 同上。
    }
    if (outcome.action) applyRpcAction(outcome.action);
  };

  /**
   * 跟随父会话：codemode 看父会话有没有激活它，MCP 看父会话有没有连上服务器。
   * profile 的 `codemode:` / `mcp: none` 可以显式覆盖。
   */
  const resolveCapabilities = (profile: AgentProfile): ChildCapabilities => {
    const parentCodemode = readParentCodemode();
    const parentMcp = readParentMcp();
    return {
      // MCP 工具的默认 exposure 是 codemode，没有 codemode 就摸不到；父会话有 MCP
      // 时子会话也必须有 codemode，否则连上的服务器等于白连。
      codemode: profile.codemode ?? (parentCodemode || parentMcp),
      mcp: profile.mcp === "none" ? false : parentMcp,
    };
  };

  const readParentCodemode = (): boolean => {
    try {
      return pi.getActiveTools().includes("codemode");
    } catch {
      return false;
    }
  };

  const readParentMcp = (): boolean => {
    try {
      return pi.getAllTools().some((tool) => tool.name.startsWith("mcp__"));
    } catch {
      return false;
    }
  };

  const launch = async (runId: string): Promise<void> => {
    const run = findRun(state, runId);
    if (!run) return;

    const cwd = lastContext?.cwd ?? process.cwd();
    const { profiles } = await loadProfiles(cwd);
    const profile =
      findProfile(profiles, run.agent) ?? findProfile(profiles, "general");

    if (!profile) {
      log.error("profile missing at launch", { runId, agent: run.agent });
      state = settle(
        state,
        { runId, status: "failed", error: `unknown agent "${run.agent}"` },
        maxConcurrent,
        Date.now(),
      );
      refreshWidget();
      deliver(runId);
      return;
    }

    const capabilities = resolveCapabilities(profile);

    log.info("boot child", {
      runId,
      agent: profile.name,
      tools: profile.tools,
      model: profile.model ?? "(inherit)",
      thinking: profile.thinking ?? "(inherit)",
      codemode: capabilities.codemode,
      mcp: capabilities.mcp,
      cwd,
    });

    let session: AgentSession;
    try {
      const boot = await bootChildSession({
        profile,
        cwd,
        parentModel: lastContext?.model,
        parentThinking: lastContext?.thinkingLevel,
        capabilities,
        modelRegistry: lastContext?.modelRegistry,
      });
      session = boot.session;
      if (boot.modelWarning) {
        log.warn("model fallback", { runId, warning: boot.modelWarning });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log.error("boot failed", { runId, agent: profile.name, reason });
      state = settle(
        state,
        { runId, status: "failed", error: reason },
        maxConcurrent,
        Date.now(),
      );
      refreshWidget();
      deliver(runId);
      return;
    }

    sessions.set(runId, session);
    session.subscribe((event) => {
      const line = eventToTranscriptLine(
        event as {
          type: string;
          toolName?: string;
          message?: { role?: string; content?: unknown };
        },
        Date.now(),
      );
      if (!line) return;
      state = appendTranscript(state, runId, line);
      if (line.role === "tool") state = setStep(state, runId, line.text);
      refreshWidget();
    });

    try {
      await session.prompt(run.task);
      const text = lastAssistantText(session);
      log.debug("child settled", { runId, chars: text.length });
      state = settle(
        state,
        { runId, status: "done", resultText: text },
        maxConcurrent,
        Date.now(),
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log.error("child failed", { runId, agent: profile.name, reason });
      state = settle(
        state,
        { runId, status: "failed", error: reason },
        maxConcurrent,
        Date.now(),
      );
    } finally {
      sessions.delete(runId);
      disposeChild(session);
      refreshWidget();
      deliver(runId);
      pump();
    }
  };

  const pump = (): void => {
    for (const run of state.runs) {
      if (run.status !== "running" || inflight.has(run.runId)) continue;
      inflight.add(run.runId);
      void launch(run.runId).finally(() => {
        inflight.delete(run.runId);
      });
    }
  };

  const waitFor = (runId: string): Promise<RunOutcome> =>
    new Promise<RunOutcome>((resolve) => {
      const run = findRun(state, runId);
      if (run && isTerminal(run.status)) {
        resolve(outcomeOf(runId, "done"));
        return;
      }
      pending.set(runId, resolve);
    });

  const runTask = async (input: {
    agent?: string;
    task: string;
    background: boolean;
  }): Promise<RunOutcome> => {
    const cwd = lastContext?.cwd ?? process.cwd();
    const { profiles } = await loadProfiles(cwd);
    const name = input.agent?.trim() || "general";
    const profile = findProfile(profiles, name);

    if (!profile) {
      log.warn("unknown agent requested", { agent: name });
      throw new Error(
        `unknown agent "${name}". Available: ${profiles.map((p) => p.name).join(", ")}`,
      );
    }

    const runId = randomUUID().slice(0, 8);
    const admitted = admit(
      state,
      {
        runId,
        agent: profile.name,
        task: input.task,
        background: input.background,
      },
      maxConcurrent,
      Date.now(),
    );
    state = admitted.state;
    log.debug("admit", {
      runId,
      agent: profile.name,
      admitted: admitted.admitted,
      queued: admitted.queued,
    });
    refreshWidget();
    emitEvent("started", findRun(state, runId));
    pump();

    if (input.background) {
      return { runId, status: "done", agent: profile.name, text: "" };
    }
    return waitFor(runId);
  };

  const steer = async (runId: string, text: string): Promise<boolean> => {
    const run = findRun(state, runId);
    const session = sessions.get(runId);
    if (!run || !session || isTerminal(run.status)) {
      log.info("steer rejected", {
        runId,
        reason: run ? "no live session" : "unknown run",
      });
      return false;
    }
    log.info("steer delivered", { runId, chars: text.trim().length });
    emitEvent("steered", run);
    return steerChild(session, text);
  };

  const stopRun = (runId: string): void => {
    const session = sessions.get(runId);
    if (session) void session.abort().catch(() => undefined);
    state = stop(state, runId, maxConcurrent, Date.now());
    refreshWidget();
    pump();
  };

  const doctor = async (): Promise<string[]> => {
    const cwd = lastContext?.cwd ?? process.cwd();
    const { profiles, scannedDirs } = await loadProfiles(cwd);
    return renderDoctor({
      scannedDirs,
      profiles,
      maxConcurrent,
      hostKind: lastContext?.mode ?? "unknown",
      customPanels: lastContext?.hasUI ?? false,
      parentModel: lastContext?.model?.id ?? "",
      parentThinking: lastContext?.thinkingLevel ?? "",
      cwd,
      logLevel: resolveMinLogLevel(loadGlobalSettings().global, "subagent"),
      logConfigPath: getGlobalSettingsPath(),
    });
  };

  const describeRun = (runId: string): string => {
    const run = findRun(state, runId);
    if (!run) return `unknown run "${runId}"`;
    const tail = run.step ? ` · ${run.step}` : "";
    return `${run.runId} ${run.agent} ${run.status}${tail}`;
  };

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Delegate work to a focused child agent with its own isolated context.",
      "Use it when a task would flood this conversation with intermediate reads, or when an independent review is worth more than your own second look.",
      "Actions: run (default) starts an agent; list shows active runs; status shows one run; stop cancels one; doctor prints the resolved agent profiles and config.",
      "Children cannot see this conversation, so put the whole task in `task`.",
      "Background runs (default) return immediately and report back when finished.",
    ].join(" "),
    parameters: Type.Object({
      action: Type.Optional(
        Type.String({
          description: "run | list | status | stop | doctor (default: run)",
        }),
      ),
      agent: Type.Optional(
        Type.String({
          description:
            "Agent profile name: general (all tools), explore (read-only), reviewer (read-only). Default: general.",
        }),
      ),
      task: Type.Optional(
        Type.String({
          description: "Self-contained task for the child. Required for run.",
        }),
      ),
      background: Type.Optional(
        Type.Boolean({ description: "Run in the background. Default: true." }),
      ),
      runId: Type.Optional(
        Type.String({ description: "Run id, for status and stop." }),
      ),
    }),
    execute: async (
      _toolCallId,
      params,
      _signal,
      _onUpdate,
      ctx,
    ): Promise<AgentToolResult<StructuredPayload>> => {
      lastContext = ctx;
      const action = (params.action ?? "run").trim().toLowerCase();

      if (action === "doctor") {
        const lines = await doctor();
        return structuredResult(lines.join("\n"), { action, lines });
      }

      if (action === "list") {
        const live = activeRuns(state);
        const text =
          live.length === 0
            ? "no active subagent runs"
            : live.map((run) => describeRun(run.runId)).join("\n");
        return structuredResult(text, {
          action,
          runs: live.map((run) => ({
            runId: run.runId,
            agent: run.agent,
            status: run.status,
            step: run.step,
          })),
        });
      }

      if (action === "status") {
        const runId = params.runId?.trim();
        if (!runId) throw new Error("status requires runId");
        const run = findRun(state, runId);
        if (!run) throw new Error(`unknown run "${runId}"`);
        const text = [
          describeRun(runId),
          run.resultText ? `\nresult:\n${run.resultText}` : "",
          run.error ? `\nerror: ${run.error}` : "",
        ]
          .filter(Boolean)
          .join("\n");
        return structuredResult(text, {
          action,
          runId,
          agent: run.agent,
          status: run.status,
          resultText: run.resultText ?? null,
          error: run.error ?? null,
        });
      }

      if (action === "stop") {
        const runId = params.runId?.trim();
        if (!runId) throw new Error("stop requires runId");
        stopRun(runId);
        const run = findRun(state, runId);
        return structuredResult(
          `stopped ${runId} (${run?.status ?? "unknown"})`,
          {
            action,
            runId,
            status: run?.status ?? null,
          },
        );
      }

      if (action !== "run") {
        throw new Error(`unknown action "${action}"`);
      }

      const task = params.task?.trim();
      if (!task) throw new Error("run requires task");

      const outcome = await runTask({
        agent: params.agent,
        task,
        background: params.background ?? true,
      });

      if (outcome.status === "failed") {
        throw new Error(outcome.text || `subagent ${outcome.runId} failed`);
      }

      const text =
        outcome.text.trim() ||
        `subagent ${outcome.agent} (${outcome.runId}) started in the background`;

      return structuredResult(text, {
        action,
        runId: outcome.runId,
        agent: outcome.agent,
        status: outcome.status,
        resultText: outcome.text,
      });
    },
  });

  pi.on("session_start", () => {
    state = createState();
    sessions.clear();
    inflight.clear();
    pending.clear();
  });

  try {
    pi.events.on(RPC_REQUEST_CHANNEL, onRpcRequest);
  } catch (error) {
    log.warn("rpc subscription failed", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  const runtime: SubagentRuntime = {
    readState: () => state,
    refreshWidget,
    loadProfiles: async (cwd?: string) =>
      loadProfiles(cwd ?? lastContext?.cwd ?? process.cwd()),
    run: runTask,
    steer,
    stopRun,
    doctor,
    waitFor,
  };

  registerAgentsCommand(pi, runtime);

  return runtime;
}

export default function extension(pi: ExtensionAPI): void {
  registerSubagent(pi);
}
