/**
 * subagent 运行状态机（Functional Core）。
 *
 * 所有函数都是 value in / value out：接 `SubagentState`，返回新的 `SubagentState`。
 * 没有 session、没有 timer、没有 IO —— 时间由调用方作为 `now` 传入。
 */

import type { AgentProfile } from "./agents.ts";

export type RunStatus = "queued" | "running" | "done" | "failed" | "stopped";

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
  transcript: TranscriptLine[];
  resultText?: string;
  error?: string;
  background: boolean;
};

export type SubagentState = {
  runs: SubagentRun[];
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

export const isTerminal = (status: RunStatus): boolean =>
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

  const runs = state.runs.map((run) => {
    if (capacity > 0 && run.status === "queued") {
      capacity -= 1;
      return { ...run, status: "running" as RunStatus };
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
): { state: SubagentState; admitted: string[]; queued: string[] } {
  const run: SubagentRun = {
    runId: request.runId,
    agent: request.agent,
    task: request.task,
    status: "queued",
    startedAt: now,
    step: null,
    transcript: [],
    background: request.background,
  };

  const withRun: SubagentState = { runs: [...state.runs, run] };
  const next = promote(withRun, maxConcurrent);

  const admitted: string[] = [];
  const queued: string[] = [];
  for (const candidate of next.runs) {
    if (candidate.runId !== request.runId) continue;
    if (candidate.status === "running") admitted.push(candidate.runId);
    else queued.push(candidate.runId);
  }

  return { state: next, admitted, queued };
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
): SubagentState {
  return {
    runs: state.runs.map((run) =>
      run.runId === runId ? { ...run, step } : run,
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
      return { ...run, transcript };
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

const formatElapsed = (ms: number): string => {
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

/** widget 行。没有任何活跃 run 时返回空数组，让宿主把 widget 撤掉。 */
export function renderWidgetLines(
  state: SubagentState,
  now: number = Date.now(),
): string[] {
  const live = activeRuns(state);
  if (live.length === 0) return [];

  const running = live.filter((run) => run.status === "running").length;
  const header = `Subagents · ${running} running, ${live.length - running} queued`;

  const rows = live.map((run) => {
    const glyph = STATUS_GLYPH[run.status];
    const elapsed = formatElapsed(now - run.startedAt);
    const step = run.step ? ` · ${run.step}` : "";
    return `  ${glyph} ${run.agent} ${run.runId} ${elapsed}${step}`;
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
