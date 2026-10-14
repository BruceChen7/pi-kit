/**
 * pi-web-host-fixture — pi-web 的**宿主契约替身**（只在测试里用）。
 *
 * 不是 mock 编排：这里复刻的是 pi-web 对扩展真正做出的承诺，逐条对照过
 * `pi-web@0.12.1` 的源码，改这个文件前请重新对照：
 *
 * | 复刻对象 | pi-web 源码 |
 * |---|---|
 * | `ctx.ui` 的真实现 + no-op 清单 | `lib/rpc-manager.ts:1859-1985` |
 * | `custom()` 的结果语义（含各种 `undefined` 分支） | `lib/rpc-manager.ts:1737-1804` |
 * | headless TUI stub（92×40，只有 terminal + requestRender） | `lib/custom-ui-terminal.ts:1-27` |
 * | 面板行去框/去光标标记/去尾空格 | `lib/ansi.ts:58-88` |
 * | 无色主题 | `lib/rpc-manager.ts:229-254`（PLAIN_TEXT_THEME） |
 * | 按键编码 | `lib/terminal-input.ts`（无 Kitty CSI-u，只有裸文本/功能键/paste） |
 *
 * 两个刻意的“更严格”之处（这正是它作为测试替身的意义）：
 * 1. `tui` 是 **strict Proxy**：除了 `terminal` / `requestRender`，访问任何属性
 *    都抛错 —— 组件一旦依赖真实 TUI（`stop()`/`setFocus()`/…）当场暴露。
 * 2. `normalizeCustomPanelLines` 与 `piWebKeys` 是可断言的：测试能直接检查
 *    “我们的行在 pi-web 里会不会被撕掉”“按键回放是否等价”。
 */

