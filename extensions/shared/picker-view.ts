/**
 * picker-view — 纯渲染（Core）：state → 终端行。
 *
 * 只做字符串拼装，不读终端、不处理按键，因此可以直接单测行宽与截断。
 * 盒子样式沿用 plugin-toggle/picker.ts 的房规。
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  PICKER_PAGE_SIZE,
  type PickerOption,
  type PickerState,
  pageOf,
  pageSlice,
} from "./picker-core.ts";

export type PickerView = {
  title: string;
  /** 已过滤的候选集（调用方先用 filterOptions 处理）。 */
  options: PickerOption[];
  state: PickerState;
  /** 总宽（含边框），终端列数。 */
  width: number;
  multiSelect: boolean;
  footer?: string;
  emptyText?: string;
  pageSize?: number;
};

const dim = (text: string): string => `\x1b[2m${text}\x1b[0m`;
const accent = (text: string): string => `\x1b[36m${text}\x1b[0m`;
const reverse = (text: string): string => `\x1b[7m${text}\x1b[0m`;

const DEFAULT_FOOTER = "↑/↓ navigate  enter select  esc cancel";

export const renderPickerLines = (view: PickerView): string[] => {
  const pageSize = view.pageSize ?? PICKER_PAGE_SIZE;
  const innerW = Math.max(1, view.width - 2);
  const page = pageOf(view.state.cursor, pageSize);
  const visible = pageSlice(view.options, page, pageSize);
  const pageStart = page * pageSize;

  const row = (content: string, isSelected = false): string => {
    const body = truncateToWidth(` ${content}`, innerW, "…", true);
    return dim("│") + (isSelected ? reverse(body) : body) + dim("│");
  };

  const title = truncateToWidth(` ${view.title} `, innerW, "…", true);
  const borderLen = Math.max(0, innerW - visibleWidth(title));
  const left = Math.floor(borderLen / 2);
  const lines = [
    dim(`╭${"─".repeat(left)}`) +
      accent(title) +
      dim(`${"─".repeat(borderLen - left)}╮`),
  ];

  lines.push(row(`Search: ${view.state.query || dim("type to filter...")}`));
  lines.push(dim(`├${"─".repeat(innerW)}┤`));

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

  lines.push(dim(`├${"─".repeat(innerW)}┤`));
  lines.push(row(dim(view.footer ?? DEFAULT_FOOTER)));
  lines.push(dim(`╰${"─".repeat(innerW)}╯`));
  return lines;
};
