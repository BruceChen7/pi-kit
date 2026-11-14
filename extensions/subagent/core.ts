/**
 * subagent 运行状态机（Functional Core）。
 *
 * 所有函数都是 value in / value out：接 `SubagentState`，返回新的 `SubagentState`。
 * 没有 session、没有 timer、没有 IO —— 时间由调用方作为 `now` 传入。
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import type { AgentProfile } from "./agents.ts";

export type RunStatus =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "stopped"
  /**
   * 它还有结果没等到就先给了答案（"我去查一下"）。这是终态 —— 这一轮结束了 ——
   * 但那句答案不是结果，所以不交付（ADR-0002 D1）。
   */
  | "intermediate";

export type TerminalStatus = "done" | "failed" | "stopped" | "intermediate";

export type TranscriptRole = "user" | "assistant" | "tool";

export type TranscriptLine = {
  role: TranscriptRole;
  text: string;
  at: number;
};

export type SubagentRun = {
  runId: string;
  agent: string;
  task: string;
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  /** 最近一次工具名，给 widget 用。 */
  step: string | null;
  /** 最近一次子会话事件的时间；`progressLine` 用它区分「在跑」和「静默」。 */
  lastEventAt: number;
  transcript: TranscriptLine[];
  resultText?: string;
  error?: string;
  background: boolean;
};

export type SubagentState = {
  runs: SubagentRun[];
};

/** widget 只用这三个 tone：accent 强调、muted 弱化、dim 最弱。 */
export type Tone = "accent" | "muted" | "dim";
export type Colorize = (tone: Tone, text: string) => string;

export type WidgetOptions = {
  /** 宿主能自动展开的行数上限（不含 header）。不传 = 全列。 */
  maxRows?: number;
  /** 宿主不认颜色时别传，输出保持纯文本。 */
  colorize?: Colorize;
};

export type AdmitRequest = {
  runId: string;
  agent: string;
  task: string;
  background: boolean;
};

export type SettleInput = {
  runId: string;
  status: "done" | "failed" | "intermediate";
  resultText?: string;
  error?: string;
};

export type DoctorInput = {
  scannedDirs: string[];
  profiles: readonly AgentProfile[];
  maxConcurrent: number;
  hostKind: string;
  customPanels: boolean;
  parentModel: string;
  parentThinking: string;
  cwd: string;
  /** 当前生效的日志级别与它的来源文件，用来解释"为什么没有日志"。 */
  logLevel?: string;
  logConfigPath?: string;
};

/** `wait` 要等谁：目标 run 与调用方给错的 id 分开返回，让 Shell 决定抛不抛。 */
export type WaitTargets = {
  targets: SubagentRun[];
  unknown: string[];
};

export type WaitedRun = {
  runId: string;
  agent: string;
  status: RunStatus;
  text: string;
  /** 非终态 run 的实时进度（elapsed / step / quiet）；终态为 undefined。 */
  progress?: string;
};

export type WaitResult = {
  runs: WaitedRun[];
  timedOut: boolean;
};

export const DEFAULT_MAX_CONCURRENT = 4;
export const MAX_RESULT_CHARS = 8000;
export const MAX_TRANSCRIPT_LINES = 40;
/**
 * 前台 `run` 最多占用主会话这么久，到点转后台。
 *
 * 实测（2026-11-02）：一次只读调查的前台 run 跑了 23.5 分钟，另一次 45.6 分钟，
 * 期间用户以为 agent 卡死。转后台保住子会话的成果，同时把控制权交回主会话。
 */
export const FOREGROUND_DETACH_MS = 10 * 60_000;

const TERMINAL: readonly RunStatus[] = [
  "done",
  "failed",
  "stopped",
  "intermediate",
];

export const isTerminal = (status: RunStatus): status is TerminalStatus =>
  TERMINAL.includes(status);

export const createState = (): SubagentState => ({ runs: [] });

export const findRun = (
  state: SubagentState,
  runId: string,
): SubagentRun | undefined => state.runs.find((run) => run.runId === runId);

