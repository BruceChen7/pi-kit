/**
 * Decision logic for the bash guard: a bash call may not silently sit in a
 * `sleep` loop, or ask pi to wait past the limit, without saying so first.
 *
 * Everything here is pure. The extension shell reads the tool call, resolves
 * limits from the environment, and turns the decision into a tool_call result.
 */

import { analyzeShell, type ShellUnresolved } from "../shared/shell/index.ts";
import { stripHeredocBodies } from "../shared/shell-text.ts";

export type BashCall = {
  command: string;
  timeoutSeconds?: number;
};

export type BashGuardRule =
  | "sleep-loop"
  | "sleep"
  | "long-timeout"
  | "tail-follow"
  /** 命令里有一段护栏看不进去的动态执行（`sh -c "$CMD"`、`$CMD ...`）。 */
  | "unresolved-dynamic-execution";

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
/**
 * `tail -f`, `tail -F`, `tail -n 40 -f`, `tail -20f`: follow mode never exits on its own,
 * so the call blocks until pi kills it.
 */
const TAIL_FOLLOW = /\btail\b[^|;&\n]*\s-[A-Za-z0-9]*[fF]/;
/**
 * A redirect that captures stdout (`> /tmp/x.log`). A stderr-only redirect (`2>/dev/null`)
 * does not help, so the `(?<![0-9])` guard excludes it.
 */
const REDIRECTED_TO_FILE = /(?:^|[^0-9])>>?\s*[^\s|&;>]+/;

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

/** The `|`/`;`/`&`-separated pieces that actually carry follow mode. */
const followSegments = (command: string): string[] =>
  command.split(/[|;&\n]+/).filter((segment) => TAIL_FOLLOW.test(segment));

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

const tailFollowReason = (command: string): string => {
  const slug = backgroundSlug(command);
  return [
    "拦住原因：命令里有 tail -f / -F，跟随模式不会自己退出，这一轮会一直被占住直到 pi 把它杀掉。",
    "注意 grep -m1 不会救它：那只是让下游退出，上游 tail -f 还活着，整轮照样卡满。",
    "替代写法，按优先级：",
    '1. 要看某个后台任务的结果：先一次性跑 `grep -c "exit=" /tmp/' +
      `${slug}.log` +
      "` 判断结束，再 `read` 那个日志的尾部。",
    `2. 命令还没起：\`${rerunnableCommand(command) ?? "<cmd>"} > /tmp/${slug}.log 2>&1 &\`，下一轮单次 read 或 grep 那个日志。`,
    "3. 只是想要最后几行：去掉 -f，用 tail -n 40 <log>。",
  ].join("\n");
};

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

const unresolvedReason = (unresolved: ShellUnresolved): string => {
  const what =
    unresolved.kind === "nested-shell-dynamic"
      ? '嵌套 shell 的脚本是一个变量（sh -c "$SCRIPT" 这种）'
      : unresolved.kind === "eval-dynamic"
        ? "eval 的文本里含变量"
        : "要执行的命令名由变量拼出来";
  return [
    `拦住原因：${what}，护栏看不进这段动态执行，无法判断它会不会把这一轮占住。`,
    `这段命令：${unresolved.raw}`,
    "替代写法：",
    "1. 把脚本或命令名写成字面量，让护栏能读到它。",
    "2. 真要动态拼，先把结果打印出来看一眼，再单次执行。",
  ].join("\n");
};

/**
 * 结构层再判一次：正则看不见"引号里面还有什么"。`sh -c "sleep 30"` 这种
 * 以前是 README 里承认的盲区，现在按嵌套脚本递归判；脚本本身是变量时
 * fail-closed，交给模型改写成字面量（ADR-0001 D3）。
 */
const decideStructuralGuard = (
  call: BashCall,
  limits: BashGuardLimits,
): BashGuardDecision | null => {
  let analysis: ReturnType<typeof analyzeShell>;
  try {
    analysis = analyzeShell(call.command);
  } catch {
    // 结构层自己出错不该让护栏失声：交回正则路径。
    return null;
  }

  for (const nested of analysis.nested) {
    const decision = decideBashGuard({ command: nested.source }, limits);
    if (decision.action === "block") {
      return decision;
    }
  }

  const unresolved = analysis.unresolved[0];
  if (unresolved !== undefined) {
    return {
      action: "block",
      rule: "unresolved-dynamic-execution",
      reason: unresolvedReason(unresolved),
    };
  }

  return null;
};

export const decideBashGuard = (
  call: BashCall,
  limits: BashGuardLimits = DEFAULT_LIMITS,
): BashGuardDecision => {
  if (!limits.enabled) {
    return ALLOW;
  }

  const structural = decideStructuralGuard(call, limits);
  if (structural !== null) {
    return structural;
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

  if (
    followSegments(scanned).some((segment) => !REDIRECTED_TO_FILE.test(segment))
  ) {
    return {
      action: "block",
      rule: "tail-follow",
      reason: tailFollowReason(call.command),
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
