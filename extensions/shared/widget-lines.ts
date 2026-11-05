/**
 * widget-lines — 把预上色的行包成 `setWidget(key, factory)` 的组件工厂。
 *
 * 宿主对 `string[]` 有隐藏的条数上限（TUI 是 `MAX_WIDGET_LINES = 10`，超出补
 * `... (widget truncated)`）；组件工厂不经过那条裁剪，`render(width)` 返回多少行就
 * 画多少行。这里负责让组件路径和数组路径长得一样：每行一个 `Text`，paddingX=1。
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { Container, Text } from "@earendil-works/pi-tui";

/** `setWidget(key, factory)` 的工厂签名（与 pi 的 `ExtensionWidgetOptions` 对齐）。 */
export type LinesWidgetFactory = (
  tui: TUI,
  theme: Theme,
) => Component & { dispose?(): void };

export const createLinesWidget =
  (lines: readonly string[]): LinesWidgetFactory =>
  () => {
    const container = new Container();
    for (const line of lines) {
      container.addChild(new Text(line, 1, 0));
    }
    return container;
  };
