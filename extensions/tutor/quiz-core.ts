/**
 * quiz-core — `quiz` 工具的纯函数核（Functional Core）。
 *
 * 负责：选项归一化与校验、以 value 为键解析正确答案、洗牌（RNG 注入）、
 * 评分、结构化结果与面向 agent 的结果文案。无 IO、无 TUI、无随机全局依赖。
 *
 * 设计要点：
 * - 正确答案按选项 `value` 引用，洗完牌后再解析下标，所以评分永远对应用户
 *   实际看到的顺序；value 打错是硬错误，而不是静默判错。
 * - "I don't know" 是固定行：不参与洗牌、不参与评分，单独产出 dontKnow 信号，
 *   让"诚实放弃"不被当成猜错。
 */

import type { PickerOption } from "../shared/picker-core.ts";

export const DONT_KNOW_VALUE = "__dont_know__";
export const DONT_KNOW_LABEL = "I don't know";
export const SUBMIT_ID = "__submit__";

/** 至少要有这么多选项才构成一道可评分的题。 */
export const MIN_QUIZ_OPTIONS = 2;

export type QuizOption = {
  label: string;
  /** 机器可读值；省略时取 label。 */
  value: string;
  description?: string;
};

export type QuizMode = "single-select" | "multi-select";

export type QuizStatus = "pending" | "answered" | "cancelled" | "unavailable";

/** 展示顺序里的一个选项（1-based index 与用户看到的一致）。 */
export type DisplayedOption = { index: number; label: string };

export type QuizAnswer = { index: number; label: string; value: string };

export type QuizDetails = {
  status: QuizStatus;
  question: string;
  context?: string;
  mode: QuizMode;
  /** 展示顺序的完整选项表：md-log 用它写"问题块"，顺序与屏幕一致。 */
  options: DisplayedOption[];
  answers?: QuizAnswer[];
  selectedValues?: string[];
  correctValues?: string[];
  /** 正确项在展示顺序里的 1-based 下标（洗完牌后解析）。 */
  correctIndices?: number[];
  isCorrect?: boolean | null;
  /** 用户选了"I don't know"：真实知识缺口，而非猜错。 */
  dontKnow?: boolean;
  explanation?: string;
  /** 面向 agent 的单行结论。 */
  message?: string;
};

export type NormalizeResult =
  | { ok: true; options: QuizOption[] }
  | { ok: false; error: string };

const trimmed = (value: string | undefined): string | undefined => {
  const text = value?.trim();
  return text ? text : undefined;
};

/** 去空标签、补默认 value、拒绝重复 value、要求最少选项数。 */
export const normalizeQuizOptions = (
  raw:
    | Array<{ label?: string; value?: string; description?: string }>
    | undefined,
): NormalizeResult => {
  const options: QuizOption[] = [];
  const seen = new Set<string>();
  for (const item of raw ?? []) {
    const label = trimmed(item?.label);
    if (!label) continue;
    const value = trimmed(item?.value) ?? label;
    if (seen.has(value)) {
      return { ok: false, error: `duplicate option value "${value}"` };
    }
    seen.add(value);
    options.push({ label, value, description: trimmed(item?.description) });
  }
  if (options.length < MIN_QUIZ_OPTIONS) {
    return {
      ok: false,
      error: `at least ${MIN_QUIZ_OPTIONS} options with non-empty labels are required`,
    };
  }
  return { ok: true, options };
};

/**
 * 兼容 harness 把多选答案数组塞成 JSON 字符串的情况
 * （schema 的 union 把 String 排在前面时会发生）。
 */
export const coerceCorrectAnswer = (input: string | string[]): string[] => {
  if (Array.isArray(input)) return input.map(String);
  const text = input.trim();
  if (text.startsWith("[") && text.endsWith("]")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      // 不是合法 JSON：按单个字面值处理。
    }
  }
  return [input];
};

export const resolveCorrectValues = (
  input: string | string[],
  options: QuizOption[],
): { values: string[]; error?: string } => {
  const requested = coerceCorrectAnswer(input).map((value) => value.trim());
  if (requested.length === 0)
    return { values: [], error: "correctAnswer is required" };
  const known = new Set(options.map((option) => option.value));
  const unknown = requested.filter((value) => !known.has(value));
  if (unknown.length > 0) {
    const available = options.map((option) => `"${option.value}"`).join(", ");
    return {
      values: [],
      error: `correctAnswer ${unknown.map((v) => `"${v}"`).join(", ")} does not match any option value (${available})`,
    };
  }
  const unique = Array.from(new Set(requested));
  const order = new Map(options.map((option, i) => [option.value, i]));
  return {
    values: unique.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)),
  };
};