export const activeRuns = (state: SubagentState): SubagentRun[] =>
  state.runs.filter((run) => !isTerminal(run.status));

/**
 * 显式 runIds 按给定顺序去重；不给就取所有非终态 run。
 * 未知 id 单独返回 —— 纯函数不抛，抛不抛是 Shell 的调用方契约。
 */
export function selectWaitTargets(
  state: SubagentState,
  runIds?: readonly string[],
): WaitTargets {
  if (runIds === undefined) return { targets: activeRuns(state), unknown: [] };

  const targets: SubagentRun[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();
  for (const raw of runIds) {
    const runId = raw.trim();
    if (!runId || seen.has(runId)) continue;
    seen.add(runId);
    const run = findRun(state, runId);
    if (run) targets.push(run);
    else unknown.push(runId);
  }
  return { targets, unknown };
}

/**
 * 按 id 从当前 state 读结论。超时时非终态条目的 status 原样保留，text 为空。
 * 会话重置会让 run 消失，这类 id 读成 stopped，与等待方拿到的结论一致。
 */
export function collectWaitResult(
  state: SubagentState,
  runIds: readonly string[],
  timedOut: boolean,
  now: number = Date.now(),
): WaitResult {
  const runs = runIds.map((runId): WaitedRun => {
    const run = findRun(state, runId);
    if (!run) return { runId, agent: "unknown", status: "stopped", text: "" };
    return {
      runId: run.runId,
      agent: run.agent,
      status: run.status,
      // intermediate 的正文是"我还没做完"，不能当结果交给调用方。
      text:
        run.status === "intermediate"
          ? ""
          : (run.resultText ?? run.error ?? ""),
      progress: progressLine(run, now),
    };
  });
  return { runs, timedOut };
}

/** 超时必须写清楚没等完，否则调用方会把部分结果读成全部完成。 */
export function renderWaitResult(result: WaitResult): string {
  if (result.runs.length === 0) return "no subagent runs to wait for";

  const lines = result.runs.map((run) => {
    // 非终态行直接用进度行（agent · runId · running 12m · step · quiet 38s）：
    // 超时结果只有 status 一个词时，调用方看不出「在跑」还是「卡住」。
    const head = run.progress ?? `${run.runId} ${run.agent} ${run.status}`;
    return run.text ? `${head}\n${run.text}` : head;
  });
  const intermediate = result.runs.filter(
    (run) => run.status === "intermediate",
  );
  const intermediateNote =
    intermediate.length === 0
      ? []
      : [
          "",
          `${intermediate.length} run(s) stopped with an intermediate answer; ` +
            "that text is not a result. Re-run or steer the agent if you need one: " +
            intermediate.map((run) => run.runId).join(", "),
        ];

  if (!result.timedOut) {
    return [...lines, ...intermediateNote].join("\n\n");
  }

  const settled = result.runs.filter((run) => isTerminal(run.status)).length;
  const running = result.runs.length - settled;
  return [
    `timed out with ${settled}/${result.runs.length} settled; ${running} still running`,
    "",
    ...lines,
    ...intermediateNote,
    "",
    "Still-running agents keep going in the background. Do other work or end the turn; " +
      "wait again only when you have nothing else to do, and use `status`/`stop` on a run that shows `quiet`.",
  ].join("\n");
}

const countRunning = (state: SubagentState): number =>
  state.runs.filter((run) => run.status === "running").length;

/** 按插入顺序把 queued 提升为 running，直到占满并发。 */
function promote(state: SubagentState, maxConcurrent: number): SubagentState {
  let capacity = maxConcurrent - countRunning(state);
  if (capacity <= 0) return state;

  const runs = state.runs.map((run): SubagentRun => {
    if (capacity > 0 && run.status === "queued") {
      capacity -= 1;
      return { ...run, status: "running" };
    }
    return run;
  });

  return { runs };
}

export function admit(
  state: SubagentState,
  request: AdmitRequest,
  maxConcurrent: number = DEFAULT_MAX_CONCURRENT,
  now: number = Date.now(),
): { state: SubagentState; outcome: "running" | "queued" } {
  const run: SubagentRun = {
    runId: request.runId,
    agent: request.agent,
    task: request.task,
    status: "queued",
    startedAt: now,
    step: null,
    lastEventAt: now,
    transcript: [],
    background: request.background,
  };

  const next = promote({ runs: [...state.runs, run] }, maxConcurrent);
  const admitted = findRun(next, request.runId);

  return {
    state: next,
    outcome: admitted?.status === "running" ? "running" : "queued",
  };
}

export function start(
  state: SubagentState,
  runId: string,
  now: number = Date.now(),
): SubagentState {
  return {
    runs: state.runs.map((run) =>
      run.runId === runId && run.status === "queued"
        ? { ...run, status: "running", startedAt: now }
        : run,
    ),
  };
}

export function setStep(
  state: SubagentState,
  runId: string,
  step: string | null,
  now: number = Date.now(),
): SubagentState {
  return {
    runs: state.runs.map((run) =>
      run.runId === runId ? { ...run, step, lastEventAt: now } : run,
    ),
  };
}

/**
 * 前台 run 到点转后台：主会话不再等它，settle 时走已有的后台投递路径。
 *
 * 终态 run 原样返回。调用方在超时后要先复查终态——先 settle 的 run
 * 结果已经在返回值里，不能再标成后台，否则那条结果会丢。
 */
export function detachToBackground(
  state: SubagentState,
  runId: string,
): SubagentState {
  return {
    runs: state.runs.map((run) =>
      run.runId === runId && !isTerminal(run.status)
        ? { ...run, background: true }
        : run,
    ),
  };
}

/** detached 结果里的现场：最近 N 行 transcript，每行截到一个屏幕宽。 */
export function recentTranscriptLines(
  run: SubagentRun,
  count = 3,
  width = 120,
): string[] {
  return run.transcript.slice(-count).map((line) => {
    const prefix = `[${line.role}] `;
    const budget = Math.max(0, width - prefix.length);
    const text =
      line.text.length > budget
        ? `${line.text.slice(0, Math.max(0, budget - 1))}…`
        : line.text;
    return `${prefix}${text}`;
  });
}

export function appendTranscript(
  state: SubagentState,
  runId: string,
  line: TranscriptLine,
): SubagentState {
  return {
    runs: state.runs.map((run) => {
      if (run.runId !== runId) return run;
      const transcript = [...run.transcript, line].slice(-MAX_TRANSCRIPT_LINES);
      return { ...run, transcript, lastEventAt: line.at };
    }),
  };
}

/**
 * 收敛到一个终态。对同一 runId 重复调用是幂等的：
 * 已经终态的 run 不会被覆盖，`endedAt` 也不会被改写。
 */
export function settle(
  state: SubagentState,
  input: SettleInput,
  maxConcurrent: number = DEFAULT_MAX_CONCURRENT,
  now: number = Date.now(),
): SubagentState {
  const target = findRun(state, input.runId);
  if (!target || isTerminal(target.status)) return state;

  const settled: SubagentState = {
    runs: state.runs.map((run) => {
      if (run.runId !== input.runId) return run;
      return {
        ...run,
        status: input.status,
        endedAt: now,
        step: null,
        resultText:
          input.resultText === undefined
            ? run.resultText
            : clipResult(input.resultText),
        error: input.error,
      };
    }),
  };

  return promote(settled, maxConcurrent);
}

/**
 * 停掉一个 run，并把打捞到的现场（`findings`）留在 `resultText` 上。
 *
 * 停掉的 run 以前只有 `(no output)`，主会话拿不到子会话 29 分钟里看到的任何东西。
 * findings 由 Shell 在 abort 之前从子会话里打捞（`salvageFindings`），这里只负责
 * 落地：终态的 run 不会被覆盖，重复调用幂等。
 */
export function stop(
  state: SubagentState,
  runId: string,
  maxConcurrent: number = DEFAULT_MAX_CONCURRENT,
  now: number = Date.now(),
  findings = "",
): SubagentState {
  const target = findRun(state, runId);
  if (!target || isTerminal(target.status)) return state;

  const stopped: SubagentState = {
    runs: state.runs.map((run) =>
      run.runId === runId
        ? {
            ...run,
            status: "stopped",
            endedAt: now,
            step: null,
            resultText: findings ? clipResult(findings) : run.resultText,
          }
        : run,
    ),
  };

  return promote(stopped, maxConcurrent);
}

export function clipResult(
  text: string,
  limit: number = MAX_RESULT_CHARS,
): string {
  if (text.length <= limit) return text;
  const dropped = text.length - limit;
  return `${text.slice(0, limit)}\n\n[truncated ${dropped} chars]`;
}

export const formatElapsed = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
};

