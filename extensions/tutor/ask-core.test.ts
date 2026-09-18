import { describe, expect, it } from "vitest";
import {
  ASK_SUBMIT_ID,
  askMessage,
  askMode,
  askRowId,
  buildAskDetails,
  buildAskRows,
  normalizeAskOptions,
  OTHER_ID,
  resolveSelections,
  toDisplayedOptions,
} from "./ask-core.ts";

const options = [
  { label: "从理论开始" },
  { label: "从实践开始", value: "practice" },
  { label: "  " },
];

describe("ask-core / normalizeAskOptions", () => {
  it("trims labels, defaults value to the label and drops empty labels", () => {
    expect(normalizeAskOptions(options)).toEqual([
      { label: "从理论开始", value: "从理论开始", description: undefined },
      { label: "从实践开始", value: "practice", description: undefined },
    ]);
    expect(normalizeAskOptions(undefined)).toEqual([]);
  });

  it("keeps duplicate labels distinguishable by row id", () => {
    const rows = buildAskRows(
      normalizeAskOptions([{ label: "a" }, { label: "a" }]),
      "single-select",
    );
    expect(rows.slice(0, 2).map((row) => row.id)).toEqual([
      askRowId(0),
      askRowId(1),
    ]);
  });
});

describe("ask-core / modes and rows", () => {
  it("falls back to free text when there are no options", () => {
    expect(askMode([], false)).toBe("free-text");
    expect(askMode([{ label: "a", value: "a" }], false)).toBe("single-select");
    expect(askMode([{ label: "a", value: "a" }], true)).toBe("multi-select");
  });

  it("always appends 'Other…' and only adds Submit for multi-select", () => {
    const single = buildAskRows(normalizeAskOptions(options), "single-select");
    expect(single.at(-1)?.id).toBe(OTHER_ID);
    expect(single.some((row) => row.id === ASK_SUBMIT_ID)).toBe(false);

    const multi = buildAskRows(normalizeAskOptions(options), "multi-select");
    expect(multi.map((row) => row.id)).toEqual([
      "ask:0",
      "ask:1",
      OTHER_ID,
      ASK_SUBMIT_ID,
    ]);
  });
});

describe("ask-core / selections", () => {
  it("maps row ids back to 1-based selections in the author's order", () => {
    const normalized = normalizeAskOptions(options);
    expect(resolveSelections(normalized, ["ask:1", "ask:0"])).toEqual([
      { index: 2, label: "从实践开始", value: "practice" },
      { index: 1, label: "从理论开始", value: "从理论开始" },
    ]);
  });

  it("ignores ids that are not real options", () => {
    expect(
      resolveSelections(normalizeAskOptions(options), [
        OTHER_ID,
        ASK_SUBMIT_ID,
      ]),
    ).toEqual([]);
  });

  it("numbers displayed options from 1 in author order", () => {
    expect(toDisplayedOptions(normalizeAskOptions(options))).toEqual([
      { index: 1, label: "从理论开始" },
      { index: 2, label: "从实践开始" },
    ]);
  });
});

describe("ask-core / details and message", () => {
  const base = {
    status: "answered" as const,
    question: "先学哪块？",
    mode: "single-select" as const,
    options: normalizeAskOptions(options),
  };

  it("reports the picked option", () => {
    const details = buildAskDetails({ ...base, selectedIds: ["ask:1"] });
    expect(details.message).toContain("2. 从实践开始");
    expect(details.selections).toHaveLength(1);
  });

  it("reports free-text answers", () => {
    const details = buildAskDetails({ ...base, otherText: "先讲幂等性" });
    expect(details.message).toContain("先讲幂等性");
  });

  it("flags dismissed and empty answers explicitly", () => {
    expect(
      askMessage(buildAskDetails({ ...base, status: "cancelled" })),
    ).toContain("dismissed");
    expect(askMessage(buildAskDetails({ ...base, selectedIds: [] }))).toContain(
      "empty selection",
    );
    expect(
      askMessage(buildAskDetails({ ...base, status: "pending" })),
    ).toContain("waiting");
    expect(
      askMessage(buildAskDetails({ ...base, status: "unavailable" })),
    ).toContain("no interactive UI");
  });
});
