import { describe, expect, it } from "vitest";
import {
  formatLocalDate,
  getTodayDateString,
  validatePathDate,
} from "./controller.js";

describe("formatLocalDate", () => {
  it("returns the date's own local calendar components", () => {
    expect(formatLocalDate(new Date(2026, 10, 5, 0, 30))).toBe("2026-11-05");
    expect(formatLocalDate(new Date(2026, 0, 1, 23, 59))).toBe("2026-01-01");
    expect(formatLocalDate(new Date(2026, 11, 31, 12, 0))).toBe("2026-12-31");
  });

  it("zero-pads month and day", () => {
    expect(formatLocalDate(new Date(2026, 0, 9, 8, 0))).toBe("2026-01-09");
  });

  it("agrees with the host's local calendar, not UTC", () => {
    const justAfterLocalMidnight = new Date(2026, 10, 15, 0, 5);
    expect(formatLocalDate(justAfterLocalMidnight)).toBe("2026-11-15");
    expect(formatLocalDate(justAfterLocalMidnight)).toBe(
      justAfterLocalMidnight.toLocaleDateString("sv-SE"),
    );
  });
});

describe("getTodayDateString", () => {
  it("returns date in YYYY-MM-DD format", () => {
    expect(getTodayDateString()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("matches today's local date", () => {
    expect(getTodayDateString()).toBe(new Date().toLocaleDateString("sv-SE"));
  });
});

describe("validatePathDate", () => {
  it("returns null when path date matches today", () => {
    const result = validatePathDate(
      ".pi/plans/pi-kit/plan/2026-11-15-my-plan.md",
      "2026-11-15",
    );
    expect(result).toBeNull();
  });

  it("returns null when path date matches today (spec path)", () => {
    const result = validatePathDate(
      ".pi/plans/pi-kit/specs/2026-11-15-my-plan-design.md",
      "2026-11-15",
    );
    expect(result).toBeNull();
  });

  it("returns error message when path date is earlier than today", () => {
    const result = validatePathDate(
      ".pi/plans/pi-kit/plan/2020-01-01-old-plan.md",
      "2026-11-15",
    );
    expect(result).toContain('"2020-01-01"');
    expect(result).toContain('today is "2026-11-15"');
    expect(result).toContain("rename");
    expect(result).toContain(".pi/plans/<repo>/plan/2026-11-15-");
  });

  it("returns error message when path date is in the future", () => {
    const result = validatePathDate(
      ".pi/plans/pi-kit/plan/2099-12-31-future-plan.md",
      "2026-11-15",
    );
    expect(result).toContain('"2099-12-31"');
    expect(result).toContain('today is "2026-11-15"');
  });

  it("takes today as an input instead of reading the clock", () => {
    expect(
      validatePathDate(
        ".pi/plans/pi-kit/plan/1999-12-31-past.md",
        "1999-12-31",
      ),
    ).toBeNull();
  });

  it("returns null for paths without a date pattern", () => {
    expect(
      validatePathDate(
        ".pi/plans/pi-kit/issues/some-topic/notes.md",
        "2026-11-15",
      ),
    ).toBeNull();
  });

  it("returns null for paths with invalid date format", () => {
    expect(
      validatePathDate(
        ".pi/plans/pi-kit/plan/not-a-date-my-plan.md",
        "2026-11-15",
      ),
    ).toBeNull();
  });
});