import type {
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { customPanel, type PanelFactory } from "./rich-ui.ts";
import { PI_WEB_HOST_SYMBOL } from "./ui-host.ts";

export const PI_WEB_COLUMNS = 92;
export const PI_WEB_ROWS = 40;

/** pi 的硬件光标标记；pi-web 会在渲染前删掉它。 */
export const TUI_CURSOR_MARKER = "\x1b_pi:c\x07";
const CURSOR_MARKER_RE = new RegExp(
  TUI_CURSOR_MARKER.replace("\x1b", "\\x1B"),
  "g",
);
// biome-ignore lint/suspicious/noControlCharactersInRegex: 终端转义序列本来就以 ESC 开头
const ANSI_RE = /\x1B(?:\[[0-9;?]*[ -/]*[@-~]|_[^\x07]*\x07|[@-Z\\-_])/g;
const FIRST_VISIBLE_CHAR_RE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 同上
  /^(?:\x1B(?:\[[0-9;?]*[ -/]*[@-~]|_[^\x07]*\x07|[@-Z\\-_])*)([\s\S])/;
const HORIZONTAL_FRAME_LINE = /^[┌├└╭╰][─┬┴┼]+[┐┤┘╮╯]$/;

/** pi-web 的无色主题：所有修饰原样返回。 */
export const PLAIN_TEXT_THEME = {
  name: "plain-text-fixture",
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  inverse: (text: string) => text,
  strikethrough: (text: string) => text,
  getThinkingBorderColor: () => (text: string) => text,
  getBashModeBorderColor: () => (text: string) => text,
} as unknown as Theme;

export const stripAnsi = (text: string): string =>
  text.replace(CURSOR_MARKER_RE, "").replace(ANSI_RE, "");

type VisibleChar = { char: string; start: number; end: number };

/**
 * 可见字符（跳过 ANSI 序列）及其在原串中的位置。
 * 用 `nextCharIndex` 的原始位置而不是正则 exec，避免 lastIndex 状态。
 */
const visibleCharPositions = (text: string): VisibleChar[] => {
  const positions: VisibleChar[] = [];
  let index = 0;
  while (index < text.length) {
    if (text[index] === "\x1b") {
      const match = text.slice(index).match(FIRST_VISIBLE_CHAR_RE);
      const head = match?.[0] ?? "";
      const consumed = head.length - (match?.[1]?.length ?? 1);
      if (consumed > 0) {
        index += consumed;
        continue;
      }
    }
    positions.push({ char: text[index] ?? "", start: index, end: index + 1 });
    index += 1;
  }
  return positions;
};

const firstVisibleChar = (text: string): string | undefined =>
  FIRST_VISIBLE_CHAR_RE.exec(text)?.[1];

const removeVisibleCharAt = (text: string, index: number): string => {
  const target = visibleCharPositions(text)[index];
  return target ? text.slice(0, target.start) + text.slice(target.end) : text;
};

const lastNonSpaceVisibleCharIndex = (text: string): number => {
  const positions = visibleCharPositions(text);
  for (let i = positions.length - 1; i >= 0; i -= 1) {
    if ((positions[i]?.char ?? "").trim() !== "") return i;
  }
  return -1;
};

const trimEndVisibleSpaces = (text: string): string => {
  let next = text;
  for (;;) {
    const positions = visibleCharPositions(next);
    const last = positions[positions.length - 1];
    if (last === undefined || last.char.trim() !== "") return next;
    next = next.slice(0, last.start) + next.slice(last.end);
  }
};

/**
 * pi-web `lib/ansi.ts:58-88` 的逐字复刻：整行丢框、剥左右竖线、删光标标记、
 * 去尾空格、去首尾空行。测试拿它当“浏览器实际看到什么”的判据。
 */
export const normalizeCustomPanelLines = (lines: string[]): string[] => {
  const normalized: string[] = [];

  for (const rawLine of lines) {
    const lineWithoutCursor = rawLine.replace(CURSOR_MARKER_RE, "");
    const plain = stripAnsi(lineWithoutCursor).trimEnd();
    if (HORIZONTAL_FRAME_LINE.test(plain)) continue;

    let line = lineWithoutCursor;
    const first = firstVisibleChar(line);
    if (first === "│" || first === "┃") {
      line = removeVisibleCharAt(line, 0);
      if (firstVisibleChar(line) === " ") line = removeVisibleCharAt(line, 0);
    }

    const rightBorderIndex = lastNonSpaceVisibleCharIndex(line);
    const rightBorder =
      rightBorderIndex >= 0
        ? visibleCharPositions(line)[rightBorderIndex]?.char
        : undefined;
    if (rightBorder === "│" || rightBorder === "┃") {
      line = removeVisibleCharAt(line, rightBorderIndex);
    }

    normalized.push(trimEndVisibleSpaces(line));
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
  return normalized.length ? normalized : lines;
};

/** pi-web `lib/terminal-input.ts` 的按键表（无 Kitty CSI-u）。 */
export const piWebKeys = {
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  home: "\x1b[H",
  end: "\x1b[F",
  pageUp: "\x1b[5~",
  pageDown: "\x1b[6~",
  delete: "\x1b[3~",
  escape: "\x1b",
  backspace: "\x7f",
  enter: "\r",
  shiftEnter: "\n",
  tab: "\t",
  shiftTab: "\x1b[Z",
  space: " ",
  text: (value: string) => value,
  paste: (value: string) => `\x1b[200~${value}\x1b[201~`,
};

/**
 * pi-web 的 headless TUI：只有 `terminal` 与 `requestRender`。
 * strict Proxy 让“碰了别的属性”立刻变成测试失败，而不是在浏览器里静默失灵。
 */
export const createStrictPiWebTui = (): {
  tui: TUI;
  touched: () => string[];
} => {
  const touched: string[] = [];
  const target = {
    terminal: Object.freeze({
      columns: PI_WEB_COLUMNS,
      rows: PI_WEB_ROWS,
      kittyProtocolActive: false as const,
    }),
    requestRender: () => {},
  };
  const tui = new Proxy(target, {
    get(object, prop, receiver) {
      if (prop === "terminal" || prop === "requestRender") {
        return Reflect.get(object, prop, receiver);
      }
      touched.push(String(prop));
      throw new Error(
        `pi-web's headless TUI has no \`${String(prop)}\`: extension components may only use render(width)/handleInput()/requestRender()`,
      );
    },
  }) as unknown as TUI;
  return { tui, touched: () => [...touched] };
};

/** 宿主侧真正收到的 factory 形状：4 个参数（适配后的 5 参版本由 customPanel 包装）。 */
type HostPanelFactory<T> = (
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  done: (value: T) => void,
) => Component | Promise<Component>;

export type PiWebPanelRun<T> = {
  /** 组件渲染出的行（扩展自绘）。 */
  lines: () => string[];
  /** 经 pi-web 去框处理后浏览器实际显示的行。 */
  visibleLines: () => string[];
  input: (data: string) => void;
  closed: () => boolean;
  /** 与 pi-web 一致：`custom()` 的 Promise 在面板关闭后结算。 */
  result: Promise<T>;
  /** 模拟宿主关掉面板（Stop / 会话销毁）：之后不再渲染。 */
  close: () => void;
  /** strict stub 被越界访问过的属性。 */
  forbiddenTouches: () => string[];
  /** 组件是否已被 dispose。 */
  disposed: () => boolean;
};

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
};

/**
 * 按 pi-web 的契约开一个面板：真渲染一次、可回放按键、`done()` 结算；
 * factory 抛错或返回非组件时与 pi-web 一样给出 `undefined`。
 */
export const openPiWebPanel = async <T>(
  factory: PanelFactory<T>,
): Promise<PiWebPanelRun<T>> => {
  let component: (Component & { dispose?: () => void }) | undefined;
  let closed = false;
  let disposed = false;
  const { tui, touched } = createStrictPiWebTui();

  let resolveResult: (value: T) => void = () => {};
  const result = new Promise<T>((resolve) => {
    resolveResult = resolve;
  });

  const ctx = {
    hasUI: true,
    mode: "rpc",
    ui: {
      custom: (f: HostPanelFactory<T>): Promise<T> =>
        new Promise<T>((resolve) => {
          const done = (value: T) => {
            closed = true;
            disposed = true;
            resolve(value);
            resolveResult(value);
          };
          Promise.resolve()
            .then(() =>
              f(tui, PLAIN_TEXT_THEME, {} as KeybindingsManager, done),
            )
            .then((built) => {
              if (closed) {
                (built as { dispose?: () => void } | undefined)?.dispose?.();
                return;
              }
              if (
                !built ||
                typeof built !== "object" ||
                typeof (built as { render?: unknown }).render !== "function"
              ) {
                closed = true;
                resolve(undefined as T);
                resolveResult(undefined as T);
                return;
              }
              component = built as Component & { dispose?: () => void };
            })
            .catch(() => {
              closed = true;
              resolve(undefined as T);
              resolveResult(undefined as T);
            });
        }),
    },
  };

  void customPanel<T>(ctx as never, factory);
  await flush();

  return {
    lines: () => (component && !closed ? component.render(PI_WEB_COLUMNS) : []),
    visibleLines: () =>
      normalizeCustomPanelLines(
        component && !closed ? component.render(PI_WEB_COLUMNS) : [],
      ),
    input: (data: string) => {
      if (!component || closed) return;
      component.handleInput?.(data);
    },
    closed: () => closed,
    result,
    close: () => {
      component?.dispose?.();
      disposed = true;
      closed = true;
    },
    forbiddenTouches: () => touched(),
    disposed: () => disposed,
  };
};

export const markPiWebHost = (): void => {
  (globalThis as Record<PropertyKey, unknown>)[PI_WEB_HOST_SYMBOL] = {
    version: 1,
  };
};

export const clearPiWebHost = (): void => {
  delete (globalThis as Record<PropertyKey, unknown>)[PI_WEB_HOST_SYMBOL];
};
