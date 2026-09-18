import { describe, expect, it } from "vitest";
import {
  buildOutcome,
  buildRows,
  coerceCorrectAnswer,
  DONT_KNOW_LABEL,
  DONT_KNOW_VALUE,
  grade,
  type NormalizeResult,
  normalizeQuizOptions,
  outcomeMessage,
  type QuizOption,
  resolveCorrectValues,
  shuffle,
  toDisplayedOptions,
} from "./quiz-core.ts";

/** strict:false 下 `!result.ok` 不收窄，统一走这个断言助手。 */
const mustOptions = (result: NormalizeResult): QuizOption[] => {
  if (result.ok === false) throw new Error(result.error);
  return result.options;
};

const planets = [
  { label: "Mercury", value: "mercury" },
  { label: "Venus", value: "venus" },
  { label: "Earth", value: "earth" },
];

describe("quiz-core / normalizeQuizOptions", () => {
  it("trims labels and defaults value to the label", () => {
    const result = normalizeQuizOptions([
      { label: "  Mercury  " },
      { label: "Venus", value: " venus ", description: " hottest " },
    ]);
    expect(result).toEqual({
      ok: true,
      options: [
        { label: "Mercury", value: "Mercury", description: undefined },
        { label: "Venus", value: "venus", description: "hottest" },
      ],
    });
  });

  it("drops empty labels but keeps the remaining options", () => {
    const result = normalizeQuizOptions([
      { label: "   " },
      { label: "a" },
      { label: "b" },
    ]);
    expect(
      result.ok === true ? result.options.map((o) => o.value) : null,
    ).toEqual(["a", "b"]);
  });

  it("rejects duplicate values", () => {
    expect(
      normalizeQuizOptions([
        { label: "a", value: "x" },
        { label: "b", value: "x" },
      ]),
    ).toEqual({
      ok: false,
      error: 'duplicate option value "x"',
    });
  });

  it("requires at least two usable options", () => {
    const result = normalizeQuizOptions([{ label: "only" }]);
    expect(result.ok).toBe(false);
  });
});

describe("quiz-core / correctAnswer resolution", () => {
  it("keeps arrays and single values, and parses JSON-stringified arrays", () => {
    expect(coerceCorrectAnswer("mercury")).toEqual(["mercury"]);
    expect(coerceCorrectAnswer(["a", "b"])).toEqual(["a", "b"]);
    expect(coerceCorrectAnswer('["a","b"]')).toEqual(["a", "b"]);
  });

  it("resolves values in option order and de-duplicates", () => {
    const options = mustOptions(normalizeQuizOptions(planets));
    expect(
      resolveCorrectValues(["earth", "mercury", "earth"], options),
    ).toEqual({
      values: ["mercury", "earth"],
    });
  });

  it("is a hard error when a value matches no option", () => {
    const options = mustOptions(normalizeQuizOptions(planets));
    const resolved = resolveCorrectValues("mars", options);
    expect(resolved.values).toEqual([]);
    expect(resolved.error).toContain('"mars" does not match any option value');
  });
});

describe("quiz-core / shuffle", () => {
  it("does not mutate its input and keeps every element", () => {
    const input = ["a", "b", "c", "d"];
    const out = shuffle(input, () => 0);
    expect(input).toEqual(["a", "b", "c", "d"]);
    expect([...out].sort()).toEqual([...input].sort());
  });

  it("is deterministic for a fixed rng", () => {
    let seed = 0;
    const rng = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
    const first = shuffle(["a", "b", "c", "d", "e"], rng);
    seed = 0;
    const second = shuffle(["a", "b", "c", "d", "e"], rng);
    expect(first).toEqual(second);
  });
});

describe("quiz-core / grading", () => {
  it("treats selection order as irrelevant", () => {
    expect(grade(["b", "a"], ["a", "b"])).toBe(true);
  });

  it("rejects missing and extra selections", () => {
    expect(grade([], ["a"])).toBe(false);
    expect(grade(["a"], ["a", "b"])).toBe(false);
    expect(grade(["a", "b", "c"], ["a", "b"])).toBe(false);
    expect(grade(["a", "c"], ["a", "b"])).toBe(false);
  });
});

describe("quiz-core / rows and displayed options", () => {
  it("appends the fixed 'I don't know' row and keeps value-based ids", () => {
    const options = mustOptions(normalizeQuizOptions(planets));
    const rows = buildRows(options);
    expect(rows.map((row) => row.id)).toEqual([
      "mercury",
      "venus",
      "earth",
      DONT_KNOW_VALUE,
    ]);
    expect(rows.at(-1)?.label).toBe(DONT_KNOW_LABEL);
  });

  it("numbers displayed options from 1 in display order", () => {
    const options = mustOptions(normalizeQuizOptions(planets));
    expect(toDisplayedOptions(options)).toEqual([
      { index: 1, label: "Mercury" },
      { index: 2, label: "Venus" },
      { index: 3, label: "Earth" },
    ]);
  });
});

describe("quiz-core / buildOutcome", () => {
  const options = [
    { label: "Mercury", value: "mercury" },
    { label: "Venus", value: "venus" },
    { label: "Earth", value: "earth" },
  ];

  it("grades a correct answer and reports the display indices", () => {
    const outcome = buildOutcome({
      status: "answered",
      question: "Which planet is hottest?",
      mode: "single-select",
      options,
      selectedValues: ["venus"],
      correctValues: ["venus"],
      explanation: "Venus has the thickest CO2 atmosphere.",
    });
    expect(outcome.isCorrect).toBe(true);
    expect(outcome.correctIndices).toEqual([2]);
    expect(outcome.answers).toEqual([
      { index: 2, label: "Venus", value: "venus" },
    ]);
    expect(outcome.message).toContain("✓ correct");
    expect(outcome.message).toContain(
      "Explanation: Venus has the thickest CO2 atmosphere.",
    );
  });

  it("treats 'I don't know' as a gap, not a wrong guess", () => {
    const outcome = buildOutcome({
      status: "answered",
      question: "Which planet is hottest?",
      mode: "single-select",
      options,
      selectedValues: [],
      correctValues: ["venus"],
      dontKnow: true,
    });
    expect(outcome.isCorrect).toBeNull();
    expect(outcome.dontKnow).toBe(true);
    expect(outcome.message).toContain("genuine knowledge gap");
  });

  it("carries no verdict for pending and cancelled runs", () => {
    const pending = buildOutcome({
      status: "pending",
      question: "q",
      mode: "single-select",
      options,
    });
    expect(pending.isCorrect).toBeNull();
    expect(pending.options).toEqual(toDisplayedOptions(options));

    const cancelled = buildOutcome({
      status: "cancelled",
      question: "q",
      mode: "single-select",
      options,
    });
    expect(outcomeMessage(cancelled)).toContain("cancelled by the user");
  });

  it("explains how to fall back when no UI is available", () => {
    const unavailable = buildOutcome({
      status: "unavailable",
      question: "q",
      mode: "single-select",
      options,
    });
    expect(outcomeMessage(unavailable)).toContain("no interactive UI");
  });
});
