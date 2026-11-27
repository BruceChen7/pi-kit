/**
 * Shell structure used by the bash guard. This module only reports facts about
 * a command string: which commands run, where they sit relative to loops, and
 * whether their output is captured. It never decides whether to block.
 *
 * Parsing uses `unbash`; wrappers (`sh -c`, `timeout`) and nested substitutions
 * are resolved into the same stream of facts. Anything that cannot be resolved
 * statically is reported as `unresolved` so the caller can fail closed.
 */

import {
  type Command,
  type Node,
  type ParsedScript,
  parse,
  type Redirect,
  type TestExpression,
  type Word,
} from "unbash";

/** Nested scripts (`-c`, `$()`, `<()`) deeper than this are unresolved. */
export const MAX_AST_DEPTH = 8;

export type LoopKind = "for" | "while" | "until";

export type ShellSleep = {
  seconds: number;
  loop?: LoopKind;
  iterations?: number;
  /** The loop body contains a command that can produce visible output. */
  hasProgress: boolean;
};

/** One command that the shell will actually run, after wrapper expansion. */
export type ShellCommandRef = {
  name: string;
  args: string[];
  redirects: Array<{
    operator: string;
    target?: string;
    fileDescriptor?: number;
  }>;
  /** Wrappers traversed to reach this command, e.g. `sudo`, `xargs`. */
  wrappedBy: string[];
};

export type ShellAnalysis = {
  commands: ShellCommandRef[];
  sleeps: ShellSleep[];
  /** A command writes stdout/stderr into a file, so a long call looks silent. */
  capturedOutput: boolean;
  /** `tail -f` whose output is not redirected into a file. */
  tailFollowToStdout: boolean;
  unresolved: boolean;
  errors: string[];
};

const OUTFILE_OPERATORS = new Set([">", ">>", "&>", "&>>", ">|"]);
const NON_PROGRESS = new Set([
  "sleep",
  "break",
  "continue",
  "true",
  "false",
  ":",
  "test",
  "[",
  "wait",
  "read",
  // Wrappers are not progress themselves; their inner commands are checked.
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "eval",
  "sudo",
  "env",
  "nice",
  "nohup",
  "strace",
  "xargs",
  "timeout",
  "gtimeout",
  "command",
  "exec",
  "builtin",
  "time",
  "find",
  "fd",
]);
const QUIET_FLAG = /^-{1,2}[A-Za-z]*q[A-Za-z]*$/;

type Frame = {
  kind: LoopKind;
  iterations: number | undefined;
  hasProgress: boolean;
};

type State = ShellAnalysis;

const emptyState = (): State => ({
  commands: [],
  sleeps: [],
  capturedOutput: false,
  tailFollowToStdout: false,
  unresolved: false,
  errors: [],
});

const wordValue = (word: Word | undefined): string => word?.value ?? "";

