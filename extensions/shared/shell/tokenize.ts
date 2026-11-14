/**
 * Shell 的词法层：把一条命令切成词、操作符、重定向与 heredoc 正文。
 *
 * 这一层不判断"该不该拦"，只回答"这条命令长什么样"，供 analyze.ts 组结构，
 * 再供护栏查询（ADR-0001 D3）。它同时记录每个词的可静态求值性：`"$CMD"` 这种
 * 值由运行时决定的词标成 dynamic，护栏据此决定是拒绝还是保守放行。
 */

export type ShellOperator =
  | "|"
  | "||"
  | "&&"
  | "&"
  | ";"
  | "("
  | ")"
  | ">"
  | ">>"
  | "&>"
  | "&>>"
  | "<"
  | "<<"
  | "<<-"
  | "<<<"
  | ">&";

export type ShellWordToken = {
  kind: "word";
  /** 词的起止偏移，用来判断 `2>` 这种紧贴的重定向文件描述符。 */
  start: number;
  end: number;
  /** 去掉引号后的可见文本；动态片段不展开，只留可静态求值的部分。 */
  text: string;
  /** 原始写法，供 reason 引用。 */
  raw: string;
  /** 是否有引号包住的字面量。 */
  quoted: boolean;
  /** 是否含 $VAR / $(...) / `...`，静态求不出完整值。 */
  dynamic: boolean;
};

export type ShellOperatorToken = {
  kind: "operator";
  operator: ShellOperator;
  raw: string;
  start: number;
  end: number;
};

export type ShellNewlineToken = { kind: "newline" };

export type ShellHeredocToken = {
  kind: "heredoc";
  delimiter: string;
  body: string;
  /** 正文（含分隔行）在原字符串里的起止偏移，供"剥掉 heredoc"复用同一套判定。 */
  bodyStart: number;
  bodyEnd: number;
};

export type ShellToken =
  | ShellWordToken
  | ShellOperatorToken
  | ShellNewlineToken
  | ShellHeredocToken;

export type ShellTokenizeResult = {
  tokens: ShellToken[];
  errors: string[];
};

/** 最长优先，否则 `>>` 会被读成 `>` `>`。 */
const OPERATORS: readonly ShellOperator[] = [
  "&>>",
  "<<<",
  "<<-",
  ">>",
  ">&",
  "&&",
  "||",
  "&>",
  "<<",
  ">",
  "<",
  "|",
  ";",
  "&",
  "(",
  ")",
];

export const HEREDOC_OPERATORS: ReadonlySet<ShellOperator> = new Set([
  "<<",
  "<<-",
]);

export const REDIRECT_OPERATORS: ReadonlySet<ShellOperator> = new Set([
  ">",
  ">>",
  "&>",
  "&>>",
  "<",
  "<<",
  "<<-",
  "<<<",
  ">&",
]);

const isWhitespace = (char: string): boolean =>
  char === " " || char === "\t" || char === "\r";

const matchOperator = (source: string, at: number): ShellOperator | null => {
  for (const operator of OPERATORS) {
    if (source.startsWith(operator, at)) {
      return operator;
    }
  }
  return null;
};

type PendingHeredoc = { delimiter: string; stripTabs: boolean };

/** 跳过 `$(...)`：里面是命令替换，值不可静态求值。返回结束位置之后。 */
const skipBalancedParens = (source: string, openAt: number): number => {
  let depth = 0;
  let index = openAt;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  return source.length;
};

/** 跳过 `${...}`。 */
const skipBraces = (source: string, openAt: number): number => {
  let depth = 0;
  let index = openAt;
  while (index < source.length) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  return source.length;
};

type WordState = {
  start: number;
  text: string;
  raw: string;
  quoted: boolean;
  dynamic: boolean;
  started: boolean;
};

const emptyWord = (start = -1): WordState => ({
  start,
  text: "",
  raw: "",
  quoted: false,
  dynamic: false,
  started: false,
});

