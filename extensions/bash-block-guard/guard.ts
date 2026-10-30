/**
 * Decision logic for the bash guard: a bash call may not silently sit in a
 * `sleep` loop, or ask pi to wait past the limit, without saying so first.
 *
 * Everything here is pure. The extension shell reads the tool call, resolves
 * limits from the environment, and turns the decision into a tool_call result.
 */

import { stripHeredocBodies } from "../shared/shell-text.ts";

export type BashCall = {
  command: string;
  timeoutSeconds?: number;
};

export type BashGuardRule = "sleep-loop" | "sleep" | "long-timeout";

export type BashGuardDecision =
  | { action: "allow" }
  | { action: "block"; rule: BashGuardRule; reason: string };

export type BashGuardLimits = {
  /** Longest single call pi is asked to sit on, in seconds. */
  maxSeconds: number;
  enabled: boolean;
};

export const DEFAULT_MAX_SECONDS = 300;
/** Below this, a sleep reads as pacing rather than waiting on the world. */
export const SLEEP_THRESHOLD_SECONDS = 20;

const DEFAULT_LIMITS: BashGuardLimits = {
  maxSeconds: DEFAULT_MAX_SECONDS,
  enabled: true,
};

const ALLOW: BashGuardDecision = { action: "allow" };

const FOR_LOOP = /\bfor\b[\s\S]*?\bdo\b/;
const WHILE_OR_UNTIL = /\b(?:while|until)\b/;
/** `sleep 30`, `sleep 1m`. A bare `sleep` with no amount is not a real call. */
const SLEEP_WITH_AMOUNT = /\bsleep\s+(\d+(?:\.\d+)?)([smhd]?)\b/g;
const COMMENT_START_BEFORE = /[\s;|&(]/;

const UNIT_SECONDS: Record<string, number> = {
  "": 1,
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
};

/**
 * Drops quoted strings and comments, so `echo "sleep 30"` and `# sleep 30`
 * are not read as calls. Known blind spot: a real wait hidden inside
 * `sh -c "..."` is stripped too; see README.
 */
const stripQuotedAndComments = (command: string): string => {
  let out = "";
  let index = 0;
  let quote: "'" | '"' | null = null;
  let quoteStart = -1;

  while (index < command.length) {
    const char = command[index];
    if (quote) {
      if (char === "\\" && quote === '"') {
        index += 2;
        continue;
      }
      if (char === quote) {
        quote = null;
        out += " ";
      }
      index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      quoteStart = index;
      index += 1;
      continue;
    }
    const before = index === 0 ? " " : (command[index - 1] ?? "");
    if (char === "#" && COMMENT_START_BEFORE.test(before)) {
      while (index < command.length && command[index] !== "\n") {
        index += 1;
      }
      continue;
    }
    out += char;
    index += 1;
  }

  // An unterminated quote never closes, so nothing was actually quoted away.
  if (quote) {
    out += command.slice(quoteStart);
  }

  return out;
};

const hasLoop = (command: string): boolean =>
  FOR_LOOP.test(command) || WHILE_OR_UNTIL.test(command);

const sleepSeconds = (command: string): number[] =>
  [...command.matchAll(SLEEP_WITH_AMOUNT)].map((match) => {
    const amount = Number.parseFloat(match[1] ?? "");
    const unit = UNIT_SECONDS[match[2] ?? ""] ?? 1;
    return amount * unit;
  });

/**
 * The reason strings are the whole product of a block: they name the rule and
 * the replacement move. Examples stay labelled as examples, because the same
 * text fires for any repository and any command.
 */
/** Commands worth rerunning in the background: the first line that is not a bare wait. */
const rerunnableCommand = (command: string): string | undefined => {
  const line = command
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate !== "" && !/^sleep\b/.test(candidate));
  if (line === undefined) return undefined;
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
};

const RUNNER_WORDS = new Set([
  "npx",
  "pnpm",
  "yarn",
  "npm",
  "bun",
  "make",
  "time",
  "sudo",
  "env",
  "timeout",
  "bash",
  "sh",
]);

/** `/tmp/<slug>.log` name for the background rewrite. */
const backgroundSlug = (command: string): string => {
  const words = (command.match(/[A-Za-z0-9]+/g) ?? []).filter(
    (word) => !RUNNER_WORDS.has(word.toLowerCase()),
  );
  const slug = words.slice(0, 2).join("-").toLowerCase();
  return slug === "" ? "pi-bg" : slug;
};

/**
 * The query a sleep loop repeats, so the rewrite can name it. Segments that
 * only set the loop up or wait are not queries.
 */
const commandInsideLoop = (command: string): string | undefined => {
  const segments = command
    .split(/[;\n]/)
    .map((segment) => segment.trim().replace(/^(?:do|then|else)\s+/, ""))
    .filter(
      (segment) =>
        segment !== "" &&
        !/^(?:for|while|until|sleep|do|then|else|done|fi)\b/.test(segment),
    );
  return segments[0];
};

