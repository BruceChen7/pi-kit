/**
 * picker-input — 一次按键 → picker 动作（纯函数，无 IO）。
 *
 * 存在的理由：键盘处理曾经在每个 UI 里各写一份，于是「Kitty 协议下 esc/方向键
 * 裸字节失配」「shift+键的 CSI-u 被当控制序列吞掉」这两类 bug 都各修了多次。
 * 现在导航与文本只此一处：Core 决定动作，Shell 只负责 done() / requestRender()。
 *
 * 两个入口：
 * - `applyPickerNav`：esc / ↑↓ / 退格 / 可打印文本。ask-ui、quiz-ui 用它，
 *   自己再拦下特有语义（space 勾选、enter 作答）。
 * - `applyPickerKey`：上面那些 + enter→submit。给「enter 就是确认」的 picker（md-topic）。
 *
 * 与宿主 UI 的契约（为什么空格是个坑）：可打印文本包括空格，所以「空格 = 勾选」这类
 * 动作键只能占住**搜索框为空**的时候；一旦 query 非空，空格必须当文本进 query，
 * 否则渲染出来的 `Search:` 框就是空头支票（搜不了带空格的标签）。
 *
 * 注意：可搜索的 picker 里 `j` / `k` 是普通文本（要能搜 kafka / jvm），
 * 不做 vim 式上下移动。
 */

import { matchesKey } from "@earendil-works/pi-tui";
import { moveCursor, type PickerState, setQuery } from "./picker-core.ts";
import { printableInput } from "./printable-input.ts";

export type PickerNavAction =
  /** esc：取消（done(undefined) / done({kind:"cancelled"})）。 */
  | { kind: "cancel" }
  /** 光标 / 查询变了，需要 requestRender。 */
  | { kind: "update"; state: PickerState }
  /** 无关按键（功能键、ctrl 组合、enter…），不动。 */
  | { kind: "ignore" };

export type PickerKeyAction =
  | PickerNavAction
  /** enter：提交当前光标行（下标基于**过滤后**的列表）。 */
  | { kind: "submit"; index: number };

/** 状态没变就不必重绘。 */
const changed = (state: PickerState, next: PickerState): PickerNavAction =>
  next === state ? { kind: "ignore" } : { kind: "update", state: next };

export const applyPickerNav = (
  data: string,
  state: PickerState,
  /** 过滤后可见行数，用于夹取光标。 */
  total: number,
): PickerNavAction => {
  if (matchesKey(data, "escape")) return { kind: "cancel" };
  if (matchesKey(data, "up"))
    return changed(state, moveCursor(state, -1, total));
  if (matchesKey(data, "down")) {
    return changed(state, moveCursor(state, 1, total));
  }
  if (matchesKey(data, "backspace")) {
    if (state.query.length === 0) return { kind: "ignore" };
    return changed(state, setQuery(state, state.query.slice(0, -1)));
  }
  const text = printableInput(data);
  if (text !== undefined) {
    return changed(state, setQuery(state, state.query + text));
  }
  return { kind: "ignore" };
};

export const applyPickerKey = (
  data: string,
  state: PickerState,
  total: number,
): PickerKeyAction => {
  const nav = applyPickerNav(data, state, total);
  if (nav.kind !== "ignore") return nav;
  if (matchesKey(data, "return") || matchesKey(data, "enter")) {
    return { kind: "submit", index: state.cursor };
  }
  return { kind: "ignore" };
};