const STATUS_GLYPH: Record<RunStatus, string> = {
  queued: "·",
  running: "▸",
  done: "✓",
  failed: "✗",
  stopped: "■",
  // 半成品：有答案但不是结果
  intermediate: "…",
};

/** 静默多久之后开始在进度行里标注 `quiet`。 */
export const QUIET_AFTER_MS = 30_000;

/** 距上一次子会话事件过了多久。静默判定只在这里算一次。 */
const quietMsFor = (run: SubagentRun, now: number): number =>
  Math.max(0, now - run.lastEventAt);

/**
 * 一行运行期进度：`explore a1b2c3d4 · running 4m10s · grep subagent · quiet 38s`。
 * 终态返回 undefined，调用方据此撤掉进度展示。
 */
export function progressLine(
  run: SubagentRun,
  now: number = Date.now(),
): string | undefined {
  if (isTerminal(run.status)) return undefined;

  const elapsed = formatElapsed((run.endedAt ?? now) - run.startedAt);
  const head = `${run.agent} ${run.runId} · ${run.status} ${elapsed}`;
  if (run.status === "queued") return `${head} · waiting for slot`;

  const step = run.step ? ` · ${run.step}` : " · no tool yet";
  const quietMs = quietMsFor(run, now);
  const quiet =
    quietMs >= QUIET_AFTER_MS ? ` · quiet ${formatElapsed(quietMs)}` : "";
  return `${head}${step}${quiet}`;
}