export function tokenizeShell(source: string): ShellTokenizeResult {
  const tokens: ShellToken[] = [];
  const errors: string[] = [];
  const pendingHeredocs: PendingHeredoc[] = [];
  let awaitingHeredoc: { stripTabs: boolean } | null = null;

  let index = 0;
  let word = emptyWord();

  const pushWord = (): void => {
    if (!word.started) return;
    tokens.push({
      kind: "word",
      start: word.start,
      end: word.start + word.raw.length,
      text: word.text,
      raw: word.raw,
      quoted: word.quoted,
      dynamic: word.dynamic,
    });
    if (awaitingHeredoc !== null) {
      pendingHeredocs.push({
        delimiter: word.text,
        stripTabs: awaitingHeredoc.stripTabs,
      });
      awaitingHeredoc = null;
    }
    word = emptyWord();
  };

  /** heredoc 正文从下一行的行首开始，读到分隔行结束；正文不参与词法分析。 */
  const consumeHeredocBodies = (): void => {
    let cursor = index;
    for (const pending of pendingHeredocs) {
      const bodyStart = cursor;
      const bodyLines: string[] = [];
      while (cursor < source.length) {
        const lineEnd = source.indexOf("\n", cursor);
        const line =
          lineEnd === -1 ? source.slice(cursor) : source.slice(cursor, lineEnd);
        const candidate = pending.stripTabs ? line.replace(/^\t+/, "") : line;
        cursor = lineEnd === -1 ? source.length : lineEnd + 1;
        if (candidate.trim() === pending.delimiter) break;
        bodyLines.push(line);
      }
      tokens.push({
        kind: "heredoc",
        delimiter: pending.delimiter,
        body: bodyLines.join("\n"),
        bodyStart,
        bodyEnd: cursor,
      });
    }
    pendingHeredocs.length = 0;
    index = cursor;
  };

  while (index < source.length) {
    const char = source[index] ?? "";

    if (char === "\\") {
      const next = source[index + 1] ?? "";
      if (next === "\n") {
        index += 2;
        continue;
      }
      if (next !== "") {
        if (!word.started) word.start = index;
        word.raw += `\\${next}`;
        word.text += next;
        word.started = true;
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }

    if (char === "'") {
      const end = source.indexOf("'", index + 1);
      if (end === -1) {
        errors.push("unterminated single quote");
        index = source.length;
        break;
      }
      if (!word.started) word.start = index;
      word.text += source.slice(index + 1, end);
      word.raw += source.slice(index, end + 1);
      word.quoted = true;
      word.started = true;
      index = end + 1;
      continue;
    }

    if (char === '"') {
      if (!word.started) word.start = index;
      let cursor = index + 1;
      let closed = false;
      while (cursor < source.length) {
        const inner = source[cursor] ?? "";
        if (inner === "\\") {
          word.text += source[cursor + 1] ?? "";
          cursor += 2;
          continue;
        }
        if (inner === '"') {
          closed = true;
          break;
        }
        if (inner === "$" || inner === "`") {
          word.dynamic = true;
        }
        word.text += inner;
        cursor += 1;
      }
      word.raw += source.slice(index, cursor + 1);
      word.quoted = true;
      word.started = true;
      if (!closed) {
        errors.push("unterminated double quote");
      }
      index = cursor + 1;
      continue;
    }

    if (char === "`") {
      if (!word.started) word.start = index;
      const end = source.indexOf("`", index + 1);
      word.dynamic = true;
      word.started = true;
      word.raw += source.slice(index, end === -1 ? source.length : end + 1);
      if (end === -1) {
        errors.push("unterminated backtick");
        index = source.length;
        break;
      }
      index = end + 1;
      continue;
    }

    if (char === "$" && source[index + 1] === "(") {
      if (!word.started) word.start = index;
      const end = skipBalancedParens(source, index + 1);
      word.dynamic = true;
      word.started = true;
      word.raw += source.slice(index, end);
      index = end;
      continue;
    }

    if (char === "$" && source[index + 1] === "{") {
      if (!word.started) word.start = index;
      const end = skipBraces(source, index + 1);
      word.dynamic = true;
      word.started = true;
      word.raw += source.slice(index, end);
      index = end;
      continue;
    }

    if (char === "$") {
      // $VAR / $1 / $? —— 值不可静态求值
      if (!word.started) word.start = index;
      word.dynamic = true;
      word.started = true;
      word.raw += char;
      index += 1;
      continue;
    }

    if (char === "#" && !word.started) {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }

    if (isWhitespace(char)) {
      pushWord();
      index += 1;
      continue;
    }

    if (char === "\n") {
      pushWord();
      index += 1;
      if (pendingHeredocs.length > 0) {
        consumeHeredocBodies();
        continue;
      }
      tokens.push({ kind: "newline" });
      continue;
    }

    const operator = matchOperator(source, index);
    if (operator !== null) {
      pushWord();
      tokens.push({
        kind: "operator",
        operator,
        raw: operator,
        start: index,
        end: index + operator.length,
      });
      index += operator.length;
      if (HEREDOC_OPERATORS.has(operator)) {
        awaitingHeredoc = { stripTabs: operator === "<<-" };
      }
      continue;
    }

    if (!word.started) word.start = index;
    word.text += char;
    word.raw += char;
    word.started = true;
    index += 1;
  }

  pushWord();
  if (pendingHeredocs.length > 0) {
    consumeHeredocBodies();
  }

  return { tokens, errors };
}
