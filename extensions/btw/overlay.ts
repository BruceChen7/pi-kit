// # btw overlay — top-center 展示组件（移植自 L2ncE/pi-btw，Apache-2.0）
//
// BtwOverlayComponent 是纯展示组件：读回调暴露的状态、Markdown 渲染、
// 处理输入（←→ 历史翻页 / ↑↓ 滚动 / c 复制 / Esc 中止或关闭 / alt+/ 切焦点）。
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
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { BtwActive, BtwExchange, BtwSelection } from "./core.ts";

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

export class BtwOverlayComponent implements Component, Focusable {
  private readonly input = new Input();
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly callbacks: BtwOverlayCallbacks;
  private status = "";
  private scrollOffset = 0;
  private followBottom = true;
  focused = false;

  constructor(tui: TUI, theme: Theme, callbacks: BtwOverlayCallbacks) {
    this.tui = tui;
    this.theme = theme;
    this.callbacks = callbacks;
    this.input.onSubmit = (value) => {
      // Keep the draft when the ask is rejected (still answering); the parent shows a hint.
      if (!this.callbacks.readActive()) this.input.setValue("");
      this.followBottom = true;
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
          this.followBottom = false;
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
        this.followBottom = false;
        this.scrollOffset = Math.max(0, this.scrollOffset - 1);
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.down)) {
        this.scrollOffset += 1;
        this.tui.requestRender();
        return;
      }
    }
    this.input.handleInput(data);
  }

  /** Clamp the scroll state against the current content; returns the visible offset. */
  private clampScroll(contentHeight: number, maxRows: number): number {
    if (contentHeight <= maxRows) {
      this.scrollOffset = 0;
      return 0;
    }
    const maxOffset = contentHeight - maxRows;
    if (this.followBottom) this.scrollOffset = maxOffset;
    this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
    if (this.scrollOffset >= maxOffset) this.followBottom = true;
    return this.scrollOffset;
  }

  private frameLine(content: string, innerWidth: number): string {
    const truncated = truncateToWidth(content, innerWidth, "");
    const padding = Math.max(0, innerWidth - visibleWidth(truncated));
    return `${this.theme.fg("border", "│")}${truncated}${" ".repeat(padding)}${this.theme.fg("border", "│")}`;
  }

  private ruleLine(innerWidth: number): string {
    return this.theme.fg("border", `├${"─".repeat(Math.max(1, innerWidth))}┤`);
  }

  private borderLine(innerWidth: number, edge: "top" | "bottom"): string {
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
    const innerWidth = Math.max(20, dialogWidth - 2);
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

    const maxRows = Math.max(
      MIN_CONTENT_LINES,
      Math.floor((process.stdout.rows ?? 30) * 0.78) - CHROME_LINES,
    );
    const scrollOffset = this.clampScroll(contentLines.length, maxRows);
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

    const lines: string[] = [
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
    return lines.map((line) =>
      visibleWidth(line) > dialogWidth
        ? truncateToWidth(line, dialogWidth, "")
        : line,
    );
  }

  invalidate(): void {
    this.tui.requestRender();
  }
}
