/**
 * Decision logic for the bash guard: a bash call may not silently sit in a
 * `sleep` loop, or hide a long wait behind a captured output stream, without
 * saying so first.
 *
 * Everything here is pure. Structure comes from `shared/shell-ast.ts`; this
 * file only turns those facts into a decision and a reason.
 */

import { analyzeShellCommand, type ShellSleep } from "../shared/shell-ast.ts";

export type BashCall = {
  command: string;
  timeoutSeconds?: number;
};

export type BashGuardRule =
  | "sleep-loop"
  | "sleep"
  | "long-timeout"
  | "tail-follow"
  | "unparseable";

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

/** `/tmp/<slug>.log` name for the background rewrite. */
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

const rerunnableCommand = (command: string): string | undefined => {
  const line = command
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate !== "" && !/^sleep\b/.test(candidate));
  if (line === undefined) return undefined;
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
};

const backgroundSlug = (command: string): string => {
  const words = (command.match(/[A-Za-z0-9]+/g) ?? []).filter(
    (word) => !RUNNER_WORDS.has(word.toLowerCase()),
  );
  const slug = words.slice(0, 2).join("-").toLowerCase();
  return slug === "" ? "pi-bg" : slug;
};

/** The query a sleep loop repeats, so the rewrite can name it. */
const WAIT_LOG_HINT =
  "要等一条日志出现某一行：tools/wait-log.sh <log> <regex> [timeout] [interval]" +
  "（仓库里有就用它；一次调用等到结论，每 10 秒自己出一行进度，命中 exit 0 / 超时 124）。";

const sleepReason = (seconds: number): string =>
  [
    `拦住原因：单独等待 ${seconds} 秒，期间没有产出。`,
    "替代写法，按优先级：",
    "1. 要等外部状态，换成单次查询，自带 timeout，命令自带输出。",
    "2. 要冷却等用户回来，直接结束这一轮把控制权交回去。",
    WAIT_LOG_HINT,
    "示例（示意）：timeout 90 glab ci status --branch <branch> | head -5。",
  ].join("\n");

const sleepLoopReason = (seconds: number): string =>
  [
    "拦住原因：循环里反复等待，整轮没有可见进度输出，pi 会被占住。",
    `这次循环里最长的一次等待是 ${seconds} 秒。`,
    "替代写法，按优先级：",
    "1. 先单次查询一次当前状态，拿到结果就结束这一轮。",
    "2. 还需要等，就把等待交还给用户，说明下次什么时候再看。",
    "3. 必须后台跑：<cmd> > /tmp/<slug>.log 2>&1 & ，之后用一次 read 或 grep 看那个日志。",
    WAIT_LOG_HINT,
    "示例（示意）：把反复 sleep 查询换成一次 timeout 90 的单次查询，" +
      "例如 timeout 90 glab ci status --branch <branch> | head -5。",
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
    WAIT_LOG_HINT,
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
    `拦住原因：这次调用要求 pi 等 ${asked} 秒（上限 ${limit} 秒），而且输出被文件捕获，看起来会静默等待。`,
    "替代写法：",
    ...background,
    WAIT_LOG_HINT,
    `${background.length === 0 ? "1" : "2"}. 或拆成几条更小的调用，每条都自带输出。`,
    `${background.length === 0 ? "2" : "3"}. 真要突破上限，显式设 PI_BASH_GUARD_MAX_SECONDS=<秒数>，当前上限 ${limit}。`,
  ].join("\n");
};

const unparseableReason = (): string =>
  [
    "拦住原因：命令里有无法静态判定的 shell 结构（解析错误或动态命令名），护栏无法确认是否包含等待。",
    "替代写法：",
    "1. 把动态片段换成字面量，或拆成几条自带输出的小命令。",
    "2. 必须后台跑：<cmd> > /tmp/<slug>.log 2>&1 & ，之后用一次 read 或 grep 看那个日志。",
    WAIT_LOG_HINT,
  ].join("\n");

const blocked = (rule: BashGuardRule, reason: string): BashGuardDecision => ({
  action: "block",
  rule,
  reason,
});

export const decideBashGuard = (
  call: BashCall,
  limits: BashGuardLimits = DEFAULT_LIMITS,
): BashGuardDecision => {
  if (!limits.enabled) {
    return ALLOW;
  }

  const analysis = analyzeShellCommand(call.command);

  // Unknown structure is not evidence of safety.
  if (analysis.unresolved) {
    return blocked("unparseable", unparseableReason());
  }

  // Name the longest wait in the reason; several sites can trip the rule.
  const site = analysis.sleeps.reduce<ShellSleep | undefined>(
    (worst, candidate) =>
      worst === undefined || candidate.seconds > worst.seconds
        ? candidate
        : worst,
    undefined,
  );
  if (site !== undefined) {
    // A loop with no statically known iteration count can run forever, so its
    // wait is unbounded. A bounded loop is judged by its total sleep time.
    const total =
      site.loop === undefined
        ? site.seconds
        : (site.iterations ?? Number.POSITIVE_INFINITY) * site.seconds;
    const silentWait = !site.hasProgress && total >= SLEEP_THRESHOLD_SECONDS;

    if (site.seconds >= SLEEP_THRESHOLD_SECONDS || silentWait) {
      return site.loop === undefined
        ? blocked("sleep", sleepReason(site.seconds))
        : blocked("sleep-loop", sleepLoopReason(site.seconds));
    }
  }

  if (
    call.timeoutSeconds !== undefined &&
    call.timeoutSeconds > limits.maxSeconds &&
    analysis.capturedOutput
  ) {
    return blocked(
      "long-timeout",
      longTimeoutReason(call.timeoutSeconds, limits.maxSeconds, call.command),
    );
  }

  if (analysis.tailFollowToStdout) {
    return blocked("tail-follow", tailFollowReason(call.command));
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
    maxSeconds:
      Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_SECONDS,
    enabled: env.PI_BASH_GUARD_DISABLED !== "1",
  };
};