/** footer 状态行：单个 run 用它的进度行，多个 run 只报数量。 */
export function statusLine(
  state: SubagentState,
  now: number = Date.now(),
): string | undefined {
  const live = activeRuns(state);
  if (live.length === 0) return undefined;

  if (live.length === 1) {
    const run = live[0];
    const elapsed = formatElapsed((run.endedAt ?? now) - run.startedAt);
    return `subagent ${run.agent} ${elapsed}`;
  }

  const running = live.filter((run) => run.status === "running").length;
  return `subagent ${running} running, ${live.length - running} queued`;
}

/**
 * widget 单行预算（显示列）。字符串数组拿不到终端宽度，按 80 列终端减两侧
 * 内边距再留 2 列余量算；超了 TUI 会换行，把 widget 顶高。
 */
export const WIDGET_LINE_BUDGET = 76;

const WIDGET_GAP = 2;

/** 右列最多占的列数。MCP 工具名可能很长，不设上限会把整行顶出预算。 */
const WIDGET_RIGHT_MAX = 40;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * 按显示列截断。不用 pi-tui 的 truncateToWidth：那个连纯文本也会插 ANSI reset，
 * 无色宿主会看到转义码。按 grapheme 累加，否则 `⚠️` 这种序列会被当成 1 列。
 */
