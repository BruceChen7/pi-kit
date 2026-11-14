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
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  AgentSession,
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  createPublisher,
  isFreshEvent,
  readEvent,
  type SeenEvent,
  seenAfter,
} from "../shared/event-protocol.ts";
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
  detachToBackground,
  eventToTranscriptLine,
  FOREGROUND_DETACH_MS,
  findRun,
  formatElapsed,
  isTerminal,
  progressLine,
  type RunStatus,
  recentTranscriptLines,
  renderDoctor,
  renderWaitResult,
  renderWidgetLines,
  type SubagentState,
  salvageFindings,
  selectWaitTargets,
  setStep,
  settle,
  statusLine,
  stop,
  type TerminalStatus,
  type Tone,
} from "./core.ts";
import {
  ledgerEntriesOf,
  RUN_LEDGER_ENTRY_TYPE,
  type RunLedgerEvent,
  renderUnsettled,
  toLedgerEntry,
  unsettledRuns,
} from "./ledger.ts";
import { observeRuns } from "./receipt.ts";
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
import {
  deriveSettlement,
  type SettlementMessage,
  textOfAssistantContent,
} from "./settlement.ts";
import { registerAgentsCommand } from "./ui.ts";

const WIDGET_KEY = "subagent";
const STATUS_KEY = "subagent";
/** 进度刷新周期。1s 太吵，5s 又看不出在动；2s 是肉眼连续与重绘量的折中。 */
const TICK_MS = 2_000;
/** `wait` 的默认上限：工具描述里的 timeoutMs 默认值写着 300000，两边同值。 */
const DEFAULT_WAIT_MS = 5 * 60_000;
const log = createLogger("subagent", { stderr: null });

/**
 * 主工具只管生命周期（起、看、停）。`wait` 单独成一个工具、只给模型直调；
 * `doctor` 退回 `/subagent doctor` 命令 —— 诊断跟"跑 agent"不是一回事
 * （ADR-0002 D2/D3）。
 */
type SubagentAction = "run" | "list" | "status" | "stop";

const SUBAGENT_ACTIONS: readonly SubagentAction[] = [
  "run",
  "list",
  "status",
  "stop",
];

/**
 * 未知 action 直接报错，而不是静默落到 `run` 上把参数字典当任务跑。
 * schema 已经用 StringEnum 约束过，这里只是调度层不信任输入的第二道。
 */
