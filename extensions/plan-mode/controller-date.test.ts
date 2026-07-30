import { describe, expect, it } from "vitest";
import { getTodayDateString, validatePathDate } from "./controller.js";

describe("getTodayDateString", () => {
  it("returns date in YYYY-MM-DD format", () => {
    expect(getTodayDateString()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("matches today's date from new Date", () => {
    const expected = new Date().toISOString().slice(0, 10);
    expect(getTodayDateString()).toBe(expected);
  });
});

describe("validatePathDate", () => {
  it("returns null when path date matches today", () => {
    const today = getTodayDateString();
    const result = validatePathDate(
      `.pi/plans/pi-kit/plan/${today}-my-plan.md`,
    );
    expect(result).toBeNull();
  });

  it("returns null when path date matches today (spec path)", () => {
    const today = getTodayDateString();
    const result = validatePathDate(
      `.pi/plans/pi-kit/specs/${today}-my-plan-design.md`,
    );
    expect(result).toBeNull();
  });

  it("returns error message when path date is earlier than today", () => {
    const result = validatePathDate(
      ".pi/plans/pi-kit/plan/2020-01-01-old-plan.md",
    );
    expect(result).toContain('"2020-01-01"');
    expect(result).toContain("today is");
    expect(result).toContain(getTodayDateString());
    expect(result).toContain("Fix:");
    expect(result).toContain(".pi/plans/<repo>/plan/");
  });

  it("returns error message when path date is in the future", () => {
    const result = validatePathDate(
      ".pi/plans/pi-kit/plan/2099-12-31-future-plan.md",
    );
    expect(result).toContain('"2099-12-31"');
    expect(result).toContain("today is");
    expect(result).toContain(getTodayDateString());
  });

  it("returns null for paths without a date pattern", () => {
    expect(
      validatePathDate(".pi/plans/pi-kit/issues/some-topic/notes.md"),
    ).toBeNull();
  });

  it("returns null for paths with invalid date format", () => {
    expect(
      validatePathDate(".pi/plans/pi-kit/plan/not-a-date-my-plan.md"),
    ).toBeNull();
  });
});
