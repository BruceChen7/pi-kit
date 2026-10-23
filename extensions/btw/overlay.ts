// # btw overlay — top-center 展示组件（移植自 L2ncE/pi-btw，Apache-2.0）
//
// BtwOverlayComponent 是纯展示组件：读回调暴露的状态、Markdown 渲染、
// 处理输入（←→ 历史翻页 / ↑↓ 与滚轮滚动 / c 复制 / Esc 中止或关闭 / alt+/ 切焦点）。
// 组件本身不单测（纯渲染）；接线与状态在 index.ts。

import {
  getMarkdownTheme,
  type Theme,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type Focusable,
  Input,
  Key,
  Markdown,
  matchesKey,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { PanelChrome } from "../shared/ui-host.ts";
import {
  type BtwActive,
  type BtwExchange,
  type BtwSelection,
  clampScroll,
  FOLLOW_BOTTOM,
  isScrollable,
  type ScrollGeometry,
  type ScrollState,
  scrollByLines,
} from "./core.ts";

export interface BtwOverlayCallbacks {
  readExchanges: () => BtwExchange[];
  readActive: () => BtwActive | null;
  readViewIndex: () => number;
  readCurrent: () => BtwSelection | null;
  setViewIndex: (index: number) => void;
  onSubmit: (value: string) => void;
  onDismiss: () => void;
  onCopy: () => void;
  onUnfocus: () => void;
}

const BTW_FOCUS_KEYS = [Key.alt(Key.slash), Key.ctrlAlt("w")] as const;

function matchesBtwFocusKey(data: string): boolean {
  return BTW_FOCUS_KEYS.some((key) => matchesKey(data, key));
}

const CHROME_LINES = 7; // top border, title, rule, status, input, hints, bottom border
const MIN_CONTENT_LINES = 4;

/** 宿主管不了真实终端时用的行数（pi-web 的 headless stub 是 40）。 */
const FALLBACK_TERMINAL_ROWS = 30;

export type BtwOverlayOptions = {
  /** 外框策略：pi-web 这类宿主自带外框且会撕掉自绘的框 → "borderless"。 */
  chrome: PanelChrome;
  /** 宿主固定行数（pi-web 为 40）；undefined 时读真实终端。 */
  rows: number | undefined;
};

export class BtwOverlayComponent implements Component, Focusable {
  private readonly input = new Input();
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly callbacks: BtwOverlayCallbacks;
  private readonly chrome: PanelChrome;
  private readonly hostRows: number | undefined;
  private status = "";
  private scroll: ScrollState = FOLLOW_BOTTOM;
  /** 上一次 render 的可见窗口；滚轮按它换算，没有 render 过就不吃事件。 */
  private geometry: ScrollGeometry = { contentHeight: 0, maxRows: 0 };
  focused = false;

  constructor(
    tui: TUI,
    theme: Theme,
    callbacks: BtwOverlayCallbacks,
    options: BtwOverlayOptions = { chrome: "boxed", rows: undefined },
  ) {
    this.tui = tui;
    this.theme = theme;
    this.callbacks = callbacks;
    this.chrome = options.chrome;
    this.hostRows = options.rows;
    this.input.onSubmit = (value) => {
      // Keep the draft when the ask is rejected (still answering); the parent shows a hint.
      if (!this.callbacks.readActive()) this.input.setValue("");
      this.scroll = FOLLOW_BOTTOM;
      this.callbacks.onSubmit(value);
    };
  }

  setStatus(status: string): void {
    this.status = status;
    this.tui.requestRender();
  }

  refresh(): void {
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (matchesBtwFocusKey(data)) {
      this.callbacks.onUnfocus();
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.callbacks.onDismiss();
      return;
    }
    const inputEmpty = this.input.getValue().length === 0;
    if (inputEmpty) {
      if (matchesKey(data, Key.left)) {
        const index = this.callbacks.readViewIndex();
        if (!this.callbacks.readActive() && index > 0) {
          this.callbacks.setViewIndex(index - 1);
          this.scroll = { offset: this.scroll.offset, followBottom: false };
          this.tui.requestRender();
        }
        return;
      }
      if (matchesKey(data, Key.right)) {
        const exchanges = this.callbacks.readExchanges();
        const index = this.callbacks.readViewIndex();
        if (!this.callbacks.readActive() && index < exchanges.length - 1) {
          this.callbacks.setViewIndex(index + 1);
          this.tui.requestRender();
        }
        return;
      }
      if (data === "c" || data === "C") {
        this.callbacks.onCopy();
        return;
      }
      if (matchesKey(data, Key.up)) {
        this.moveScroll(-1);
        return;
      }
      if (matchesKey(data, Key.down)) {
        this.moveScroll(1);
        return;
      }
    }
    this.input.handleInput(data);
  }

  /**
   * 滚轮同样走这里。宿主的 fullscreen 渲染器把指针下的滚轮事件交给 overlay；
   * 不返回 handled 就会被当成没人要，转而滚背景 transcript。
   */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const lines = event.type === "wheel" ? event.wheelDelta : undefined;
    if (!lines) return undefined;
    const { contentHeight, maxRows } = this.geometry;
    if (!isScrollable(contentHeight, maxRows)) return undefined;
    this.moveScroll(lines);
    return { handled: true };
  }

  private moveScroll(lines: number): void {
    const { contentHeight, maxRows } = this.geometry;
    this.scroll = scrollByLines(this.scroll, lines, contentHeight, maxRows);
    this.tui.requestRender();
  }

  /**
   * 内容行。borderless 下不画左右竖线（宿主自带外框），也不加行首空格：
   * 内容自带缩进，与 boxed 的 `│内容…│` 只差两条竖线。
   */
  private frameLine(content: string, innerWidth: number): string {
    const truncated = truncateToWidth(content, innerWidth, "");
    if (this.chrome === "borderless") return truncated;
    const padding = Math.max(0, innerWidth - visibleWidth(truncated));
    return `${this.theme.fg("border", "│")}${truncated}${" ".repeat(padding)}${this.theme.fg("border", "│")}`;
  }

  private ruleLine(innerWidth: number): string {
    if (this.chrome === "borderless") {
      // 裸横线：pi-web 只丢"整行都是带角的框"的行。
      return this.theme.fg("border", "─".repeat(Math.max(1, innerWidth)));
    }
    return this.theme.fg("border", `├${"─".repeat(Math.max(1, innerWidth))}┤`);
  }

  /** 顶/底线：borderless 下不画（undefined）。 */
  private borderLine(
    innerWidth: number,
    edge: "top" | "bottom",
  ): string | undefined {
    if (this.chrome === "borderless") return undefined;
    const left = edge === "top" ? "┌" : "└";
    const right = edge === "top" ? "┐" : "┘";
    return this.theme.fg("border", `${left}${"─".repeat(innerWidth)}${right}`);
  }

  private inputFrameLine(innerWidth: number): string {
    const targetWidth = Math.max(1, innerWidth);
    const previousFocused = this.input.focused;
    // Render the embedded input unfocused: the emitted cursor marker skews the row.
    this.input.focused = false;
    try {
      const rendered = this.input.render(targetWidth)[0] ?? "";
      const line = truncateToWidth(rendered, targetWidth, "");
      const padding = Math.max(0, targetWidth - visibleWidth(line));
      return `${this.theme.fg("border", "│")}${line}${" ".repeat(padding)}${this.theme.fg("border", "│")}`;
    } finally {
      this.input.focused = previousFocused;
    }
  }

  render(width: number): string[] {
    const dim = (color: ThemeColor, text: string) => this.theme.fg(color, text);
    const dialogWidth = Math.max(40, width);
    const innerWidth =
      this.chrome === "borderless"
        ? Math.max(20, dialogWidth)
        : Math.max(20, dialogWidth - 2);
    const exchanges = this.callbacks.readExchanges();
    const active = this.callbacks.readActive();
    const view = this.callbacks.readCurrent();

    const contentLines: string[] = [];

    // Dimmed one-liners for the other exchanges (Claude Code-style history list).
    for (let i = 0; i < exchanges.length; i++) {
      if (i === this.callbacks.readViewIndex() && !active) continue;
      const oneLiner = truncateToWidth(
        exchanges[i].question,
        innerWidth - 4,
        "…",
      );
      contentLines.push(dim("dim", `  ${i + 1}. ${oneLiner}`));
    }

    if (view) {
      if (contentLines.length > 0) contentLines.push("");
      contentLines.push(
        dim(
          "accent",
          `You: ${truncateToWidth(view.question, innerWidth - 5, "…")}`,
        ),
      );
      if (view.error) {
        contentLines.push(dim("warning", `⚠ ${view.error}`));
      }
      const answerLines = view.answer
        ? // Rebuilt per render so markdown styling always follows the live theme.
          new Markdown(view.answer, 0, 0, getMarkdownTheme()).render(
            Math.max(1, innerWidth - 2),
          )
        : [dim("dim", active ? "…" : "(empty)")];
      contentLines.push(...answerLines);
    } else if (exchanges.length === 0) {
      contentLines.push(dim("dim", "No side questions yet."));
    }

    const terminalRows =
      this.hostRows ?? process.stdout.rows ?? FALLBACK_TERMINAL_ROWS;
    const maxRows = Math.max(
      MIN_CONTENT_LINES,
      Math.floor(terminalRows * 0.78) - CHROME_LINES,
    );
    this.geometry = { contentHeight: contentLines.length, maxRows };
    this.scroll = clampScroll(this.scroll, contentLines.length, maxRows);
    const scrollOffset = this.scroll.offset;
    const hiddenAbove = contentLines.length > maxRows ? scrollOffset : 0;
    const visible = contentLines.slice(scrollOffset, scrollOffset + maxRows);

    const statusText =
      this.status ||
      (active
        ? `streaming…${active.toolName ? ` · ${active.toolName}` : ""}`
        : view
          ? view.label
          : "ready");
    const viewLabel = active ? "" : ` · ${exchanges.length} in memory`;
    const scrollHint = hiddenAbove
      ? ` · ↑${hiddenAbove} above · ↑↓ scroll`
      : "";

    const lines: (string | undefined)[] = [
      this.borderLine(innerWidth, "top"),
      this.frameLine(
        dim("accent", `btw · side question${viewLabel}`),
        innerWidth,
      ),
      this.ruleLine(innerWidth),
      ...visible.map((line) => this.frameLine(line, innerWidth)),
      this.ruleLine(innerWidth),
      this.frameLine(dim("warning", statusText), innerWidth),
      this.inputFrameLine(innerWidth),
      this.frameLine(
        dim(
          "dim",
          `enter ask · c copy · ←→ history · alt+/ main editor${scrollHint} · esc ${active ? "abort" : "close"}`,
        ),
        innerWidth,
      ),
      this.borderLine(innerWidth, "bottom"),
    ];
    return lines
      .filter((line): line is string => line !== undefined)
      .map((line) =>
        visibleWidth(line) > dialogWidth
          ? truncateToWidth(line, dialogWidth, "")
          : line,
      );
  }

  invalidate(): void {
    this.tui.requestRender();
  }
}