export function truncateToColumns(
  text: string,
  maxCols: number,
  ellipsis = "…",
): string {
  if (maxCols <= 0) return "";
  if (visibleWidth(text) <= maxCols) return text;

  const ellipsisWidth = visibleWidth(ellipsis);
  if (ellipsisWidth >= maxCols)
    return ellipsisWidth === maxCols ? ellipsis : "";

  const budget = maxCols - ellipsisWidth;
  let kept = "";
  let used = 0;
  for (const { segment } of graphemes.segment(text)) {
    const width = visibleWidth(segment);
    if (used + width > budget) break;
    kept += segment;
    used += width;
  }
  return `${kept}${ellipsis}`;
}

/** 任务摘要：第一条非空行，压掉行内多余空白。 */
export function summarizeTask(task: string): string {
  const line = task
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return (line ?? "").replace(/\s+/g, " ");
}

/** 右列：排队只报排队；静默时报静默，不报已经过期的工具名。 */
function widgetRight(run: SubagentRun, now: number): string {
  const elapsed = formatElapsed((run.endedAt ?? now) - run.startedAt);
  const quietMs = quietMsFor(run, now);
  const text =
    run.status === "queued"
      ? `queued ${elapsed}`
      : quietMs >= QUIET_AFTER_MS
        ? `${elapsed}  quiet ${formatElapsed(quietMs)}`
        : `${elapsed}  ${run.step ?? "no tool yet"}`;
  return truncateToColumns(text, WIDGET_RIGHT_MAX);
}

/** 左列：`  ▸ explore a1b2c3d4  找 widget 渲染路径`。agent 名太长时先截名字，颜色照旧。 */
function widgetLeft(
  run: SubagentRun,
  maxCols: number,
  colorize?: Colorize,
): string {
  const glyph = STATUS_GLYPH[run.status];
  // 缩进 + glyph + 两个空格 + runId + 段间空格，剩下的才是 agent 名的额度。
  const fixed = 2 + 1 + 1 + 1 + run.runId.length + WIDGET_GAP;
  const agent = truncateToColumns(run.agent, Math.max(1, maxCols - fixed));
  const head = colorize
    ? `  ${colorize(run.status === "queued" ? "muted" : "accent", glyph)} ${colorize("accent", agent)} ${run.runId}`
    : `  ${glyph} ${agent} ${run.runId}`;

  const task = summarizeTask(run.task);
  const budget = maxCols - visibleWidth(head) - WIDGET_GAP;
  if (!task || budget <= 0) return head;
  return `${head}  ${truncateToColumns(task, budget)}`;
}

/**
 * widget 行。没有任何活跃 run 时返回空数组，让宿主把 widget 撤掉。
 *
 * `maxRows` 是宿主能自动展开的行数上限（不含 header）：pi-web 只在 widget
 * 由空变非空那一刻展开 2..3 行的 widget，超过就永远只剩一个 chip。不传
 * （TUI）就全列。右列贴到 `WIDGET_LINE_BUDGET`，所以多行时左列长短不影响对齐。
 */
export function renderWidgetLines(
  state: SubagentState,
  now: number = Date.now(),
  options: WidgetOptions = {},
): string[] {
  const live = activeRuns(state);
  if (live.length === 0) return [];

  const running = live.filter((run) => run.status === "running").length;
  const shown =
    options.maxRows === undefined
      ? live
      : live.slice(0, Math.max(0, options.maxRows));
  const hidden = live.length - shown.length;
  const more = hidden > 0 ? ` · +${hidden} more` : "";
  const header = `Subagents · ${running} running, ${live.length - running} queued${more}`;
  if (shown.length === 0) return [header];

  const rights = shown.map((run) => widgetRight(run, now));
  const rightMax = Math.max(...rights.map((right) => visibleWidth(right)));
  const leftCap = WIDGET_LINE_BUDGET - rightMax - WIDGET_GAP;

  const rows = shown.map((run, index) => {
    const left = widgetLeft(run, leftCap, options.colorize);
    const right = options.colorize
      ? options.colorize("dim", rights[index])
      : rights[index];
    const gap = " ".repeat(
      Math.max(
        WIDGET_GAP,
        WIDGET_LINE_BUDGET - visibleWidth(left) - visibleWidth(right),
      ),
    );
    return `${left}${gap}${right}`;
  });

  return [header, ...rows];
}

