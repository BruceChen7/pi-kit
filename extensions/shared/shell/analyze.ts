/**
 * Shell 的结构层：把词法层的 token 组成"命令段 + 重定向 + 结构关键字"，
 * 并把可以静态判定的嵌套脚本（`sh -c "…"`、`eval "…"`）递归解析出来。
 *
 * 复制的是 adr/0001 里 D3 的约定：判定不了的动态执行不静默放行，而是作为
 * `unresolved` 交给护栏，由护栏决定拒绝还是保守放行。
 */

import {
  REDIRECT_OPERATORS,
  type ShellOperator,
  type ShellToken,
  type ShellWordToken,
  tokenizeShell,
} from "./tokenize.ts";

export type ShellRedirect = {
  operator: ShellOperator;
  /** `2>file` 里的 2；缺省表示 stdout。 */
  fd?: number;
  target?: ShellWordToken;
  /** 目标由变量拼出来时，落点不可静态判定。 */
  targetDynamic: boolean;
  heredoc?: { delimiter: string; body: string };
};

export type ShellSegment = {
  /** 与前一个命令段之间的连接符；整条命令的第一段是 null。 */
  joiner: ShellOperator | null;
  words: ShellWordToken[];
  redirects: ShellRedirect[];
  /** 这一段里出现过的结构关键字（for/while/until/do/done/if/then/fi…）。 */
  structure: string[];
  raw: string;
};

export type ShellUnresolved = {
  kind: "dynamic-command" | "nested-shell-dynamic" | "eval-dynamic";
  segmentIndex: number;
  raw: string;
};

export type ShellAnalysis = {
  source: string;
  segments: ShellSegment[];
  /** 可静态判定的嵌套脚本，已递归解析。 */
  nested: ShellAnalysis[];
  unresolved: ShellUnresolved[];
  /** 词法层报的错（未闭合的引号等）。 */
  errors: string[];
  /** 整条命令里出现过的结构关键字，含嵌套。 */
  structure: string[];
};

const STRUCTURE_KEYWORDS = new Set([
  "for",
  "while",
  "until",
  "do",
  "done",
  "if",
  "then",
  "elif",
  "else",
  "fi",
  "case",
  "esac",
  "select",
  "function",
  "{",
  "}",
]);

/** 只改变"下一条命令是谁"的前缀，本身不是被执行的命令。 */
const COMMAND_WRAPPERS = new Set([
  "sudo",
  "doas",
  "env",
  "time",
  "nohup",
  "command",
  "builtin",
  "exec",
  "nice",
  "ionice",
  "stdbuf",
]);

const SHELL_NAMES = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

const MAX_NESTING_DEPTH = 4;

export type EffectiveCommand = {
  /** 真正被执行的命令名；动态时是 null。 */
  name: string | null;
  args: ShellWordToken[];
  /** 命令名不可静态判定（`$CMD …`）。 */
  dynamic: boolean;
  /** 去掉包装前缀之前的原始首词。 */
  raw: string;
};

const isDynamic = (word: ShellWordToken): boolean => word.dynamic;

/**
 * 去掉 `sudo`/`env`/`timeout N` 一类前缀，得到真正被执行的命令。
 * `timeout` 的时长是它自己的参数，不是命令的参数。
 */
export const effectiveCommand = (segment: ShellSegment): EffectiveCommand => {
  let index = 0;
  const words = segment.words;
  const raw = words[index]?.text ?? "";

  while (index < words.length) {
    const word = words[index];
    if (word === undefined) break;
    if (STRUCTURE_KEYWORDS.has(word.text)) {
      index += 1;
      continue;
    }
    if (word.text === "timeout") {
      index += 1;
      // `timeout 90 cmd` 或 `timeout -s KILL 90 cmd`
      while (index < words.length) {
        const arg = words[index];
        if (arg === undefined) break;
        if (arg.text.startsWith("-")) {
          index += arg.text === "-s" || arg.text === "--signal" ? 2 : 1;
          continue;
        }
        index += 1;
        break;
      }
      continue;
    }
    if (COMMAND_WRAPPERS.has(word.text)) {
      index += 1;
      // env 的 VAR=value 前缀
      while (
        index < words.length &&
        /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]?.text ?? "")
      ) {
        index += 1;
      }
      continue;
    }
    break;
  }

  const command = words[index];
  if (command === undefined) {
    return { name: null, args: [], dynamic: false, raw };
  }
  return {
    name: isDynamic(command) ? null : command.text,
    args: words.slice(index + 1),
    dynamic: isDynamic(command),
    raw: command.text,
  };
};

const literalWords = (segment: ShellSegment): string[] =>
  segment.words.map((word) => word.text);

/** 这一段的 stdout 是否落到了文件（`> f`、`>> f`、`&> f`）。 */
export const segmentWritesStdoutToFile = (segment: ShellSegment): boolean =>
  segment.redirects.some(
    (redirect) =>
      (redirect.operator === ">" ||
        redirect.operator === ">>" ||
        redirect.operator === "&>" ||
        redirect.operator === "&>>") &&
      (redirect.fd === undefined || redirect.fd === 1) &&
      !redirect.targetDynamic &&
      redirect.target !== undefined,
  );

export const segmentHeredocBodies = (segment: ShellSegment): string[] =>
  segment.redirects
    .map((redirect) => redirect.heredoc?.body)
    .filter((body): body is string => body !== undefined);

/** `2>` / `2>&1`：数字词与后面的重定向操作符之间没有空白。 */
const isFdPrefix = (tokens: ShellToken[], index: number): boolean => {
  const token = tokens[index];
  const next = tokens[index + 1];
  if (token === undefined || next === undefined) return false;
  if (token.kind !== "word" || !/^[0-9]+$/.test(token.text)) return false;
  if (next.kind !== "operator" || !REDIRECT_OPERATORS.has(next.operator)) {
    return false;
  }
  return token.end === next.start;
};

