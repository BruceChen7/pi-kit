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
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  PLAN_MODE_BADGE_CHANNEL,
  PLAN_MODE_STATUS_OWNER_CHANNEL,
} from "../shared/internal-events.ts";
import { createLogger, resolveMinLogLevel } from "../shared/logger.ts";
import { uiHostProfile } from "../shared/rich-ui.ts";
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
  collectWaitResult,
  createState,
  DEFAULT_MAX_CONCURRENT,
  eventToTranscriptLine,
  extractAssistantText,
  findRun,
  isTerminal,
  progressLine,
  type RunStatus,
  renderDoctor,
  renderWaitResult,
  renderWidgetLines,
  type SubagentState,
  selectWaitTargets,
  setStep,
  settle,
  statusLine,
  stop,
  type TerminalStatus,
  type Tone,
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
const STATUS_KEY = "subagent";
/** 进度刷新周期。1s 太吵，5s 又看不出在动；2s 是肉眼连续与重绘量的折中。 */
const TICK_MS = 2_000;
/** 与 herdr-squad 的 DEFAULT_WAIT_MS 对齐：两个等待工具不能有两个默认值。 */
const DEFAULT_WAIT_MS = 5 * 60_000;
const log = createLogger("subagent", { stderr: null });

type SubagentAction = "run" | "list" | "status" | "stop" | "doctor" | "wait";

const SUBAGENT_ACTIONS: readonly SubagentAction[] = [
  "run",
  "list",
  "status",
  "stop",
  "doctor",
  "wait",
];

/** 未知 action 直接报错，而不是静默落到 `run` 上把参数字典当任务跑。 */
const parseAction = (raw: string | undefined): SubagentAction => {
  const normalized = (raw ?? "run").trim().toLowerCase();
  const matched = SUBAGENT_ACTIONS.find((action) => action === normalized);
  if (!matched) throw new Error(`unknown action "${normalized}"`);
  return matched;
};

export type SettledOutcome = {
  kind: "settled";
  runId: string;
  agent: string;
  status: TerminalStatus;
  text: string;
};