/** doctor：把解析后的真实配置摊平。配置类问题先看这个。 */
export function renderDoctor(input: DoctorInput): string[] {
  const lines: string[] = [];

  lines.push(`cwd: ${input.cwd}`);
  lines.push(`host: ${input.hostKind} (customPanels: ${input.customPanels})`);
  lines.push(`parent model: ${input.parentModel || "(unset)"}`);
  lines.push(`parent thinking: ${input.parentThinking || "(unset)"}`);
  lines.push(`max concurrent: ${input.maxConcurrent}`);
  if (input.logLevel) {
    lines.push(
      `log level: ${input.logLevel}${input.logConfigPath ? ` (${input.logConfigPath})` : ""}`,
    );
  }
  lines.push("");
  lines.push(`scanned dirs (${input.scannedDirs.length}):`);
  if (input.scannedDirs.length === 0) lines.push("  (none)");
  for (const dir of input.scannedDirs) lines.push(`  ${dir}`);

  lines.push("");
  lines.push(`profiles (${input.profiles.length}):`);
  for (const profile of input.profiles) {
    const model = profile.model ?? "(inherit)";
    const thinking = profile.thinking ?? "(inherit)";
    const codemode =
      profile.codemode === undefined ? "inherit" : String(profile.codemode);
    lines.push(
      `  ${profile.name} [${profile.source}] tools=${profile.tools.join(",")} model=${model} thinking=${thinking} prompt=${profile.promptMode} codemode=${codemode} mcp=${profile.mcp}`,
    );
  }

  return lines;
}

/** 给 FleetView 的会话视图用的纯渲染。 */
export function renderTranscript(run: SubagentRun, width = 100): string[] {
  const header = `${run.agent} ${run.runId} · ${run.status}${run.step ? ` · ${run.step}` : ""}`;
  const lines = [header, ""];

  for (const line of run.transcript) {
    const prefix = `[${line.role}] `;
    const text =
      line.text.length > width - prefix.length
        ? `${line.text.slice(0, width - prefix.length - 1)}…`
        : line.text;
    lines.push(`${prefix}${text}`);
  }

  if (run.transcript.length === 0) lines.push("(no activity yet)");
  if (run.resultText) {
    lines.push("", "result:", run.resultText);
  }
  if (run.error) {
    lines.push("", `error: ${run.error}`);
  }

  return lines;
}

export type LooseAgentEvent = {
  type: string;
  toolName?: string;
  message?: { role?: string; content?: unknown };
};

/** 子会话消息的窄视图：打捞只读 role / content，不引 pi 自己的类型。 */
export type ChildMessage = {
  role?: string;
  content?: unknown;
};

export type SalvageInput = {
  messages: readonly ChildMessage[];
  elapsedMs: number;
  /** 停下时最后一个工具名，用来说明它卡在哪一步。 */
  step: string | null;
};

/** 打捞摘要里最多列几个路径：再多也没人看，路径本身也只是线索。 */
const SALVAGE_MAX_PATHS = 6;

/** 会落盘的调用。codemode 里包的写入看不到，只数直接调用。 */
const WRITE_TOOLS = new Set(["write", "edit"]);

/** 参数里带路径、能说明「它读到哪了」的调用。 */
const PATH_ARG_TOOLS = new Set(["read", "write", "edit", "grep", "ls"]);

type ToolCallView = { name: string; path?: string };

const contentParts = (content: unknown): unknown[] =>
  Array.isArray(content) ? content : [];

const argumentsOf = (part: unknown): Record<string, unknown> => {
  if (!part || typeof part !== "object") return {};
  const args = (part as { arguments?: unknown }).arguments;
  return args && typeof args === "object"
    ? (args as Record<string, unknown>)
    : {};
};

