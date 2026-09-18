/**
 * ask-ui — `ask_user_question` 的 TUI 外壳（Imperative Shell）。
 *
 * 三种模式：有选项（单选/多选 + Other…）、无选项（纯文本）。选项顺序保持
 * 作者给定顺序，不洗牌。自由文本走 `ctx.ui.input`，避免在扩展里再造一套编辑器。
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  createPickerState,
  moveCursor,
  type PickerState,
  toggleSelection,
} from "../shared/picker-core.ts";
import { renderPickerLines } from "../shared/picker-view.ts";
import {
  ASK_SUBMIT_ID,
  type AskMode,
  type AskOption,
  buildAskRows,
  OTHER_ID,
} from "./ask-core.ts";

export type AskRunResult =
  | { kind: "answered"; selectedIds: string[] }
  | { kind: "other"; text: string }
  | { kind: "cancelled" }
  | { kind: "unavailable" };

export type AskRunInput = {
  question: string;
  context?: string;
  options: AskOption[];
  mode: AskMode;
};

const OTHER_PROMPT = "Your answer (Other…)";

const promptOtherText = async (
  ctx: ExtensionContext,
): Promise<AskRunResult> => {
  const text = await ctx.ui.input(OTHER_PROMPT);
  if (text === undefined) return { kind: "cancelled" };
  return { kind: "other", text: text.trim() };
};

const FOOTER_SINGLE = `↑/↓ navigate  enter answer  esc cancel`;
const FOOTER_MULTI = `↑/↓ navigate  space toggle  enter submit  esc cancel`;

export const runAsk = async (
  ctx: ExtensionContext,
  input: AskRunInput,
): Promise<AskRunResult> => {
  if (!ctx.hasUI) return { kind: "unavailable" };

  if (input.mode === "free-text") {
    const text = await ctx.ui.input(input.question);
    if (text === undefined) return { kind: "cancelled" };
    return { kind: "other", text: text.trim() };
  }

  const rows = buildAskRows(input.options, input.mode);
  const multi = input.mode === "multi-select";

  const outcome = await ctx.ui.custom<AskRunResult>(
    (tui, _theme, _kb, done) => {
      let state: PickerState = createPickerState();

      const answerWithRow = (index: number): void => {
        const row = rows[index];
        if (!row) return;
        if (row.id === OTHER_ID) {
          done({ kind: "other", text: "" });
          return;
        }
        if (row.id === ASK_SUBMIT_ID) {
          if (state.selectedIds.length === 0) return;
          done({ kind: "answered", selectedIds: state.selectedIds });
          return;
        }
        if (!multi) {
          done({ kind: "answered", selectedIds: [row.id] });
          return;
        }
        state = toggleSelection(state, row.id, true);
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
        if (matchesKey(data, "space") && multi) {
          const row = rows[state.cursor];
          if (!row || row.id === ASK_SUBMIT_ID) return;
          if (row.id === OTHER_ID) {
            answerWithRow(state.cursor);
            return;
          }
          state = toggleSelection(state, row.id, true);
          return;
        }
        if (matchesKey(data, "return") || matchesKey(data, "enter")) {
          answerWithRow(state.cursor);
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
        lines.push(
          ...renderPickerLines({
            title: multi ? "Question (multi-select)" : "Question",
            options: rows,
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
    },
  );

  if (outcome.kind === "other") return promptOtherText(ctx);
  return outcome;
};