/** `accepted` 只表示已受理（开跑或排队），不是终态；foreground 调用等到的永远是 `settled`。 */
export type RunOutcome =
  | { kind: "accepted"; runId: string; agent: string }
  | SettledOutcome;

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
  waitFor: (runId: string) => Promise<SettledOutcome>;
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
    const message = session.messages[i];
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
  /** 等待方只关心「有 run 终态了」，不关心是哪一条；醒来自己查 state。 */
  const settleWaiters = new Set<() => void>();
  /** 已经投递过终态的 runId，防止 launch 与 stop 两路各自 deliver 一次。 */
  const delivered = new Set<string>();
  /**
   * 已经有 `wait` 调用在盯的 runId。它们的终态结果会随 wait 的返回值送达，
   * 再发一次 `subagent:result` 只会多烧一轮 `triggerTurn`。
   */
  const awaited = new Set<string>();
  /** foreground 调用的 onUpdate：键是 runId，调用返回后立刻移除。 */
  const liveUpdates = new Map<string, AgentToolUpdateCallback>();
  let ticker: ReturnType<typeof setInterval> | undefined;
  /**
   * plan-mode 声明接管可见面后，本扩展只广播那段文字，不再写自己的 footer 段，
   * 否则同一个计数会在 widget 与 footer 上各出现一次。
   */
  let statusOwnedByPlanMode = false;
  /** refreshWidget 正在执行：期间收到的接管通知交给这次刷新收尾，避免同步回环。 */
  let refreshing = false;
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

  /**
   * 宿主 ctx 在会话结束后会 stale，读它的任何字段（cwd / mode / hasUI / ui）都会抛
   * `assertActive()`。所有异步路径都从这里取 ctx，读不到就当作「没有宿主 UI」。
   *
   * pi 没有暴露 staleness 查询，所以只能探一个字段把它收敛成 undefined。
   */
  const liveContext = (): ExtensionToolContext | undefined => {
    const ctx = lastContext;
    if (!ctx) return undefined;
    try {
      return ctx.cwd === undefined ? undefined : ctx;
    } catch {
      return undefined;
    }
  };

  const setFooterStatus = (text: string | undefined): void => {
    try {
      const ui = liveContext()?.ui as
        | { setStatus?: (key: string, text: string | undefined) => void }
        | undefined;
      if (typeof ui?.setStatus !== "function") return;
      ui.setStatus(STATUS_KEY, text);
    } catch {
      // 非交互宿主没有 footer，忽略。
    }
  };

  /**
   * 把这段文字广播给 plan-mode：它会把内容并进自己的 widget / 状态行。
   * 广播同步返回，plan-mode 可能在本调用内就翻转接管状态。
   */
  const publishBadge = (text: string | undefined): void => {
    const ctx = liveContext();
    try {
      pi.events.emit(PLAN_MODE_BADGE_CHANNEL, {
        type: "plan-mode.badge",
        cwd: ctx?.cwd ?? process.cwd(),
        key: STATUS_KEY,
        text: text ?? null,
        ctx,
      });
    } catch {
      // 没有订阅者不影响本会话。
    }
  };

  const stopTicker = (): void => {
    if (ticker !== undefined) {
      clearInterval(ticker);
      ticker = undefined;
    }
    setFooterStatus(undefined);
    publishBadge(undefined);
  };

  /** 一个 onUpdate 可能同时盯着多条 run，一次推送合成一行，别把工具行刷屏。 */
  const pushProgress = (now: number): void => {
    const byUpdate = new Map<AgentToolUpdateCallback, string[]>();
    for (const [runId, update] of liveUpdates) {
      const run = findRun(state, runId);
      const line = run ? progressLine(run, now) : undefined;
      if (!line) continue;
      const lines = byUpdate.get(update);
      if (lines) lines.push(line);
      else byUpdate.set(update, [line]);
    }
    for (const [update, lines] of byUpdate) {
      try {
        update({
          content: [{ type: "text", text: lines.join("  ·  ") }],
          details: { action: "run", progress: true },
        });
      } catch (error) {
        log.debug("progress update failed", {
          runs: lines.length,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  const tick = (): void => {
    const now = Date.now();
    if (activeRuns(state).length === 0) {
      stopTicker();
      return;
    }
    pushProgress(now);
    refreshWidget();
  };

  /** 有活跃 run 就保证 ticker 在跑，没有就停。重复调用无副作用。 */
  const syncTicker = (): void => {
    if (activeRuns(state).length === 0) {
      stopTicker();
      return;
    }
    if (ticker !== undefined) return;
    ticker = setInterval(tick, TICK_MS);
    (ticker as { unref?: () => void }).unref?.();
  };

  /**
   * pi-web 只展开一次：widget 挂载时必须是 2..3 行，超过就只剩一个 chip。
   * 上限从宿主档案来，TUI 没有这条限制（返回 undefined = 全列）。
   */
  const widgetRowLimit = (ctx: ExtensionToolContext): number | undefined => {
    const window = uiHostProfile(ctx).widgets.autoExpandedLines;
    return window ? Math.max(0, window.max - 1) : undefined;
  };

  /**
   * widget、badge 与 footer 状态总是同一时刻、同一份状态，避免三处各写一套。
   *
   * 顺序有讲究：先广播（plan-mode 可能同步接管），再按最新的接管标记决定自己的
   * footer 要不要让位。
   */
  const refreshWidget = (): void => {
    const ctx = liveContext();
    const now = Date.now();
    // widget 刷新是 best-effort：非交互宿主没有 widget，theme.fg 遇到未知 token
    // 会抛，stale ctx 同理。不能让它从 launch 的 finally 里逃出去。
    try {
      if (ctx) {
        const theme = ctx.ui.theme;
        const colorize = uiHostProfile(ctx).themeColors
          ? (tone: Tone, text: string) => theme.fg(tone, text)
          : undefined;
        const lines = renderWidgetLines(state, now, {
          maxRows: widgetRowLimit(ctx),
          colorize,
        });
        ctx.ui.setWidget(WIDGET_KEY, lines.length > 0 ? lines : undefined);
      }
    } catch {
      // 同上。
    }
    const status = statusLine(state, now);
    refreshing = true;
    try {
      publishBadge(status);
      setFooterStatus(statusOwnedByPlanMode ? undefined : status);
    } finally {
      refreshing = false;
    }
    syncTicker();
  };

  /** plan-mode 接管/释放可见面；翻转才重画，避免广播回环。 */
  const onStatusOwner = (payload: unknown): void => {
    if (typeof payload !== "object" || payload === null) return;
    const active = (payload as { active?: unknown }).active;
    if (typeof active !== "boolean" || active === statusOwnedByPlanMode) return;
    statusOwnedByPlanMode = active;
    if (refreshing) return;
    refreshWidget();
  };

  const notifySettled = (): void => {
    for (const wake of settleWaiters) wake();
  };

  /** 只对真正终态的 run 出结果；非终态返回 undefined，让调用方继续等。 */
  const settledOutcome = (runId: string): SettledOutcome | undefined => {
    const run = findRun(state, runId);
    if (!run || !isTerminal(run.status)) return undefined;
    return {
      kind: "settled",
      runId,
      agent: run.agent,
      status: run.status,
      text: run.resultText ?? run.error ?? "",
    };
  };

  /** 等待结束后的读法：run 还在就读终态，消失就按 stopped 收敛（会话重置）。 */
  const outcomeAfterWait = (runId: string): SettledOutcome =>
    settledOutcome(runId) ?? {
      kind: "settled",
      runId,
      agent: findRun(state, runId)?.agent ?? "unknown",
      status: "stopped",
      text: "",
    };

  /**
   * 等这些 run 全部终态或消失（会话重置会让 run 消失）。
   * 返回是否超时；abort 抛错，与 herdr-squad 的 wait 一致。
   * 超时与 abort 都在 cleanup 里摘掉唤醒器，不会留在 settleWaiters 里泄漏。
   */
  const waitUntilSettled = (
    runIds: readonly string[],
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<boolean> =>
    new Promise<boolean>((resolve, reject) => {
      const allSettled = (): boolean =>
        runIds.every((runId) => {
          const run = findRun(state, runId);
          return !run || isTerminal(run.status);
        });

      if (allSettled()) {
        resolve(false);
        return;
      }
      if (options.signal?.aborted) {
        reject(new Error("subagent wait cancelled"));
        return;
      }

      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => {
        settleWaiters.delete(wake);
        if (timer !== undefined) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
      };
      const wake = (): void => {
        if (!allSettled()) return;
        cleanup();
        resolve(false);
      };
      const onAbort = (): void => {
        cleanup();
        reject(new Error("subagent wait cancelled"));
      };

      settleWaiters.add(wake);
      if (options.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          cleanup();
          resolve(true);
        }, options.timeoutMs);
        (timer as { unref?: () => void }).unref?.();
      }
      options.signal?.addEventListener("abort", onAbort, { once: true });
    });

  const deliver = (runId: string): void => {
    if (delivered.has(runId)) return;
    const run = findRun(state, runId);
    const outcome = settledOutcome(runId);
    if (!run || !outcome) return;

    delivered.add(runId);
    notifySettled();
    emitEvent("settled", run);
    if (!run.background || awaited.has(runId)) return;

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
    run: { runId: string; agent: string; status?: RunStatus } | undefined,
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
    void steer(action.runId, action.text).catch((error: unknown) =>
      log.warn("rpc steer failed", {
        runId: action.runId,
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
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
  /**
   * codemode 跟随父会话；MCP 默认不给子会话，profile 写 `mcp: inherit` 才跟随。
   */
  const resolveCapabilities = (profile: AgentProfile): ChildCapabilities => {
    const parentCodemode = readParentCodemode();
    // 只有真要继承时才去读父会话的 mcp__ 工具。
    const mcp = profile.mcp === "inherit" && readParentMcp();
    return {
      // MCP 工具的默认 exposure 是 codemode，没有 codemode 就摸不到；子会话真的
      // 连了服务器才需要它，否则 codemode 只跟父会话自己的激活状态走。
      codemode: profile.codemode ?? (parentCodemode || mcp),
      mcp,
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

    const ctx = liveContext();
    const cwd = ctx?.cwd ?? process.cwd();
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
        parentModel: ctx?.model,
        parentThinking: ctx?.thinkingLevel,
        capabilities,
        modelRegistry: ctx?.modelRegistry,
        resolveProviderConfig: (provider) =>
          ctx?.modelRegistry?.getRegisteredProviderConfig?.(provider),
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
      const line = eventToTranscriptLine(event, Date.now());
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

  const waitFor = async (runId: string): Promise<SettledOutcome> => {
    await waitUntilSettled([runId]);
    return outcomeAfterWait(runId);
  };

  const runTask = async (input: {
    agent?: string;
    task: string;
    background: boolean;
    /** 拿到 runId 的时机早于 run 结束，foreground 调用靠它绑定 onUpdate。 */
    onRunId?: (runId: string) => void;
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
    input.onRunId?.(runId);
    log.debug("admit", {
      runId,
      agent: profile.name,
      outcome: admitted.outcome,
    });
    refreshWidget();
    emitEvent("started", findRun(state, runId));
    pump();

    if (input.background) {
      return { kind: "accepted", runId, agent: profile.name };
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
    deliver(runId);
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
      "Actions: run (default) starts an agent; wait blocks until background runs finish; list shows active runs; status shows one run; stop cancels one; doctor prints the resolved agent profiles and config.",
      "Children cannot see this conversation, so put the whole task in `task`.",
      "Background runs (default) return immediately and report back when finished.",
    ].join(" "),
    promptGuidelines: [
      'To wait for background runs, call subagent with action "wait". Never sleep or poll in bash to wait for a subagent; one wait call returns every requested result.',
    ],
    parameters: Type.Object({
      action: Type.Optional(
        Type.String({
          description:
            "run | wait | list | status | stop | doctor (default: run)",
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
      runIds: Type.Optional(
        Type.Array(Type.String(), {
          description: "Run ids for wait. Omit to wait for every active run.",
        }),
      ),
      timeoutMs: Type.Optional(
        Type.Number({
          description:
            "How long wait blocks before reporting partial progress. Default 300000.",
        }),
      ),
    }),
    execute: async (
      _toolCallId,
      params,
      signal,
      onUpdate,
      ctx,
    ): Promise<AgentToolResult<StructuredPayload>> => {
      lastContext = ctx;
      const action = parseAction(params.action);

      switch (action) {
        case "doctor": {
          const lines = await doctor();
          return structuredResult(lines.join("\n"), { action, lines });
        }

        case "list": {
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

        case "status": {
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

        case "wait": {
          const requested = params.runIds?.length ? params.runIds : undefined;
          const { targets, unknown } = selectWaitTargets(state, requested);
          if (unknown.length > 0) {
            throw new Error(
              `unknown run "${unknown.join('", "')}". Available: ${
                state.runs.map((run) => run.runId).join(", ") || "(none)"
              }`,
            );
          }

          const runIds = targets.map((run) => run.runId);
          if (runIds.length === 0) {
            return structuredResult("no subagent runs to wait for", {
              action,
              runs: [],
              timedOut: false,
            });
          }

          for (const runId of runIds) {
            awaited.add(runId);
            if (onUpdate) liveUpdates.set(runId, onUpdate);
          }
          let timedOut: boolean;
          try {
            timedOut = await waitUntilSettled(runIds, {
              timeoutMs: params.timeoutMs ?? DEFAULT_WAIT_MS,
              signal,
            });
          } finally {
            for (const runId of runIds) {
              liveUpdates.delete(runId);
              // 超时没等到终态的，交回后台投递；已终态的留着，避免重复触发。
              const run = findRun(state, runId);
              if (!run || !isTerminal(run.status)) awaited.delete(runId);
            }
          }

          const result = collectWaitResult(state, runIds, timedOut);
          return structuredResult(renderWaitResult(result), {
            action,
            runs: result.runs,
            timedOut,
          });
        }

        case "stop": {
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

        case "run": {
          const task = params.task?.trim();
          if (!task) throw new Error("run requires task");

          const background = params.background ?? true;
          let startedRunId: string | undefined;
          let outcome: RunOutcome;
          try {
            outcome = await runTask({
              agent: params.agent,
              task,
              background,
              onRunId: (runId) => {
                startedRunId = runId;
                if (onUpdate && !background) liveUpdates.set(runId, onUpdate);
              },
            });
          } finally {
            if (startedRunId) liveUpdates.delete(startedRunId);
          }

          if (outcome.kind === "settled" && outcome.status === "failed") {
            throw new Error(outcome.text || `subagent ${outcome.runId} failed`);
          }

          const text =
            outcome.kind === "settled"
              ? outcome.text.trim() ||
                `subagent ${outcome.agent} (${outcome.runId}) ${outcome.status}`
              : `subagent ${outcome.agent} (${outcome.runId}) started in the background`;

          return structuredResult(text, {
            action,
            runId: outcome.runId,
            agent: outcome.agent,
            status: outcome.kind === "settled" ? outcome.status : null,
            resultText: outcome.kind === "settled" ? outcome.text : "",
          });
        }

        default: {
          const unhandled: never = action;
          throw new Error(`unhandled action ${String(unhandled)}`);
        }
      }
    },
  });

  pi.on("session_start", () => {
    state = createState();
    stopTicker();
    liveUpdates.clear();
    delivered.clear();
    awaited.clear();
    sessions.clear();
    inflight.clear();
    // 放在重置 state 之后：等待方醒来会查到 run 已消失，按 stopped 收敛。
    notifySettled();
  });

  pi.on("session_shutdown", () => {
    stopTicker();
    liveUpdates.clear();
    // 会话没了，run 就是停了；先落成 stopped 再唤醒，等待方拿到的结论和以前一致。
    for (const run of activeRuns(state)) {
      state = stop(state, run.runId, maxConcurrent, Date.now());
    }
    notifySettled();
    // 之后的 ctx 已经 stale，读它的任何字段都会抛；widget 刷新直接跳过。
    lastContext = undefined;
  });

  try {
    pi.events.on(RPC_REQUEST_CHANNEL, onRpcRequest);
    pi.events.on(PLAN_MODE_STATUS_OWNER_CHANNEL, onStatusOwner);
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