const sleepLoopReason = (
  seconds: number | undefined,
  command: string,
): string => {
  const longest =
    seconds === undefined ? [] : [`这次循环里最长的一次等待是 ${seconds} 秒。`];
  const query = commandInsideLoop(command);
  const concrete =
    query === undefined || seconds === undefined
      ? []
      : [
          `改法（具体到你这条命令）：把整轮循环换成 timeout ${seconds} ${query}。`,
        ];
  return [
    "拦住原因：命令里有 for / while / until 加 sleep，整轮没有任何进度输出。",
    ...longest,
    ...concrete,
    "替代写法，按优先级：",
    "1. 先单次查询一次当前状态，拿到结果就结束这一轮。",
    "2. 还需要等，就把等待交还给用户，说明下次什么时候再看。",
    "3. 必须后台跑：<cmd> > /tmp/<slug>.log 2>&1 & ，之后用一次 read 或 grep 看那个日志。",
    "示例（示意，不是固定写法）：把 for 循环里反复 sleep 查询，换成一次 timeout 90 的单次查询，" +
      "例如 timeout 90 glab ci status --branch <branch> | head -5。",
  ].join("\n");
};

const sleepReason = (seconds: number): string =>
  [
    `拦住原因：sleep ${seconds} 这类调用不产出任何进度，只是占住这一轮。`,
    "替代写法：",
    "1. 要等外部状态，换成单次查询，自带 timeout，命令自带输出。",
    "2. 要冷却等用户回来，直接结束这一轮把控制权交回去。",
    "示例（示意）：timeout 90 glab ci status --branch <branch> | head -5。",
  ].join("\n");

const longTimeoutReason = (
  asked: number,
  limit: number,
  command: string,
): string => {
  const rerunnable = rerunnableCommand(command);
  const background =
    rerunnable === undefined
      ? []
      : [
          "1. 把这条命令改成后台加日志，然后单次 read 或 grep 检查：",
          `   ${rerunnable} > /tmp/${backgroundSlug(command)}.log 2>&1 &`,
        ];
  return [
    `拦住原因：这次调用要求 pi 等 ${asked} 秒，上限 ${limit} 秒，期间没有中途输出。`,
    "替代写法：",
    ...background,
    `${background.length === 0 ? "1" : "2"}. 或拆成几条更小的调用，每条都自带输出。`,
    `${background.length === 0 ? "2" : "3"}. 真要突破上限，显式设 PI_BASH_GUARD_MAX_SECONDS=<秒数>，当前上限 ${limit}。`,
  ].join("\n");
};

export const decideBashGuard = (
  call: BashCall,
  limits: BashGuardLimits = DEFAULT_LIMITS,
): BashGuardDecision => {
  if (!limits.enabled) {
    return ALLOW;
  }

  const scanned = stripQuotedAndComments(stripHeredocBodies(call.command));
  const sleeps = sleepSeconds(scanned);
  const longestSleep = sleeps.length > 0 ? Math.max(...sleeps) : undefined;

  if (hasLoop(scanned) && longestSleep !== undefined) {
    return {
      action: "block",
      rule: "sleep-loop",
      reason: sleepLoopReason(longestSleep, call.command),
    };
  }

  if (longestSleep !== undefined && longestSleep >= SLEEP_THRESHOLD_SECONDS) {
    return {
      action: "block",
      rule: "sleep",
      reason: sleepReason(longestSleep),
    };
  }

  if (
    call.timeoutSeconds !== undefined &&
    call.timeoutSeconds > limits.maxSeconds
  ) {
    return {
      action: "block",
      rule: "long-timeout",
      reason: longTimeoutReason(
        call.timeoutSeconds,
        limits.maxSeconds,
        call.command,
      ),
    };
  }

  return ALLOW;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Reads the parts of a bash tool call the guard cares about. Null means: not ours. */
export const readBashCall = (
  toolName: string,
  input: unknown,
): BashCall | null => {
  if (toolName !== "bash" || !isRecord(input)) {
    return null;
  }
  const command = input.command;
  if (typeof command !== "string" || command.trim() === "") {
    return null;
  }
  const timeout = input.timeout;
  return {
    command,
    timeoutSeconds:
      typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0
        ? timeout
        : undefined,
  };
};

export const resolveLimits = (
  env: Record<string, string | undefined>,
): BashGuardLimits => {
  const raw = env.PI_BASH_GUARD_MAX_SECONDS;
  const parsed = raw === undefined ? Number.NaN : Number.parseFloat(raw);
  return {
    enabled: env.PI_BASH_GUARD_DISABLED !== "1",
    maxSeconds:
      Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_SECONDS,
  };
};