/** Fisher-Yates；返回新数组，且 rng 注入以便测试可复现。 */
export const shuffle = <T>(
  items: T[],
  rng: () => number = Math.random,
): T[] => {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const swap = out[i];
    out[i] = out[j];
    out[j] = swap;
  }
  return out;
};

/** 展示行 = 洗牌后的选项 + 固定末尾的"I don't know"。id 用 value（稳定且唯一）。 */
export const buildRows = (options: QuizOption[]): PickerOption[] => [
  ...options.map((option) => ({
    id: option.value,
    label: option.label,
    value: option.value,
    description: option.description,
    kind: "option" as const,
  })),
  {
    id: DONT_KNOW_VALUE,
    label: DONT_KNOW_LABEL,
    value: DONT_KNOW_VALUE,
    kind: "dont-know" as const,
  },
];

export const toDisplayedOptions = (options: QuizOption[]): DisplayedOption[] =>
  options.map((option, index) => ({ index: index + 1, label: option.label }));

/** 集合相等即正确：多选顺序无关，少选/多选都算错。 */
export const grade = (
  selectedValues: string[],
  correctValues: string[],
): boolean => {
  if (selectedValues.length !== correctValues.length) return false;
  const selected = [...selectedValues].sort();
  const correct = [...correctValues].sort();
  return selected.every((value, index) => value === correct[index]);
};

export type BuildOutcomeInput = {
  status: QuizStatus;
  question: string;
  context?: string;
  mode: QuizMode;
  /** 展示顺序的选项（已洗牌）。 */
  options: QuizOption[];
  selectedValues?: string[];
  correctValues?: string[];
  dontKnow?: boolean;
  explanation?: string;
  error?: string;
};

export const buildOutcome = (input: BuildOutcomeInput): QuizDetails => {
  const displayed = toDisplayedOptions(input.options);
  const indexByValue = new Map(
    input.options.map((option, i) => [option.value, i + 1]),
  );
  const selectedValues = input.selectedValues ?? [];
  const answers: QuizAnswer[] = selectedValues.flatMap((value) => {
    const index = indexByValue.get(value);
    if (index === undefined) return [];
    const option = input.options[index - 1];
    return [{ index, label: option.label, value }];
  });
  const dontKnow = input.dontKnow === true;
  const isCorrect =
    input.status === "answered"
      ? dontKnow
        ? null
        : grade(selectedValues, input.correctValues ?? [])
      : null;

  const details: QuizDetails = {
    status: input.status,
    question: input.question,
    context: input.context,
    mode: input.mode,
    options: displayed,
    answers,
    selectedValues,
    correctValues: input.correctValues ?? [],
    correctIndices: (input.correctValues ?? []).flatMap((value) => {
      const index = indexByValue.get(value);
      return index === undefined ? [] : [index];
    }),
    isCorrect,
    dontKnow,
    explanation: input.explanation,
  };
  details.message = outcomeMessage(details, input.error);
  return details;
};

/** 面向 agent 的结论文案：包含判定、用户所答、正确项与解释（在作答后才给出）。 */
export const outcomeMessage = (
  details: QuizDetails,
  error?: string,
): string => {
  if (details.status === "unavailable") {
    return "quiz unavailable: this session has no interactive UI — ask the question as plain text instead.";
  }
  if (details.status === "cancelled") {
    return "quiz cancelled by the user before answering — do not assume an answer.";
  }
  if (details.status === "pending") {
    return `waiting for the user to answer: ${details.question}`;
  }
  if (error) return error;
  if (details.dontKnow) {
    return `User selected "${DONT_KNOW_LABEL}" — a genuine knowledge gap, not a wrong guess: ${details.question}`;
  }
  const verdict = details.isCorrect ? "✓ correct" : "✗ incorrect";
  const selected = details.answers?.length
    ? details.answers
        .map((answer) => `${answer.index}. ${answer.label}`)
        .join(", ")
    : "(none)";
  const correct = (details.correctValues ?? []).join(", ") || "(none)";
  const lines = [
    `User answered ${verdict}.`,
    `Selected: ${selected}`,
    `Correct: ${correct}`,
  ];
  if (details.explanation) lines.push(`Explanation: ${details.explanation}`);
  return lines.join("\n");
};
