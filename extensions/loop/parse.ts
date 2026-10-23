/**
 * `/loop` 的参数解析。纯函数，不碰磁盘也不跑命令。
 *
 * 文法只有四条：
 *   /loop status
 *   /loop stop
 *   /loop resume [--max-turns <n>]
 *   /loop run [--max-turns <n>] [--until <cmd>] [--until-timeout <sec>] [--allow-dirty] [--] <goal...>
 *
 * 分词只做引号与反斜杠转义，不做变量、命令替换或通配符：`/loop` 的输入来自
 * 操作者，但把它当成 shell 解析只会让人以为展开会发生。
 */

export const MIN_MAX_TURNS = 1;
export const MAX_MAX_TURNS = 100;
export const DEFAULT_MAX_TURNS = 8;
export const DEFAULT_UNTIL_TIMEOUT_SEC = 60;
export const MIN_UNTIL_TIMEOUT_SEC = 1;
export const MAX_UNTIL_TIMEOUT_SEC = 600;

export type LoopRunOptions = {
  action: "run";
  goal: string;
  maxTurns: number;
  until: { command: string; timeoutSec: number } | null;
  allowDirty: boolean;
};

export type LoopResumeOptions = { action: "resume"; maxTurns?: number };
export type LoopCommand =
  | { action: "status" }
  | { action: "stop"; reason: "operator-stopped" }
  | LoopResumeOptions
  | LoopRunOptions;

const tokenize = (text: string): string[] => {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    if (char === "\\" && quote !== "'") {
      const next = text[index + 1];
      if (next === undefined) {
        throw new Error("Unfinished escape in /loop arguments");
      }
      if (quote === null || ["$", "`", '"', "\\", "\n"].includes(next)) {
        if (next !== "\n") {
          current += next;
          started = true;
        }
        index += 1;
      } else {
        current += char;
        started = true;
      }
      continue;
    }
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }

  if (quote !== null) {
    throw new Error("Unclosed quote in /loop arguments");
  }
  if (started) {
    tokens.push(current);
  }
  return tokens;
};

const integer = (
  raw: string,
  name: string,
  min: number,
  max: number,
): number => {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
};

const USAGE =
  "Usage: /loop run [--max-turns <n>] [--until <cmd>] [--until-timeout <sec>] [--allow-dirty] <goal> | status | stop | resume [--max-turns <n>]";

export const parseLoopArgs = (rawArgs: string | undefined): LoopCommand => {
  const text = String(rawArgs ?? "").trim();
  if (!text) {
    return { action: "status" };
  }

  const tokens = tokenize(text);
  const first = tokens[0]?.toLowerCase() ?? "";

  if (first === "status") {
    if (tokens.length !== 1) {
      throw new Error(`status takes no arguments. ${USAGE}`);
    }
    return { action: "status" };
  }

  if (first === "stop") {
    if (tokens.length !== 1) {
      throw new Error(`stop takes no arguments. ${USAGE}`);
    }
    return { action: "stop", reason: "operator-stopped" };
  }

  if (first === "resume") {
    let maxTurns: number | undefined;
    for (let index = 1; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token === "--max-turns") {
        const value = tokens[index + 1];
        if (value === undefined) {
          throw new Error("--max-turns needs a value");
        }
        maxTurns = integer(value, "--max-turns", MIN_MAX_TURNS, MAX_MAX_TURNS);
        index += 1;
        continue;
      }
      throw new Error(`Unknown option for resume: ${token}. ${USAGE}`);
    }
    return { action: "resume", maxTurns };
  }

  if (first !== "run") {
    throw new Error(USAGE);
  }

  let maxTurns = DEFAULT_MAX_TURNS;
  let untilCommand: string | null = null;
  let untilTimeoutSec = DEFAULT_UNTIL_TIMEOUT_SEC;
  let allowDirty = false;
  const goalWords: string[] = [];

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    if (token === "--") {
      goalWords.push(...tokens.slice(index + 1));
      break;
    }
    if (token === "--allow-dirty") {
      allowDirty = true;
      continue;
    }
    if (
      token === "--max-turns" ||
      token === "--until" ||
      token === "--until-timeout"
    ) {
      const value = tokens[index + 1];
      if (value === undefined) {
        throw new Error(`${token} needs a value`);
      }
      if (token === "--max-turns") {
        maxTurns = integer(value, "--max-turns", MIN_MAX_TURNS, MAX_MAX_TURNS);
      } else if (token === "--until") {
        if (!value.trim()) {
          throw new Error("--until needs a non-empty command");
        }
        untilCommand = value;
      } else {
        untilTimeoutSec = integer(
          value,
          "--until-timeout",
          MIN_UNTIL_TIMEOUT_SEC,
          MAX_UNTIL_TIMEOUT_SEC,
        );
      }
      index += 1;
      continue;
    }
    if (token.startsWith("--")) {
      throw new Error(`Unknown option: ${token}. ${USAGE}`);
    }
    goalWords.push(token);
  }

  const goal = goalWords.join(" ").trim();
  if (!goal) {
    throw new Error(`A goal is required. ${USAGE}`);
  }

  return {
    action: "run",
    goal,
    maxTurns,
    until: untilCommand
      ? { command: untilCommand, timeoutSec: untilTimeoutSec }
      : null,
    allowDirty,
  };
};
