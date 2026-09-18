/**
 * ask-core — `ask_user_question` 工具的纯函数核（Functional Core）。
 *
 * 与 quiz 的分界：这里问的是**没有正确答案**的岔路（学习目标、方向、偏好），
 * 所以没有 correctAnswer / 评分，也允许"Other…"自由文本与纯文本提问模式。
 * 它不做洗牌：问题的选项顺序由作者决定，顺序本身常常是信息。
 */

import type { PickerOption } from "../shared/picker-core.ts";

export const OTHER_ID = "__other__";
export const OTHER_LABEL = "Other…";
export const ASK_SUBMIT_ID = "__ask_submit__";

export type AskOption = { label: string; value: string; description?: string };

export type AskMode = "single-select" | "multi-select" | "free-text";

export type AskStatus = "pending" | "answered" | "cancelled" | "unavailable";

export type DisplayedOption = { index: number; label: string };

export type AskSelection = { index: number; label: string; value: string };

export type AskDetails = {
  status: AskStatus;
  question: string;
  context?: string;
  mode: AskMode;
  options: DisplayedOption[];
  selections: AskSelection[];
  /** 用户选了 "Other…" 后输入的自由文本。 */
  otherText?: string;
  message: string;
};

const trimmed = (value: string | undefined): string | undefined => {
  const text = value?.trim();
  return text ? text : undefined;
};

/** 去空标签、补默认 value；允许重复 label（按下标区分，因为选择用 id = 下标）。 */
export const normalizeAskOptions = (
  raw:
    | Array<{ label?: string; value?: string; description?: string }>
    | undefined,
): AskOption[] =>
  (raw ?? []).flatMap((item) => {
    const label = trimmed(item?.label);
    if (!label) return [];
    return [
      {
        label,
        value: trimmed(item?.value) ?? label,
        description: trimmed(item?.description),
      },
    ];
  });

export const toDisplayedOptions = (options: AskOption[]): DisplayedOption[] =>
  options.map((option, index) => ({ index: index + 1, label: option.label }));

/** 行 id 用下标（不是 value）：允许两个选项同值时仍能区分。 */
export const askRowId = (index: number): string => `ask:${index}`;

export const buildAskRows = (
  options: AskOption[],
  mode: AskMode,
): PickerOption[] => {
  const rows: PickerOption[] = options.map((option, index) => ({
    id: askRowId(index),
    label: option.label,
    value: option.value,
    description: option.description,
    kind: "option" as const,
  }));
  rows.push({
    id: OTHER_ID,
    label: OTHER_LABEL,
    value: OTHER_ID,
    kind: "other" as const,
  });
  if (mode === "multi-select") {
    rows.push({
      id: ASK_SUBMIT_ID,
      label: "Submit",
      value: ASK_SUBMIT_ID,
      kind: "other" as const,
    });
  }
  return rows;
};

export const askMode = (
  options: AskOption[],
  multiSelect: boolean,
): AskMode => {
  if (options.length === 0) return "free-text";
  return multiSelect ? "multi-select" : "single-select";
};

export const resolveSelections = (
  options: AskOption[],
  selectedIds: string[],
): AskSelection[] =>
  selectedIds.flatMap((id) => {
    const index = Number.parseInt(id.replace("ask:", ""), 10);
    const option = Number.isNaN(index) ? undefined : options[index];
    return option
      ? [{ index: index + 1, label: option.label, value: option.value }]
      : [];
  });

export type BuildAskInput = {
  status: AskStatus;
  question: string;
  context?: string;
  mode: AskMode;
  options: AskOption[];
  selectedIds?: string[];
  otherText?: string;
};

export const buildAskDetails = (input: BuildAskInput): AskDetails => {
  const details: AskDetails = {
    status: input.status,
    question: input.question,
    context: input.context,
    mode: input.mode,
    options: toDisplayedOptions(input.options),
    selections: resolveSelections(input.options, input.selectedIds ?? []),
    otherText: input.otherText,
    message: "",
  };
  details.message = askMessage(details);
  return details;
};

export const askMessage = (details: AskDetails): string => {
  if (details.status === "unavailable") {
    return "ask_user_question unavailable: this session has no interactive UI — ask the question as plain text instead.";
  }
  if (details.status === "cancelled") {
    return "question dismissed by the user without an answer — do not assume one.";
  }
  if (details.status === "pending") {
    return `waiting for the user to answer: ${details.question}`;
  }
  if (details.otherText) {
    return `User answered in their own words: ${details.otherText}`;
  }
  if (details.selections.length === 0) {
    return "User submitted an empty selection.";
  }
  const picked = details.selections
    .map((selection) => `${selection.index}. ${selection.label}`)
    .join(", ");
  return `User answered: ${picked}`;
};
