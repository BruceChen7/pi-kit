/**
 * 语义逐条对齐实测过的参考实现：
 * - 样式位与重置码对齐 `pi-tui/dist/utils.js` 的 `AnsiCodeTracker`
 * - 颜色覆盖 16 / 256 / truecolor，hex 换算对齐 pi 的 `ansi-to-html.js`
 * - **每行独立解析**：pi-web 每行一个 `<AnsiText>`（各自 `new AnsiUp()`），状态不跨行，
 *   Android 必须与它一致，否则同一份扩展输出两端长得不一样。
 */

export type AnsiColor =
  | { type: "basic"; index: number }
  | { type: "indexed"; index: number }
  | { type: "rgb"; r: number; g: number; b: number };

/**
 * `inverse` 由宿主自己换色（nsh 的 Text 没有 inverse，见 designs B02 的高亮用法）。
 */
export type AnsiStyle = {
  color?: AnsiColor;
  backgroundColor?: AnsiColor;
  bold?: true;
  dim?: true;
  italic?: true;
  underline?: true;
  strikethrough?: true;
  inverse?: true;
  blink?: true;
  hidden?: true;
  link?: string;
};

export type AnsiSegment = { text: string; style: AnsiStyle };

const ESC = "\x1B";
const BEL = "\x07";
const CURSOR_MARKER_RE = new RegExp(`${ESC}_pi:c${BEL}`, "g");
/** 通用 ANSI 转义（stripping 用）。OSC 必须排在两字符转义之前，否则 `ESC ]` 会先被吃掉。 */
const ANSI_ESCAPE_RE = new RegExp(
  `${ESC}(?:\\](?:[^${BEL}${ESC}]|${ESC}(?!\\\\))*(?:${BEL}|${ESC}\\\\)|\\[[0-?]*[ -/]*[@-~]|[@-Z\\\\-_])`,
  "g",
);

const STANDARD_COLORS = [
  "#000000",
  "#800000",
  "#008000",
  "#808000",
  "#000080",
  "#800080",
  "#008080",
  "#c0c0c0",
  "#808080",
  "#ff0000",
  "#00ff00",
  "#ffff00",
  "#0000ff",
  "#ff00ff",
  "#00ffff",
  "#ffffff",
] as const;

type MutableStyle = {
  color?: AnsiColor;
  backgroundColor?: AnsiColor;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  inverse: boolean;
  blink: boolean;
  hidden: boolean;
  link?: string;
};

const createStyle = (): MutableStyle => ({
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  strikethrough: false,
  inverse: false,
  blink: false,
  hidden: false,
});

const resetStyle = (style: MutableStyle): void => {
  style.color = undefined;
  style.backgroundColor = undefined;
  style.bold = false;
  style.dim = false;
  style.italic = false;
  style.underline = false;
  style.strikethrough = false;
  style.inverse = false;
  style.blink = false;
  style.hidden = false;
  // SGR reset 不动 OSC 8 链接（与 pi-tui 一致）。
};

const snapshot = (style: MutableStyle): AnsiStyle => {
  const next: AnsiStyle = {};
  if (style.color) next.color = style.color;
  if (style.backgroundColor) next.backgroundColor = style.backgroundColor;
  if (style.bold) next.bold = true;
  if (style.dim) next.dim = true;
  if (style.italic) next.italic = true;
  if (style.underline) next.underline = true;
  if (style.strikethrough) next.strikethrough = true;
  if (style.inverse) next.inverse = true;
  if (style.blink) next.blink = true;
  if (style.hidden) next.hidden = true;
  if (style.link) next.link = style.link;
  return next;
};

const sameColor = (left?: AnsiColor, right?: AnsiColor): boolean => {
  if (left === right) return true;
  if (!left || !right || left.type !== right.type) return false;
  if (left.type === "rgb" && right.type === "rgb") {
    return left.r === right.r && left.g === right.g && left.b === right.b;
  }
  if (left.type !== "rgb" && right.type !== "rgb") {
    return left.index === right.index;
  }
  return false;
};

const sameStyle = (left: AnsiStyle, right: AnsiStyle): boolean =>
  sameColor(left.color, right.color) &&
  sameColor(left.backgroundColor, right.backgroundColor) &&
  left.bold === right.bold &&
  left.dim === right.dim &&
  left.italic === right.italic &&
  left.underline === right.underline &&
  left.strikethrough === right.strikethrough &&
  left.inverse === right.inverse &&
  left.blink === right.blink &&
  left.hidden === right.hidden &&
  left.link === right.link;

const appendSegment = (
  segments: AnsiSegment[],
  text: string,
  style: AnsiStyle,
): void => {
  if (!text) return;
  const last = segments[segments.length - 1];
  if (last && sameStyle(last.style, style)) {
    last.text += text;
    return;
  }
  segments.push({ text, style });
};

const colorFromBasic = (code: number): AnsiColor => ({
  type: "basic",
  index: code >= 90 ? code - 90 + 8 : code - 30,
});

const colorFromBackgroundBasic = (code: number): AnsiColor => ({
  type: "basic",
  index: code >= 100 ? code - 100 + 8 : code - 40,
});

