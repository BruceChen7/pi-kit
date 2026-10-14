/**
 * picker-view — 纯渲染（Core）：state → 终端行。
 *
 * 只做字符串拼装，不读终端、不处理按键，因此可以直接单测行宽与截断。
 * 外框不在这里定死：交给 `panel-chrome.ts`，按宿主能力选 boxed（TUI 房规）或
 * borderless（pi-web 这类自带外框的宿主）。其余行样式与既有观感一致。
 */

import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { panelPainter } from "./panel-chrome.ts";
import {
  PICKER_PAGE_SIZE,
  type PickerOption,
  type PickerState,
  pageOf,
  pageSlice,
} from "./picker-core.ts";
import type { PanelChrome } from "./ui-host.ts";

/**
 * 自定义 picker 组件的契约：pi 的 setFocus 会改写 `focused`，渲染时据此在
 * 搜索框发 CURSOR_MARKER（IME / 硬件光标靠它定位）。
 */
export type PickerComponent = {
  focused: boolean;
  render: (width: number) => string[];
  invalidate: () => void;
  handleInput: (data: string) => void;
};

export type PickerView = {
  title: string;
  /** 已过滤的候选集（调用方先用 filterOptions 处理）。 */
  options: PickerOption[];
  state: PickerState;
  /** 总宽（含边框），终端列数。 */
  width: number;
  multiSelect: boolean;
  /**
   * 焦点态：true 时在搜索框光标处发 CURSOR_MARKER。pi 靠这个标记把硬件光标
   * （以及 macOS IME 的候选窗）移到框里；不发的话光标停在编辑器位置，
   * 输入法就没法「聚焦」到搜索框。
   */
  focused?: boolean;
  footer?: string;
  emptyText?: string;
  pageSize?: number;
  /**
   * 外框策略（见 panel-chrome.ts）：默认 `boxed`（TUI 观感不变）；
   * pi-web 这类宿主自带外框且会撕掉自绘的框 → 传 `borderless`。
   */
  chrome?: PanelChrome;
  /**
   * 是否在搜索框发 CURSOR_MARKER。宿主从不设置 `focused`（pi-web）时无处可用：
   * 既不亮光标，宿主还会把标记删掉，所以那边传 false。
   */
  emitCursorMarker?: boolean;
};

const dim = (text: string): string => `\x1b[2m${text}\x1b[0m`;
const accent = (text: string): string => `\x1b[36m${text}\x1b[0m`;
const reverse = (text: string): string => `\x1b[7m${text}\x1b[0m`;

const DEFAULT_FOOTER = "↑/↓ navigate  enter select  esc cancel";
const PLACEHOLDER = "type to filter...";

/**
 * 搜索行。焦点态下把光标（反显字符）画出来，并在光标前发 CURSOR_MARKER：
 * 硬件光标落在反显字符上，IME 的候选窗才会跟到框上。
 */
const searchLine = (
  query: string,
  focused: boolean,
  emitCursorMarker: boolean,
): string => {
  if (!focused) return `Search: ${query || dim(PLACEHOLDER)}`;
  if (!emitCursorMarker) {
    return `Search: ${query || dim(PLACEHOLDER)}`;
  }
  if (query.length > 0) {
    return `Search: ${query}${CURSOR_MARKER}${reverse(" ")}`;
  }
  const [head = " ", ...tail] = [...PLACEHOLDER];
  return `Search: ${CURSOR_MARKER}${reverse(head)}${dim(tail.join(""))}`;
};

export const renderPickerLines = (view: PickerView): string[] => {
  const pageSize = view.pageSize ?? PICKER_PAGE_SIZE;
  const painter = panelPainter(view.chrome ?? "boxed");
  const emitCursorMarker = view.emitCursorMarker ?? true;
  const page = pageOf(view.state.cursor, pageSize);
  const visible = pageSlice(view.options, page, pageSize);
  const pageStart = page * pageSize;

  const row = (content: string, isSelected = false): string =>
    painter.rowLine({
      width: view.width,
      content,
      paintBorder: dim,
      decorate: isSelected ? reverse : undefined,
    });

  const lines: string[] = [
    painter.titleLine({
      width: view.width,
      title: ` ${view.title} `,
      paintTitle: accent,
      paintBorder: dim,
      // 标题栏观感：标题补齐整行，两侧不留破折号（与改动前逐字一致）。
      pad: true,
    }),
  ];

  lines.push(
    row(searchLine(view.state.query, view.focused ?? false, emitCursorMarker)),
  );
  lines.push(painter.ruleLine({ width: view.width, paintBorder: dim }));

  for (let i = 0; i < visible.length; i++) {
    const option = visible[i];
    const isCursor = pageStart + i === view.state.cursor;
    const isChecked = view.state.selectedIds.includes(option.id);
    const marker = isCursor ? "▸" : "·";
    const check = view.multiSelect
      ? `${isChecked ? "✓" : " "} `
      : `${isChecked ? "●" : "○"} `;
    const label = `${marker} ${check}${option.label}`;
    lines.push(row(isChecked && !isCursor ? accent(label) : label, isCursor));
  }

  if (visible.length === 0) {
    lines.push(row(dim(view.emptyText ?? "No matches")));
  }

  lines.push(painter.ruleLine({ width: view.width, paintBorder: dim }));
  lines.push(row(dim(view.footer ?? DEFAULT_FOOTER)));
  const bottom = painter.bottomLine({ width: view.width, paintBorder: dim });
  if (bottom !== undefined) lines.push(bottom);
  return lines;
};