const pathOf = (
  name: string,
  args: Record<string, unknown>,
): string | undefined => {
  if (!PATH_ARG_TOOLS.has(name)) return undefined;
  // 只认真正的路径：grep 的 pattern 是检索表达式，列进 paths 会误导。
  const raw = args.path ?? args.glob;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
};

/** 子会话里的每一次工具调用，按发生顺序。 */
export function toolCallsOf(messages: readonly ChildMessage[]): ToolCallView[] {
  const calls: ToolCallView[] = [];
  for (const message of messages) {
    if (message?.role !== "assistant") continue;
    for (const part of contentParts(message.content)) {
      if (!part || typeof part !== "object") continue;
      const record = part as { type?: unknown; name?: unknown };
      if (record.type !== "toolCall" || typeof record.name !== "string") {
        continue;
      }
      calls.push({
        name: record.name,
        path: pathOf(record.name, argumentsOf(part)),
      });
    }
  }
  return calls;
}

/** 子会话最后一条有正文的 assistant 发言；没有就返回空串。 */
export function lastAssistantWords(messages: readonly ChildMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;
    const text = extractAssistantText(message.content).trim();
    if (text) return text;
  }
  return "";
}

const countBy = (calls: readonly ToolCallView[]): string[] => {
  const counts = new Map<string, number>();
  for (const call of calls) {
    counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
    )
    .map(([name, count]) => `${name} ${count}`);
};

/**
 * 打捞：把一个被停掉的子会话折成主会话能读的一段正文（纯函数）。
 *
 * 停掉的 run 以前只交回 `(no output)`。可子会话的真实产出不只有最后那句报告——
 * 它读过的文件、调过什么、有没有落过盘，都还在 messages 里。这里只做两件事：
 * 取它最后一句人话，和统计它的调用轨迹。**不取 thinking**：那是过程，不是结论，
 * 混进结果会让父会话把独白当发现。
 */
export function salvageFindings(input: SalvageInput): string {
  const calls = toolCallsOf(input.messages);
  const words = lastAssistantWords(input.messages);
  const writes = calls.filter((call) => WRITE_TOOLS.has(call.name)).length;

  const elapsed = formatElapsed(input.elapsedMs);
  const where = input.step ? `last tool: \`${input.step}\`` : "no tool yet";
  const lines = [`[stopped after ${elapsed}; ${where}]`];

  lines.push(
    words
      ? `last words:\n${words}`
      : "last words: none — the child never emitted assistant text.",
  );

  const breakdown = countBy(calls);
  lines.push(
    calls.length === 0
      ? "salvaged: 0 tool calls; no write/edit calls."
      : `salvaged: ${calls.length} tool calls (${breakdown.join(", ")}); ${
          writes === 0
            ? "no write/edit calls"
            : `${writes} write/edit call${writes === 1 ? "" : "s"}`
        }.`,
  );

  const paths: string[] = [];
  for (const call of [...calls].reverse()) {
    if (!call.path || paths.includes(call.path)) continue;
    paths.push(call.path);
    if (paths.length >= SALVAGE_MAX_PATHS) break;
  }
  if (paths.length > 0) {
    lines.push(`paths: ${paths.join(", ")}`);
  }

  return lines.join("\n");
}

/** 从 assistant message 的 content 里取纯文本，取不到返回空串。 */
export function extractAssistantText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const record = part as { type?: string; text?: unknown };
      return record.type === "text" && typeof record.text === "string"
        ? record.text
        : "";
    })
    .join("");
}

/**
 * 把 AgentSession 事件折成一行 transcript。
 * 只认两种：工具开始（给 widget 的 step）和 assistant 收尾（给会话视图）。
 */
export function eventToTranscriptLine(
  event: LooseAgentEvent,
  now: number,
): TranscriptLine | null {
  if (event.type === "tool_execution_start" && event.toolName) {
    return { role: "tool", text: event.toolName, at: now };
  }

  if (event.type === "message_end" && event.message?.role === "assistant") {
    const text = extractAssistantText(event.message.content).trim();
    if (text) return { role: "assistant", text, at: now };
  }

  return null;
}
