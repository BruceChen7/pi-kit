/**
 * subagent 运行状态机（Functional Core）。
 *
 * 所有函数都是 value in / value out：接 `SubagentState`，返回新的 `SubagentState`。
 * 没有 session、没有 timer、没有 IO —— 时间由调用方作为 `now` 传入。
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import type { AgentProfile } from "./agents.ts";

export type RunStatus = "queued" | "running" | "done" | "failed" | "stopped";

export type TerminalStatus = "done" | "failed" | "stopped";

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
  status: "done" | "failed";
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

export const DEFAULT_MAX_CONCURRENT = 4;
export const MAX_RESULT_CHARS = 8000;
export const MAX_TRANSCRIPT_LINES = 40;

const TERMINAL: readonly RunStatus[] = ["done", "failed", "stopped"];

export const isTerminal = (status: RunStatus): status is TerminalStatus =>
  TERMINAL.includes(status);

export const createState = (): SubagentState => ({ runs: [] });

export const findRun = (
  state: SubagentState,
  runId: string,
): SubagentRun | undefined => state.runs.find((run) => run.runId === runId);

export const activeRuns = (state: SubagentState): SubagentRun[] =>
  state.runs.filter((run) => !isTerminal(run.status));

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

export function stop(
  state: SubagentState,
  runId: string,
  maxConcurrent: number = DEFAULT_MAX_CONCURRENT,
  now: number = Date.now(),
): SubagentState {
  const target = findRun(state, runId);
  if (!target || isTerminal(target.status)) return state;

  const stopped: SubagentState = {
    runs: state.runs.map((run) =>
      run.runId === runId
        ? { ...run, status: "stopped", endedAt: now, step: null }
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