const parseAction = (raw: unknown): SubagentAction => {
  const normalized = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (normalized === "") return "run";
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

/**
 * 前台 run 跑满 `FOREGROUND_DETACH_MS` 还没结束：run 改走后台投递，
 * 主会话拿回控制权。tail 是最近几行 transcript，用来判断是继续等还是 stop。
 */
export type DetachedOutcome = {
  kind: "detached";
  runId: string;
  agent: string;
  elapsedMs: number;
  step: string | null;
  tail: string[];
};

/** `accepted` 只表示已受理（开跑或排队），不是终态；foreground 调用等到的可能是 `settled` 或 `detached`。 */
export type RunOutcome =
  | { kind: "accepted"; runId: string; agent: string }
  | SettledOutcome
  | DetachedOutcome;

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
  stopRun: (runId: string, options?: { notify?: boolean }) => string;
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

/** 交给结算判据的 transcript：只留判据要看的字段（纯数据，不带会话）。 */
function settlementMessages(session: AgentSession): SettlementMessage[] {
  const messages: SettlementMessage[] = [];
  for (const message of session.messages) {
    if (message.role === "assistant") {
      messages.push({
        role: "assistant",
        text: textOfAssistantContent(message.content),
      });
      continue;
    }
    if (message.role === "user") {
      messages.push({ role: "user", text: "" });
      continue;
    }
    if (message.role === "toolResult") {
      messages.push({ role: "tool", text: "" });
    }
  }
  return messages;
}

export function registerSubagent(pi: ExtensionAPI): SubagentRuntime {
  log.info("extension registered", { tool: "subagent" });
  let state = createState();
  let lastContext: ExtensionToolContext | undefined;
  /** 跨扩展事件的实例与序号：reload 后 instanceId 变化，序号不跨实例比较。 */
  const events = createPublisher(`subagent-${randomUUID()}`);
  /** plan-mode 广播的 status-owner 事件，只接受更新的序号。 */
  let seenStatusOwner: SeenEvent | undefined;
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
      pi.events.emit(
        PLAN_MODE_BADGE_CHANNEL,
        events.next({
          type: "plan-mode.badge",
          cwd: ctx?.cwd ?? process.cwd(),
          key: STATUS_KEY,
          text: text ?? null,
          ctx,
        }),
      );
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
  const onStatusOwner = (raw: unknown): void => {
    const event = readEvent<{ active?: unknown }>(raw);
    if (event === undefined) return;
    if (!isFreshEvent(seenStatusOwner, event)) return;
    seenStatusOwner = seenAfter(seenStatusOwner, event);
    const active = event.payload.active;
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
   * 返回是否超时；abort 抛错。
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

  /** 终态的广播：唤醒 waiter、发事件。同一个 run 只做一次。 */
  const publishSettled = (runId: string): boolean => {
    if (delivered.has(runId)) return false;
    const run = findRun(state, runId);
    if (!run || !isTerminal(run.status)) return false;

    delivered.add(runId);
    notifySettled();
    emitEvent("settled", run);
    return true;
  };

  /**
   * 后台 run 的正文送回主会话。
   * 父自己调 `stop` 时不走这条路：正文已经在 tool result 里，再发一条就是重复。
   */
  const sendResult = (runId: string): void => {
    const run = findRun(state, runId);
    const outcome = settledOutcome(runId);
    if (!run || !outcome) return;
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

  const deliver = (runId: string): void => {
    if (!publishSettled(runId)) return;
    sendResult(runId);
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

  /**
   * 恢复只到"重跑或放弃"：`SessionManager.inMemory` 意味着子会话内容随进程没了，
   * 假装续跑只会骗人。所以这里只把上次没结算的 run 报出来（ADR-0002 D4）。
   */
  const reportUnsettledRuns = (ctx: {
    hasUI?: boolean;
    ui?: {
      notify: (text: string, level?: "info" | "warning" | "error") => void;
    };
    sessionManager?: unknown;
  }): void => {
    let entries: readonly unknown[] = [];
    try {
      const manager = ctx.sessionManager as
        | { getBranch?: () => unknown[]; getEntries?: () => unknown[] }
        | undefined;
      entries =
        typeof manager?.getBranch === "function"
          ? manager.getBranch()
          : (manager?.getEntries?.() ?? []);
    } catch (error) {
      log.warn("run ledger unreadable", {
        reason: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const open = unsettledRuns(ledgerEntriesOf(entries));
    if (open.length === 0) return;

    const text = renderUnsettled(open);
    log.warn("unsettled runs from a previous session", {
      runIds: open.map((run) => run.runId),
    });
    if (ctx.hasUI) ctx.ui?.notify(text, "warning");
  };

  /**
   * 往父会话记录里写一条 run 账本。崩了也不该影响跑 agent，所以写失败只记日志。
   */
  const recordRun = (
    runId: string,
    event: RunLedgerEvent,
    extra: { resultChars?: number } = {},
  ): void => {
    const run = findRun(state, runId);
    if (!run) return;
    try {
      pi.appendEntry(
        RUN_LEDGER_ENTRY_TYPE,
        toLedgerEntry({
          runId,
          event,
          agent: run.agent,
          task: run.task,
          at: Date.now(),
          ...extra,
        }),
      );
    } catch (error) {
      log.warn("run ledger append failed", {
        runId,
        event,
        reason: error instanceof Error ? error.message : String(error),
      });
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
      recordRun(runId, "failed");
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
      recordRun(runId, "failed");
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
      const settlement = deriveSettlement({
        messages: settlementMessages(session),
        // 今天子会话拿不到 subagent 工具，欠项恒为空；规则先到，见 ADR-0002 D1。
        obligations: [],
      });
      log.debug("child settled", {
        runId,
        chars: settlement.text.length,
        status: settlement.status,
      });
      state = settle(
        state,
        {
          runId,
          status:
            settlement.status === "intermediate" ? "intermediate" : "done",
          resultText: settlement.text,
        },
        maxConcurrent,
        Date.now(),
      );
      recordRun(
        runId,
        settlement.status === "intermediate" ? "intermediate" : "settled",
        { resultChars: settlement.text.length },
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
      recordRun(runId, "failed");
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
    recordRun(runId, "start");
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

    // 前台不是「等到死」：跑满 FOREGROUND_DETACH_MS 就转后台，把控制权交回主会话。
    // 子会话不中断，settle 时走 deliver() → sendMessage({triggerTurn:true})。
    const timedOut = await waitUntilSettled([runId], {
      timeoutMs: FOREGROUND_DETACH_MS,
    });
    if (!timedOut) return outcomeAfterWait(runId);

    // 超时这一拍 run 可能刚 settle：先复查。终态就按正常结论返回，
    // 否则标了 background 的那条结果会被 deliver 再投递一次。
    const live = findRun(state, runId);
    if (!live || isTerminal(live.status)) return outcomeAfterWait(runId);

    state = detachToBackground(state, runId);
    refreshWidget();
    const elapsedMs = Date.now() - live.startedAt;
    const tail = recentTranscriptLines(live);
    lastContext?.ui.notify?.(
      `subagent ${profile.name} (${runId}) 已跑 ${formatElapsed(elapsedMs)}，已转后台；结果会作为消息送达。`,
      "info",
    );
    log.info("foreground run detached", { runId, elapsedMs });
    return {
      kind: "detached",
      runId,
      agent: profile.name,
      elapsedMs,
      step: live.step,
      tail,
    };
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

  /**
   * 停掉一个 run，并把子会话里已经攒下的现场打捞出来交回主会话。
   *
   * 打捞必须在 abort 之前：abort 之后 messages 虽然还在，但最后一步工具已经断了，
   * 从这里读更接近它停下时的真实状态。`notify: false` 给父级自己调 stop 的场景用——
   * 正文直接进 tool result，不再另发一条 `subagent:result` 消息。
   */
  const stopRun = (
    runId: string,
    options: { notify?: boolean } = {},
  ): string => {
    const run = findRun(state, runId);
    if (!run) return "";

    if (isTerminal(run.status)) {
      // 已经收敛的 run 只补一次广播；结果保持它自己那份，别用打捞覆盖。
      if (publishSettled(runId) && options.notify !== false) sendResult(runId);
      return run.resultText ?? "";
    }

    const session = sessions.get(runId);
    const findings = session
      ? salvageFindings({
          messages: session.messages,
          elapsedMs: Date.now() - run.startedAt,
          step: run.step,
        })
      : "";

    if (session) void session.abort().catch(() => undefined);
    recordRun(runId, "stopped");
    state = stop(state, runId, maxConcurrent, Date.now(), findings);
    refreshWidget();
    if (publishSettled(runId) && options.notify !== false) sendResult(runId);
    pump();
    return findings;
  };

  /**
   * 诊断只读这几个字段，工具上下文和命令上下文都满足它们 —— 所以不共用
   * `lastContext` 的类型，改成显式传进来。
   */
  type DoctorContext = {
    cwd: string;
    mode?: string;
    hasUI?: boolean;
    model?: { id?: string };
    thinkingLevel?: string;
  };

  const doctor = async (
    ctx: DoctorContext | undefined = lastContext,
  ): Promise<string[]> => {
    const cwd = ctx?.cwd ?? process.cwd();
    const { profiles, scannedDirs } = await loadProfiles(cwd);
    return renderDoctor({
      scannedDirs,
      profiles,
      maxConcurrent,
      hostKind: ctx?.mode ?? "unknown",
      customPanels: ctx?.hasUI ?? false,
      parentModel: ctx?.model?.id ?? "",
      parentThinking: ctx?.thinkingLevel ?? "",
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

  /**
   * `wait` 的实现：只被 subagent_wait 使用。返回值是结构化结果，
   * 不在这里做 UI —— 等待期间靠 onUpdate 推进度。
   */
  const waitForRuns = async (
    params: { runIds?: string[]; timeoutMs?: number },
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<StructuredPayload> | undefined,
  ): Promise<AgentToolResult<StructuredPayload>> => {
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
        action: "wait",
        runs: [],
        timedOut: false,
        receipt: observeRuns([]),
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

    const result = collectWaitResult(state, runIds, timedOut, Date.now());
    return structuredResult(renderWaitResult(result), {
      action: "wait",
      runs: result.runs,
      timedOut,
      receipt: observeRuns(
        runIds.flatMap((runId) => {
          const run = findRun(state, runId);
          return run === undefined ? [] : [run];
        }),
      ),
    });
  };

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Delegate work to a focused child agent with its own isolated context.",
      "Use it when a task would flood this conversation with intermediate reads, or when an independent review is worth more than your own second look.",
      "Actions: run (default) starts an agent; list shows active runs; status shows one run; stop cancels one and hands back what the child had already found (its last words, tool trail, files touched).",
      "To block until runs finish, call the separate subagent_wait tool; it is model-only on purpose, because a script's return value is not evidence that the model received the result. `/subagent doctor` prints the resolved profiles and config.",
      "Children cannot see this conversation, so put the whole task in `task`.",
      "Background runs (default) return immediately and report back when finished.",
      `A foreground run (background:false) holds this session until the child settles or ${FOREGROUND_DETACH_MS / 60_000} minutes pass; after that it is moved to the background and its result arrives as a message. Use foreground only for a task that finishes in a couple of minutes.`,
      "Give the child a budget in `task`: which files to read, what to produce, and how long the answer should be. An unbounded task is what turns a 5-minute delegation into a 45-minute one.",
    ].join(" "),
    promptGuidelines: [
      'To wait for background runs, call subagent with action "wait". Never sleep or poll in bash to wait for a subagent; one wait call returns every requested result.',
      'A wait that times out means the child is slow, not that it finished. Report the elapsed time, do other work or end the turn, and wait again only when you have nothing else to do; use action "status" or "stop" on a run that shows `quiet`.',
    ],
    parameters: Type.Object({
      action: Type.Optional(
        StringEnum(SUBAGENT_ACTIONS, {
          description: "run (default) | list | status | stop",
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
      _signal,
      onUpdate,
      ctx,
    ): Promise<AgentToolResult<StructuredPayload>> => {
      lastContext = ctx;
      const action = parseAction(params.action);

      switch (action) {
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
            receipt: observeRuns(live),
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
            receipt: observeRuns([run]),
          });
        }

        case "stop": {
          const runId = params.runId?.trim();
          if (!runId) throw new Error("stop requires runId");
          const findings = stopRun(runId, { notify: false });
          const run = findRun(state, runId);
          const head = `stopped ${runId} (${run?.status ?? "unknown"})`;
          return structuredResult(findings ? `${head}\n\n${findings}` : head, {
            action,
            runId,
            status: run?.status ?? null,
            findings,
            receipt: observeRuns(run === undefined ? [] : [run]),
          });
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

          if (outcome.kind === "detached") {
            const head =
              `subagent ${outcome.agent} (${outcome.runId}) still running after ` +
              `${formatElapsed(outcome.elapsedMs)} (last: ${outcome.step ?? "no tool yet"}).`;
            const activity =
              outcome.tail.length > 0
                ? `\n\nRecent activity:\n${outcome.tail.join("\n")}`
                : "";
            const advice =
              `\n\nMoved to the background; the result will arrive as a message. ` +
              `Do not re-run the same task — use action "status" or "wait" on ${outcome.runId}.`;
            return structuredResult(`${head}${activity}${advice}`, {
              action,
              runId: outcome.runId,
              agent: outcome.agent,
              status: null,
              detached: true,
              elapsedMs: outcome.elapsedMs,
              step: outcome.step,
              tail: outcome.tail,
              resultText: "",
              receipt: observeRuns(
                [findRun(state, outcome.runId)].flatMap((run) =>
                  run === undefined ? [] : [run],
                ),
              ),
            });
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
            receipt: observeRuns(
              [findRun(state, outcome.runId)].flatMap((run) =>
                run === undefined ? [] : [run],
              ),
            ),
          });
        }

        default: {
          const unhandled: never = action;
          throw new Error(`unhandled action ${String(unhandled)}`);
        }
      }
    },
  });

  /**
   * `wait` 是唯一的阻塞入口，并且只给模型直调（`exposure: "model-only"`）。
   *
   * 为什么不让脚本调：脚本可以丢弃、截断，或在抛错前吞掉返回值 —— 那样
   * "模型收到了结果"就没有证据了。发起/查询/停止仍然可以脚本编排，
   * 因为它们不依赖证据（ADR-0002 D2）。
   */
  pi.registerTool({
    name: "subagent_wait",
    label: "Wait for subagents",
    description:
      "Block this turn until the given subagent runs settle (or the timeout passes), and return their results. " +
      "Omit runIds to wait for every active run. Background runs whose results already arrived are not affected. " +
      "Call it directly, not from a codemode script.",
    exposure: "model-only",
    parameters: Type.Object({
      runIds: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Run ids to wait for. Omit to wait for every active run.",
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
      return await waitForRuns(params, signal, onUpdate);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    // 上一个会话里没结算的 run：子会话内容已经没了，只能在这里说出来让人决定。
    reportUnsettledRuns(ctx);
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

  /**
   * `/subagent doctor`：诊断从工具面移出后，这是它唯一的入口。
   * 人看得见，模型不会为了"跑个 agent"顺手调到它。
   */
  pi.registerCommand("subagent", {
    description:
      "Print resolved agent profiles and config (usage: /subagent doctor)",
    handler: async (args: string, ctx) => {
      const subcommand = args.trim().toLowerCase();
      if (subcommand !== "" && subcommand !== "doctor") {
        ctx.ui.notify("usage: /subagent doctor", "warning");
        return;
      }
      const lines = await doctor(ctx);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  registerAgentsCommand(pi, runtime);

  return runtime;
}

export default function extension(pi: ExtensionAPI): void {
  registerSubagent(pi);
}