const buildAnalysis = (source: string, depth: number): ShellAnalysis => {
  const { tokens, errors } = tokenizeShell(source);
  const segments: ShellSegment[] = [];
  const unresolved: ShellUnresolved[] = [];
  const nested: ShellAnalysis[] = [];

  let words: ShellWordToken[] = [];
  let redirects: ShellRedirect[] = [];
  let structure: string[] = [];
  let pendingRedirect: ShellOperator | null = null;
  let pendingRedirectIndex = -1;
  let joiner: ShellOperator | null = null;
  /** `2>` 已经被识别成 fd，等重定向操作符出现时落到 redirect 上。 */
  let pendingFd: number | null = null;

  const flushSegment = (): void => {
    if (words.length === 0 && redirects.length === 0) return;
    const segment: ShellSegment = {
      joiner,
      words,
      redirects,
      structure,
      raw: words.map((word) => word.raw).join(" "),
    };
    segments.push(segment);

    const command = effectiveCommand(segment);
    if (command.dynamic) {
      unresolved.push({
        kind: "dynamic-command",
        segmentIndex: segments.length - 1,
        raw: segment.raw,
      });
    } else if (depth < MAX_NESTING_DEPTH && command.name !== null) {
      if (SHELL_NAMES.has(command.name)) {
        collectNestedScript(segment, command.args);
      } else if (command.name === "eval") {
        // eval 的脚本文本就是它的第一个参数
        collectNestedScript(segment, command.args, "eval-dynamic", 0);
      }
    }

    words = [];
    redirects = [];
    structure = [];
    joiner = null;
  };

  /** `sh -c "<script>"` / `eval "<script>"`：字面量脚本递归解析，动态则记 unresolved。 */
  const collectNestedScript = (
    segment: ShellSegment,
    args: ShellWordToken[],
    dynamicKind:
      | "nested-shell-dynamic"
      | "eval-dynamic" = "nested-shell-dynamic",
    scriptIndex?: number,
  ): void => {
    const index = scriptIndex ?? args.findIndex((arg) => arg.text === "-c") + 1;
    const script = index >= 0 ? args[index] : undefined;
    if (script === undefined) {
      return;
    }
    if (script.dynamic) {
      unresolved.push({
        kind: dynamicKind,
        segmentIndex: segments.length - 1,
        raw: segment.raw,
      });
      return;
    }
    nested.push(buildAnalysis(script.text, depth + 1));
  };

  for (const [tokenIndex, token] of tokens.entries()) {
    if (token.kind === "newline") {
      flushSegment();
      joiner = null;
      continue;
    }
    if (token.kind === "heredoc") {
      const target = redirects[redirects.length - 1];
      if (target !== undefined && target.heredoc === undefined) {
        target.heredoc = { delimiter: token.delimiter, body: token.body };
      }
      continue;
    }
    if (token.kind === "operator") {
      if (REDIRECT_OPERATORS.has(token.operator)) {
        pendingRedirect = token.operator;
        redirects.push({
          operator: token.operator,
          targetDynamic: false,
          ...(pendingFd === null ? {} : { fd: pendingFd }),
        });
        pendingFd = null;
        pendingRedirectIndex = redirects.length - 1;
        continue;
      }
      flushSegment();
      joiner = token.operator;
      continue;
    }
    // word：紧贴后面那个重定向操作符的数字是文件描述符（`2>`、`2>&1`），不是参数
    if (isFdPrefix(tokens, tokenIndex) && !token.quoted && !token.dynamic) {
      pendingFd = Number.parseInt(token.text, 10);
      continue;
    }
    if (pendingRedirect !== null) {
      const redirect =
        pendingRedirectIndex >= 0 ? redirects[pendingRedirectIndex] : undefined;
      if (redirect !== undefined) {
        redirect.target = token;
        redirect.targetDynamic = token.dynamic;
      }
      pendingRedirect = null;
      pendingRedirectIndex = -1;
      continue;
    }
    if (STRUCTURE_KEYWORDS.has(token.text)) {
      structure.push(token.text);
    }
    words.push(token);
  }
  flushSegment();

  const allStructure = [
    ...segments.flatMap((segment) => segment.structure),
    ...nested.flatMap((child) => child.structure),
  ];

  return {
    source,
    segments,
    nested,
    unresolved: [...unresolved, ...nested.flatMap((child) => child.unresolved)],
    errors: [...errors, ...nested.flatMap((child) => child.errors)],
    structure: allStructure,
  };
};

export const analyzeShell = (source: string): ShellAnalysis =>
  buildAnalysis(source, 0);

/** 所有命令段，含嵌套脚本里的；`depth` 0 是最外层。 */
export type FlatSegment = { segment: ShellSegment; depth: number };

export const commandSegments = (analysis: ShellAnalysis): FlatSegment[] => {
  const own = analysis.segments.map((segment) => ({ segment, depth: 0 }));
  const children = analysis.nested.flatMap((child) =>
    commandSegments(child).map(({ segment, depth }) => ({
      segment,
      depth: depth + 1,
    })),
  );
  return [...own, ...children];
};

export const structureOf = (analysis: ShellAnalysis): string[] =>
  analysis.structure;

export const hasLoopStructure = (analysis: ShellAnalysis): boolean =>
  analysis.structure.some(
    (keyword) =>
      keyword === "for" || keyword === "while" || keyword === "until",
  );

export const literalText = (segment: ShellSegment): string =>
  literalWords(segment).join(" ");
