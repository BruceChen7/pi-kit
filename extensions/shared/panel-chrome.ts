/**
 * panel-chrome — 面板外框（Functional Core：value in / value out，无 IO）。
 *
 * TUI 里扩展面板自己画盒子，而 pi-web 的面板**自带外框**，还会在渲染前把扩展画的
 * 框撕掉（`pi-web/lib/ansi.ts:58-88`：整行丢弃带角的框线、剥掉行首行尾竖线），盒子
 * 只剩顶盖、行首缩进被吃掉。所以外框由宿主能力决定：`boxed` 保持 TUI 观感，
 * `borderless` 只画不会被动过的裸横线。
 *
 * 尺寸契约：所有输出行 `visibleWidth(line) <= width`。
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { PanelChrome } from "./ui-host.ts";

export type PanelPainter = {
  /** 行内容的可用宽度（boxed 要扣掉左右竖线）。 */
  innerWidth: (width: number) => number;
  /**
   * 标题行（boxed 含左右角；borderless 只有标题文本）。
   * `pad`：把标题补齐到整行，两侧不留破折号；默认用破折号填满（既有观感）。
   */
  titleLine: (input: {
    width: number;
    title: string;
    paintTitle: (text: string) => string;
    paintBorder: (text: string) => string;
    pad?: boolean;
  }) => string;
  /** 分隔线（borderless 用不含角的裸横线，宿主不会丢）。 */
  ruleLine: (input: {
    width: number;
    paintBorder: (text: string) => string;
  }) => string;
  /** 内容行（boxed 带左右竖线；borderless 只留行首空格）。 */
  rowLine: (input: {
    width: number;
    content: string;
    paintBorder: (text: string) => string;
    /** 选中态等修饰，作用在行体上（不含边框）。 */
    decorate?: ((text: string) => string) | undefined;
  }) => string;
  /** 底线；borderless 返回 undefined（宿主自有外框）。 */
  bottomLine: (input: {
    width: number;
    paintBorder: (text: string) => string;
  }) => string | undefined;
};

const boxed = (): PanelPainter => ({
  innerWidth: (width) => Math.max(1, width - 2),
  titleLine: ({ width, title, paintTitle, paintBorder, pad }) => {
    const innerW = Math.max(1, width - 2);
    const text = pad
      ? truncateToWidth(title, innerW, "…", true)
      : truncateToWidth(title, innerW, "…");
    const borderLen = Math.max(0, innerW - visibleWidth(text));
    const left = Math.floor(borderLen / 2);
    const right = borderLen - left;
    return (
      paintBorder(`╭${"─".repeat(left)}`) +
      paintTitle(text) +
      paintBorder(`${"─".repeat(right)}╮`)
    );
  },
  ruleLine: ({ width, paintBorder }) =>
    paintBorder(`├${"─".repeat(Math.max(1, width - 2))}┤`),
  rowLine: ({ width, content, paintBorder, decorate }) => {
    const innerW = Math.max(1, width - 2);
    const body = truncateToWidth(` ${content}`, innerW, "…", true);
    return (
      paintBorder("│") + (decorate ? decorate(body) : body) + paintBorder("│")
    );
  },
  // 整行一次上色（与既有 picker 的 `dim(╰───╯)` 逐字一致，别拆成两段）。
  bottomLine: ({ width, paintBorder }) =>
    paintBorder(`╰${"─".repeat(Math.max(1, width - 2))}╯`),
});

const borderless = (): PanelPainter => ({
  innerWidth: (width) => Math.max(1, width),
  titleLine: ({ width, title, paintTitle }) =>
    paintTitle(truncateToWidth(` ${title}`, Math.max(1, width), "…", true)), // borderless 总是整行宽度
  // 裸横线：pi-web 只丢"整行都是带角的框"的行，`───` 会留下。
  ruleLine: ({ width, paintBorder }) =>
    paintBorder("─".repeat(Math.max(1, width))),
  rowLine: ({ width, content, decorate }) => {
    const body = truncateToWidth(` ${content}`, Math.max(1, width), "…", true);
    return decorate ? decorate(body) : body;
  },
  bottomLine: () => undefined,
});

export const panelPainter = (chrome: PanelChrome): PanelPainter =>
  chrome === "borderless" ? borderless() : boxed();