const isDynamic = (word: Word | undefined): boolean => {
  if (!word) return false;
  if (/[$`\\]/.test(word.value)) return true;
  return (word.parts ?? []).some((part) => "script" in part && part.script);
};

const parseSeconds = (word: Word | undefined): number | undefined => {
  if (!word || isDynamic(word)) return undefined;
  const match = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(word.value);
  if (!match) return undefined;
  const factors: Record<string, number> = {
    "": 1,
    s: 1,
    m: 60,
    h: 3600,
    d: 86400,
  };
  return Number.parseFloat(match[1] ?? "0") * (factors[match[2] ?? ""] ?? 1);
};

/** How many times a `for` header iterates, when that is statically knowable. */
const forIterations = (words: Word[]): number | undefined => {
  if (words.length === 0) return undefined;
  if (words.every((word) => /^\d+$/.test(word.value))) {
    return words.length;
  }

  if (words.length === 1) {
    const brace = /^\{(\d+)\.\.(\d+)\}$/.exec(words[0]?.value ?? "");
    if (brace) {
      const start = Number(brace[1]);
      const end = Number(brace[2]);
      return Number.isFinite(start) && Number.isFinite(end)
        ? Math.max(0, end - start + 1)
        : undefined;
    }

    const expansion = (words[0]?.parts ?? []).find(
      (part) => "script" in part && part.script,
    ) as { script?: ParsedScript } | undefined;
    const inner = expansion?.script?.commands[0]?.command;
    if (inner?.type === "Command" && inner.name?.value === "seq") {
      const numbers = inner.suffix.map((word) => Number(word.value));
      if (
        numbers.length >= 1 &&
        numbers.length <= 3 &&
        numbers.every((number) => Number.isInteger(number))
      ) {
        const first = numbers.length === 1 ? 1 : (numbers[0] ?? 1);
        const last =
          numbers.length === 1 ? (numbers[0] ?? 0) : (numbers[1] ?? 0);
        const step = numbers[2] ?? 1;
        return step > 0
          ? Math.max(0, Math.floor((last - first) / step) + 1)
          : undefined;
      }
    }
  }

  return undefined;
};

const hasOutputRedirect = (redirects: Redirect[]): boolean =>
  redirects.some(
    (redirect) =>
      OUTFILE_OPERATORS.has(redirect.operator) && redirect.fileDescriptor !== 2,
  );

const isProgress = (name: string, args: string[]): boolean => {
  if (name === "" || NON_PROGRESS.has(name)) return false;
  if (name === "grep" && args.some((arg) => QUIET_FLAG.test(arg))) return false;
  return true;
};

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

type PassthroughSpec = {
  flagArgs?: string[];
  optionalFlagArgs?: string[];
  skipVarAssignments?: boolean;
  skipPositionals?: number;
};

/** Wrappers whose first non-flag argument starts the real command. */
const PASSTHROUGH: Record<string, PassthroughSpec> = {
  sudo: { flagArgs: ["-C", "-D", "-g", "-l", "-p", "-r", "-U", "-u"] },
  env: { flagArgs: ["-C", "-S", "-u"], skipVarAssignments: true },
  nice: { flagArgs: ["-n"] },
  nohup: {},
  strace: { flagArgs: ["-o", "-O", "-p", "-S", "-e", "-E"] },
  xargs: {
    flagArgs: ["-a", "-d", "-E", "-e", "-I", "-L", "-l", "-n", "-P", "-s"],
    optionalFlagArgs: ["-i"],
  },
  timeout: {
    flagArgs: ["-k", "--kill-after", "-s", "--signal"],
    skipPositionals: 1,
  },
  gtimeout: {
    flagArgs: ["-k", "--kill-after", "-s", "--signal"],
    skipPositionals: 1,
  },
  command: {},
  exec: {},
  builtin: {},
  time: {},
};

type ExecSpec = { keywords: string[]; terminators: string[] | null };
const EXEC_WRAPPERS: Record<string, ExecSpec> = {
  find: {
    keywords: ["-exec", "-execdir", "-ok", "-okdir"],
    terminators: [";", "+"],
  },
  fd: {
    keywords: ["-x", "--exec", "-X", "--exec-batch"],
    terminators: null,
  },
};

/** Index of the first word that belongs to the wrapped command. */
const passthroughBoundary = (args: string[], spec: PassthroughSpec): number => {
  let index = 0;
  let skipPositionals = spec.skipPositionals ?? 0;
  while (index < args.length) {
    const arg = args[index] ?? "";
    if (spec.skipVarAssignments && /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
      index += 1;
      continue;
    }
    if (!arg.startsWith("-")) {
      if (skipPositionals > 0) {
        skipPositionals -= 1;
        index += 1;
        continue;
      }
      break;
    }
    if (spec.flagArgs?.includes(arg)) {
      index += 2;
      continue;
    }
    if (
      spec.optionalFlagArgs?.includes(arg) &&
      args[index + 1] !== undefined &&
      !args[index + 1]?.startsWith("-")
    ) {
      index += 2;
      continue;
    }
    index += 1;
  }
  return Math.min(index, args.length);
};

/** A `sh -c 'script'` payload, if these words carry one. */
const shellPayload = (words: string[]): string | undefined => {
  if (!SHELLS.has(words[0] ?? "")) return undefined;
  for (let index = 1; index < words.length; index += 1) {
    const flag = words[index] ?? "";
    if (flag === "-c" || /^-[A-Za-z]*c[A-Za-z]*$/.test(flag)) {
      return words[index + 1];
    }
  }
  return undefined;
};

const execPayload = (args: string[], spec: ExecSpec): string[] => {
  for (let index = 0; index < args.length; index += 1) {
    if (!spec.keywords.includes(args[index] ?? "")) continue;
    const rest = args.slice(index + 1);
    const end =
      spec.terminators === null
        ? rest.length
        : rest.findIndex((word) => spec.terminators?.includes(word));
    return end < 0 ? rest : rest.slice(0, end);
  }
  return [];
};

type WrapperExpansion = {
  /** Shell source carried by `-c` / `eval`; parse it as a script. */
  scripts: string[];
  /** An ordinary argv after unwrapping; keep token boundaries intact. */
  commands: string[][];
  /** Wrapper names traversed to reach each payload or command. */
  wrappedBy: string[];
  opaque: boolean;
};

/**
 * Follow wrappers until a shell payload or an ordinary command is reached.
 * Arguments are already unquoted by the parser, so an unwrapped argv is kept as
 * words instead of being re-joined into shell source.
 */
const wrapperScripts = (name: string, args: string[]): WrapperExpansion => {
  let words = [name, ...args];
  let hopped = 0;
  const scripts: string[] = [];
  const chain: string[] = [];

  for (let step = 0; step < MAX_AST_DEPTH; step += 1) {
    const head = words[0] ?? "";

    const payload = shellPayload(words);
    if (payload !== undefined) {
      return {
        scripts: [...scripts, payload],
        commands: [],
        wrappedBy: [...chain, head],
        opaque: false,
      };
    }

    if (head === "eval") {
      const body = words[1];
      if (body === undefined) {
        return { scripts, commands: [], wrappedBy: chain, opaque: false };
      }
      if (/[$`]/.test(body)) {
        return {
          scripts,
          commands: [],
          wrappedBy: [...chain, head],
          opaque: true,
        };
      }
      return {
        scripts: [...scripts, body],
        commands: [],
        wrappedBy: [...chain, head],
        opaque: false,
      };
    }

    const execSpec = EXEC_WRAPPERS[head];
    if (execSpec) {
      const inner = execPayload(words.slice(1), execSpec);
      const innerShell = shellPayload(inner);
      if (innerShell !== undefined) {
        return {
          scripts: [...scripts, innerShell],
          commands: [],
          wrappedBy: [...chain, head, inner[0] ?? ""],
          opaque: false,
        };
      }
      return {
        scripts,
        commands: inner.length > 0 ? [inner] : [],
        wrappedBy: [...chain, head],
        opaque: false,
      };
    }

    const spec = PASSTHROUGH[head];
    if (spec) {
      const inner = words.slice(1);
      const next = inner.slice(passthroughBoundary(inner, spec));
      if (next.length === 0) {
        return { scripts, commands: [], wrappedBy: chain, opaque: false };
      }
      words = next;
      chain.push(head);
      hopped += 1;
      continue;
    }

    return {
      scripts,
      commands: hopped > 0 ? [words] : [],
      wrappedBy: chain,
      opaque: false,
    };
  }

  return { scripts, commands: [], wrappedBy: chain, opaque: true };
};

