/**
 * quiz-ui — `quiz` 工具的 TUI 外壳（Imperative Shell）。
 *
 * 只做三件事：把纯核产出的行交给 `ctx.ui.custom()` 渲染、把按键翻译成
 * picker-core 的状态迁移、把结果交回调用方。评分与文案都在 quiz-core。
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  createPickerState,
  filterOptions,
  isSubmittable,
  moveCursor,
  type PickerOption,
  type PickerState,
  toggleSelection,
} from "../shared/picker-core.ts";
import { renderPickerLines } from "../shared/picker-view.ts";
import { sharedUiGate } from "../shared/ui-gate.ts";
import {
  buildRows,
  DONT_KNOW_VALUE,
  type QuizMode,
  type QuizOption,
  SUBMIT_ID,
} from "./quiz-core.ts";

export type QuizRunResult =
  | { kind: "answered"; selectedValues: string[]; dontKnow: boolean }
  | { kind: "cancelled" }
  | { kind: "unavailable" };

export type QuizRunInput = {
  question: string;
  context?: string;
  /** 展示顺序（已洗牌）。 */
  options: QuizOption[];
  mode: QuizMode;
  /** 在弹出界面前回调，供 shell 发 onUpdate（md-log 用它记录屏幕顺序）。 */
  onDisplay?: (options: QuizOption[]) => void;
};

const FOOTER_SINGLE = "↑/↓ navigate  enter answer  esc cancel";
const FOOTER_MULTI = "↑/↓ navigate  space toggle  enter submit  esc cancel";

/** 多选时在末尾追加 Submit 行；单选直接回车作答，不需要 Submit。 */
const buildFocusRows = (
  options: QuizOption[],
  mode: QuizMode,
): PickerOption[] => {
  const rows = buildRows(options);
  if (mode !== "multi-select") return rows;
  return [
    ...rows,
    { id: SUBMIT_ID, label: "Submit", value: SUBMIT_ID, kind: "other" },
  ];
};

export const runQuiz = async (
  ctx: ExtensionContext,
  input: QuizRunInput,
): Promise<QuizRunResult> => {
  if (!ctx.hasUI) return { kind: "unavailable" };

  const rows = buildFocusRows(input.options, input.mode);

  // 上屏即独占终端：同批并行的另一个提问要等这个出闸后才上屏（见 shared/ui-gate）。
  return sharedUiGate.run(() => showQuizPicker(ctx, input, rows));
};

const showQuizPicker = (
  ctx: ExtensionContext,
  input: QuizRunInput,
  rows: PickerOption[],
): Promise<QuizRunResult> => {
  const multi = input.mode === "multi-select";
  input.onDisplay?.(input.options);

  return ctx.ui.custom<QuizRunResult>((tui, _theme, _kb, done) => {
    let state: PickerState = createPickerState();
    const isSubmitRow = (index: number): boolean =>
      rows[index]?.id === SUBMIT_ID;

    const select = (index: number): void => {
      const row = rows[index];
      if (!row) return;
      if (row.id === SUBMIT_ID) {
        if (!isSubmittable(state)) return;
        const selectedIds = state.selectedIds;
        done({
          kind: "answered",
          selectedValues: selectedIds,
          dontKnow: selectedIds.includes(DONT_KNOW_VALUE),
        });
        return;
      }
      if (row.id === DONT_KNOW_VALUE) {
        done({ kind: "answered", selectedValues: [], dontKnow: true });
        return;
      }
      done({ kind: "answered", selectedValues: [row.value], dontKnow: false });
    };

    const handleInput = (data: string): void => {
      if (matchesKey(data, "escape")) {
        done({ kind: "cancelled" });
        return;
      }
      if (matchesKey(data, "up")) {
        state = moveCursor(state, -1, rows.length);
        return;
      }
      if (matchesKey(data, "down")) {
        state = moveCursor(state, 1, rows.length);
        return;
      }
      if (matchesKey(data, "space")) {
        const row = rows[state.cursor];
        if (!row || row.id === SUBMIT_ID) return;
        if (row.id === DONT_KNOW_VALUE) {
          done({ kind: "answered", selectedValues: [], dontKnow: true });
          return;
        }
        if (!multi) {
          select(state.cursor);
          return;
        }
        state = toggleSelection(state, row.id, true);
        return;
      }
      if (matchesKey(data, "return") || matchesKey(data, "enter")) {
        if (isSubmitRow(state.cursor)) {
          select(state.cursor);
          return;
        }
        if (multi) {
          const row = rows[state.cursor];
          if (!row || row.id === DONT_KNOW_VALUE) {
            select(state.cursor);
            return;
          }
          state = toggleSelection(state, row.id, true);
          return;
        }
        select(state.cursor);
      }
    };

    const render = (width: number): string[] => {
      const lines: string[] = [];
      for (const line of wrapTextWithAnsi(
        `❓ ${input.question}`,
        Math.max(1, width),
      )) {
        lines.push(truncateToWidth(line, width));
      }
      if (input.context) {
        for (const line of wrapTextWithAnsi(
          input.context,
          Math.max(1, width),
        )) {
          lines.push(truncateToWidth(`\x1b[2m${line}\x1b[0m`, width));
        }
      }
      lines.push("");
      const visible = filterOptions(rows, "");
      lines.push(
        ...renderPickerLines({
          title: multi ? "Quiz (multi-select)" : "Quiz",
          options: visible,
          state,
          width,
          multiSelect: multi,
          footer: multi ? FOOTER_MULTI : FOOTER_SINGLE,
        }),
      );
      return lines;
    };

    return {
      render,
      invalidate: () => {},
      handleInput: (data: string) => {
        handleInput(data);
        tui.requestRender();
      },
    };
  });
};
