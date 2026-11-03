/**
 * custom-panel-lines — 把扩展 `render(width)` 画出来的「带框」面板，规整成宿主可直接
 * 摆进自己容器里的文本行（Functional Core：value in / value out）。
 *
 * 逐条对齐 pi-web `lib/ansi.ts:58-88` 的语义：
 * - 整行都是横框（`┌───┐`）⇒ 丢掉
 * - 行首/行尾的竖线（`│` `┃`）⇒ 剥掉；行首竖线后紧跟的一个空格也剥掉
 * - TUI 光标标记（`ESC _ pi:c BEL`）⇒ 删掉
 * - 行尾可见空格 ⇒ 删掉（转义序列保留）
 * - 首尾空行 ⇒ 删掉；全被删光时回退成原行
 *
 * 为什么要共享：pi-web 与 nsh 宿主拿到的是同一份 `string[]`，两边必须剥得一样，
 * 否则同一个面板在两个宿主上的缩进和留白不同。宿主只负责排版，不负责二次清洗。
 */

import { stripAnsi } from "./ansi-segments.js";

const ESC = "\x1B";
const BEL = "\x07";

const CURSOR_MARKER_RE = new RegExp(`${ESC}_pi:c${BEL}`, "g");
/** 锚定在行首的转义序列（与 ansi-segments 的扫描规则一致）。 */
const ANSI_AT_RE = new RegExp(
  `^${ESC}(?:\\](?:[^${BEL}${ESC}]|${ESC}(?!\\\\))*(?:${BEL}|${ESC}\\\\)|\\[[0-?]*[ -/]*[@-~]|[@-Z\\\\-_])`,
);
const HORIZONTAL_FRAME_LINE = /^[┌├└╭╰][─┬┴┼]+[┐┤┘╮╯]$/;

/** 可见字符及其在原串里的位置（跳过转义序列）。 */
const visibleChars = (text: string): Array<{ char: string; at: number }> => {
  const chars: Array<{ char: string; at: number }> = [];
  let index = 0;
  while (index < text.length) {
    if (text[index] === ESC) {
      const match = ANSI_AT_RE.exec(text.slice(index));
      if (match) {
        index += match[0].length;
        continue;
      }
    }
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) break;
    const char = String.fromCodePoint(codePoint);
    chars.push({ char, at: index });
    index += char.length;
  }
  return chars;
};

const firstVisibleChar = (text: string): string | undefined =>
  visibleChars(text)[0]?.char;

const removeVisibleCharAt = (text: string, visibleIndex: number): string => {
  const chars = visibleChars(text);
  const target = chars[visibleIndex];
  if (!target) return text;
  return text.slice(0, target.at) + text.slice(target.at + target.char.length);
};

const lastNonSpaceVisibleIndex = (text: string): number => {
  const chars = visibleChars(text);
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    if ((chars[i]?.char ?? "").trim() !== "") return i;
  }
  return -1;
};

const trimTrailingSpaces = (text: string): string => {
  let next = text;
  for (;;) {
    const chars = visibleChars(next);
    const last = chars[chars.length - 1];
    if (last === undefined || last.char.trim() !== "") return next;
    next = removeVisibleCharAt(next, chars.length - 1);
  }
};

export const normalizeCustomPanelLines = (lines: string[]): string[] => {
  const normalized: string[] = [];

  for (const rawLine of lines) {
    const withoutCursor = rawLine.replace(CURSOR_MARKER_RE, "");
    if (HORIZONTAL_FRAME_LINE.test(stripAnsi(withoutCursor).trimEnd())) {
      continue;
    }

    let line = withoutCursor;
    const first = firstVisibleChar(line);
    if (first === "│" || first === "┃") {
      line = removeVisibleCharAt(line, 0);
      if (firstVisibleChar(line) === " ") line = removeVisibleCharAt(line, 0);
    }

    const rightIndex = lastNonSpaceVisibleIndex(line);
    const rightChar =
      rightIndex >= 0 ? visibleChars(line)[rightIndex]?.char : undefined;
    if (rightChar === "│" || rightChar === "┃") {
      line = removeVisibleCharAt(line, rightIndex);
    }

    normalized.push(trimTrailingSpaces(line));
  }

  while (
    normalized.length > 0 &&
    stripAnsi(normalized[0] ?? "").trim() === ""
  ) {
    normalized.shift();
  }
  while (
    normalized.length > 0 &&
    stripAnsi(normalized[normalized.length - 1] ?? "").trim() === ""
  ) {
    normalized.pop();
  }

  // 全被吃掉（比如只收到一条横框）：宁可把原样还给宿主，也不交一个空面板。
  return normalized.length > 0 ? normalized : lines;
};