/** Build a script node from an already-unquoted argv, avoiding re-parsing. */
const scriptFromWords = (words: string[]): ParsedScript => {
  const toWord = (value: string): Word => ({
    text: value,
    value,
    pos: 0,
    end: value.length,
    parts: [],
  });
  const command: Command = {
    type: "Command",
    pos: 0,
    end: 0,
    name: toWord(words[0] ?? ""),
    prefix: [],
    suffix: words.slice(1).map(toWord),
    redirects: [],
  };
  return {
    type: "Script",
    pos: 0,
    end: 0,
    shebang: undefined,
    commands: [
      {
        type: "Statement",
        pos: 0,
        end: 0,
        command,
        background: undefined,
        redirects: [],
      },
    ],
  };
};

const walkParts = (
  word: Word | undefined,
  state: State,
  frames: Frame[],
  depth: number,
  wrappedBy: string[],
): void => {
  for (const part of word?.parts ?? []) {
    if ("script" in part && part.script) {
      walkScript(part.script, state, frames, depth + 1, wrappedBy);
    } else if ("parts" in part && Array.isArray(part.parts)) {
      for (const nested of part.parts) {
        if ("script" in nested && nested.script) {
          walkScript(nested.script, state, frames, depth + 1, wrappedBy);
        }
      }
    }
  }
};