const applySgr = (params: string, style: MutableStyle): void => {
  const parts = params.split(";");
  let i = 0;

  const readNumber = (raw: string | undefined): number | undefined => {
    if (raw === undefined) return undefined;
    if (raw === "") return 0;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  };

  while (i < parts.length) {
    const code = readNumber(parts[i]);
    if (code === undefined) {
      i += 1;
      continue;
    }

    if (code === 38 || code === 48) {
      const mode = parts[i + 1];
      if (mode === "5") {
        const index = readNumber(parts[i + 2]);
        if (index !== undefined) {
          const color: AnsiColor = { type: "indexed", index };
          if (code === 38) style.color = color;
          else style.backgroundColor = color;
          i += 3;
        } else {
          // 38;5 缺索引：整段忽略，别把 5 当成 blink。
          i += 2;
        }
        continue;
      }
      if (mode === "2") {
        const r = readNumber(parts[i + 2]);
        const g = readNumber(parts[i + 3]);
        const b = readNumber(parts[i + 4]);
        if (r !== undefined && g !== undefined && b !== undefined) {
          const color: AnsiColor = { type: "rgb", r, g, b };
          if (code === 38) style.color = color;
          else style.backgroundColor = color;
          i += 5;
        } else {
          i += 2;
        }
        continue;
      }
      i += 1;
      continue;
    }

    switch (code) {
      case 0:
        resetStyle(style);
        break;
      case 1:
        style.bold = true;
        break;
      case 2:
        style.dim = true;
        break;
      case 3:
        style.italic = true;
        break;
      case 4:
        style.underline = true;
        break;
      case 5:
        style.blink = true;
        break;
      case 7:
        style.inverse = true;
        break;
      case 8:
        style.hidden = true;
        break;
      case 9:
        style.strikethrough = true;
        break;
      case 21:
        style.bold = false;
        break;
      case 22:
        style.bold = false;
        style.dim = false;
        break;
      case 23:
        style.italic = false;
        break;
      case 24:
        style.underline = false;
        break;
      case 25:
        style.blink = false;
        break;
      case 27:
        style.inverse = false;
        break;
      case 28:
        style.hidden = false;
        break;
      case 29:
        style.strikethrough = false;
        break;
      case 39:
        style.color = undefined;
        break;
      case 49:
        style.backgroundColor = undefined;
        break;
      default:
        if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
          style.color = colorFromBasic(code);
        } else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
          style.backgroundColor = colorFromBackgroundBasic(code);
        }
        break;
    }
    i += 1;
  }
};

const findTerminator = (
  line: string,
  from: number,
): { end: number; next: number } => {
  const bel = line.indexOf(BEL, from);
  const st = line.indexOf(`${ESC}\\`, from);
  const candidates = [bel, st].filter((value) => value >= 0);
  if (candidates.length === 0) return { end: line.length, next: line.length };
  const end = Math.min(...candidates);
  return { end, next: end + (end === st ? 2 : 1) };
};

/**
 * 处理 `line[index]` 处的一个转义序列，返回消费掉的字符数。
 * 任何情况下都返回 >= 1，保证扫描前进。
 */
const applyEscape = (
  line: string,
  index: number,
  style: MutableStyle,
): number => {
  const next = line[index + 1];

  if (next === "]") {
    const { end, next: after } = findTerminator(line, index + 2);
    const body = line.slice(index + 2, end);
    if (body.startsWith("8;")) {
      const uri = body.slice(body.indexOf(";", 2) + 1);
      if (uri) style.link = uri;
      else style.link = undefined;
    }
    return Math.max(1, after - index);
  }

  if (next === "_" || next === "P" || next === "^" || next === "X") {
    const { next: after } = findTerminator(line, index + 2);
    return Math.max(1, after - index);
  }

  if (next === "[") {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 终端转义序列本来就以 ESC 开头
    const match = /^\x1B\[([0-?]*)[ -/]*([@-~])/.exec(line.slice(index));
    if (!match) return line.length - index;
    const [, params = "", final = ""] = match;
    if (final === "m") applySgr(params, style);
    return match[0].length;
  }

  if (next === undefined) return 1;
  return 2;
};

/** 解析一行 ANSI 文本；每行状态独立（与 pi-web 的逐行渲染一致）。 */
export const parseAnsiLine = (line: string): AnsiSegment[] => {
  const segments: AnsiSegment[] = [];
  const style = createStyle();
  let index = 0;

  while (index < line.length) {
    const escapeAt = line.indexOf(ESC, index);
    if (escapeAt < 0) {
      appendSegment(segments, line.slice(index), snapshot(style));
      break;
    }
    if (escapeAt > index) {
      appendSegment(segments, line.slice(index, escapeAt), snapshot(style));
    }
    index = escapeAt + applyEscape(line, escapeAt, style);
  }

  return segments;
};

export const parseAnsiLines = (lines: string[]): AnsiSegment[][] =>
  lines.map(parseAnsiLine);

export const stripAnsi = (text: string): string =>
  text.replace(CURSOR_MARKER_RE, "").replace(ANSI_ESCAPE_RE, "");

const clampByte = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  return Math.min(255, Math.max(0, Math.round(value)));
};

const toHex = (value: number): string =>
  clampByte(value).toString(16).padStart(2, "0");

export const ansiColorToHex = (color: AnsiColor): string => {
  if (color.type === "rgb") {
    return `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`;
  }
  const index = Math.max(0, Math.round(color.index));
  if (index < 16) return STANDARD_COLORS[index] ?? "#000000";
  if (index < 232) {
    const cube = index - 16;
    const levels = [0, 95, 135, 175, 215, 255];
    return `#${toHex(levels[Math.floor(cube / 36)] ?? 0)}${toHex(
      levels[Math.floor((cube % 36) / 6)] ?? 0,
    )}${toHex(levels[cube % 6] ?? 0)}`;
  }
  const gray = 8 + (index - 232) * 10;
  return `#${toHex(gray)}${toHex(gray)}${toHex(gray)}`;
};