const recordSleep = (seconds: number, state: State, frames: Frame[]): void => {
  if (frames.length === 0) {
    state.sleeps.push({ seconds, hasProgress: true });
    return;
  }
  for (const frame of frames) {
    state.sleeps.push({
      seconds,
      loop: frame.kind,
      iterations: frame.iterations,
      hasProgress: frame.hasProgress,
    });
  }
};

const walkCommand = (
  command: Command,
  state: State,
  frames: Frame[],
  depth: number,
  wrappedBy: string[],
): void => {
  const name = wordValue(command.name);
  const args = command.suffix.map(wordValue);
  const redirects = [...command.redirects];

  state.commands.push({
    name,
    args,
    redirects: redirects.map((redirect) => ({
      operator: redirect.operator,
      target: redirect.target?.value,
      fileDescriptor: redirect.fileDescriptor,
    })),
    wrappedBy,
  });

  if (isDynamic(command.name)) {
    state.unresolved = true;
    state.errors.push("dynamic command name");
  }

  const captured = hasOutputRedirect(redirects);
  if (captured) state.capturedOutput = true;

  if (name === "sleep") {
    const seconds = parseSeconds(command.suffix[0]);
    if (seconds !== undefined) {
      recordSleep(seconds, state, frames);
    } else {
      state.unresolved = true;
      state.errors.push("dynamic sleep argument");
    }
  } else if (isProgress(name, args) && !captured) {
    // A command whose output is already captured cannot be the loop's
    // visible progress signal.
    for (const frame of frames) frame.hasProgress = true;
  }

  if (name === "tail") {
    const follow = args.some((arg) => /^-[A-Za-z0-9]*[fF]/.test(arg));
    if (follow && !captured) state.tailFollowToStdout = true;
  }

  for (const word of [command.name, ...command.suffix]) {
    walkParts(word, state, frames, depth, wrappedBy);
  }
  for (const redirect of redirects) {
    walkParts(redirect.target, state, frames, depth, wrappedBy);
  }

  const expansion = wrapperScripts(name, args);
  if (expansion.opaque) {
    state.unresolved = true;
    state.errors.push(`unresolvable wrapper: ${name}`);
  }
  for (const script of expansion.scripts) {
    if (depth >= MAX_AST_DEPTH) {
      state.unresolved = true;
      state.errors.push(`nested script deeper than ${MAX_AST_DEPTH}`);
      continue;
    }
    try {
      walkScript(parse(script), state, frames, depth + 1, [
        ...wrappedBy,
        ...expansion.wrappedBy,
      ]);
    } catch (error) {
      state.unresolved = true;
      state.errors.push(
        `inner script parse failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  for (const words of expansion.commands) {
    if (depth >= MAX_AST_DEPTH) {
      state.unresolved = true;
      state.errors.push(`nested script deeper than ${MAX_AST_DEPTH}`);
      continue;
    }
    walkScript(scriptFromWords(words), state, frames, depth + 1, [
      ...wrappedBy,
      ...expansion.wrappedBy,
    ]);
  }
};

const walkNode = (
  node: Node,
  state: State,
  frames: Frame[],
  depth: number,
  wrappedBy: string[],
): void => {
  switch (node.type) {
    case "Statement":
      walkNode(node.command, state, frames, depth, wrappedBy);
      if (hasOutputRedirect(node.redirects)) state.capturedOutput = true;
      return;

    case "Command":
      walkCommand(node, state, frames, depth, wrappedBy);
      return;

    case "Pipeline":
    case "AndOr":
    case "CompoundList":
      for (const child of node.commands) {
        walkNode(child as Node, state, frames, depth, wrappedBy);
      }
      return;

    case "If":
      walkNode(node.clause, state, frames, depth, wrappedBy);
      walkNode(node.then, state, frames, depth, wrappedBy);
      if (node.else) walkNode(node.else, state, frames, depth, wrappedBy);
      return;

    case "For":
    case "Select": {
      for (const word of [node.name, ...node.wordlist]) {
        walkParts(word, state, frames, depth, wrappedBy);
      }
      const frame: Frame = {
        kind: "for",
        iterations: forIterations(node.wordlist),
        hasProgress: false,
      };
      walkNode(node.body, state, [...frames, frame], depth, wrappedBy);
      return;
    }

    case "While": {
      const frame: Frame = {
        kind: node.kind,
        iterations: undefined,
        hasProgress: false,
      };
      const nested = [...frames, frame];
      walkNode(node.clause, state, nested, depth, wrappedBy);
      walkNode(node.body, state, nested, depth, wrappedBy);
      return;
    }

    case "ArithmeticFor": {
      const frame: Frame = {
        kind: "while",
        iterations: undefined,
        hasProgress: false,
      };
      walkNode(node.body, state, [...frames, frame], depth, wrappedBy);
      return;
    }

    case "Case":
      walkParts(node.word, state, frames, depth, wrappedBy);
      for (const item of node.items) {
        for (const word of item.pattern) {
          walkParts(word, state, frames, depth, wrappedBy);
        }
        walkNode(item.body, state, frames, depth, wrappedBy);
      }
      return;

    case "Function":
      walkNode(node.body, state, frames, depth, wrappedBy);
      return;

    case "Subshell":
    case "BraceGroup":
      walkNode(node.body, state, frames, depth, wrappedBy);
      return;

    case "Coproc":
      walkNode(node.body, state, frames, depth, wrappedBy);
      return;

    case "TestCommand":
      for (const word of testWords(node.expression)) {
        walkParts(word, state, frames, depth, wrappedBy);
      }
      return;

    case "ArithmeticCommand":
      // Arithmetic is opaque here; command substitutions inside it are rare but
      // can execute commands, so mark it unresolved rather than silently allow.
      if (node.body.includes("$(") || node.body.includes("`")) {
        state.unresolved = true;
        state.errors.push("command substitution inside arithmetic");
      }
      return;

    default:
      state.unresolved = true;
      state.errors.push(
        `unhandled AST node: ${(node as { type?: string }).type ?? "unknown"}`,
      );
  }
};

/** Words that take part in a `[[ ... ]]` / `[ ... ]` expression. */
const testWords = (expression: TestExpression): Word[] => {
  const words: Word[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if ("text" in value && "value" in value && "pos" in value) {
      words.push(value as Word);
      return;
    }
    for (const child of Object.values(value as Record<string, unknown>)) {
      visit(child);
    }
  };
  visit(expression);
  return words;
};

const walkScript = (
  script: ParsedScript,
  state: State,
  frames: Frame[],
  depth: number,
  wrappedBy: string[] = [],
): void => {
  if (script.errors?.length) {
    state.unresolved = true;
    state.errors.push(...script.errors.map((error) => error.message));
  }
  for (const statement of script.commands) {
    walkNode(statement, state, frames, depth, wrappedBy);
  }
};

/** Parse a tool call's command into guard-relevant structure. */
export const analyzeShellCommand = (command: string): ShellAnalysis => {
  const state = emptyState();
  try {
    walkScript(parse(command), state, [], 0);
  } catch (error) {
    state.unresolved = true;
    state.errors.push(error instanceof Error ? error.message : String(error));
  }
  return state;
};
