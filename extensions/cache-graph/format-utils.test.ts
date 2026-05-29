import { describe, expect, it } from "vitest";
import { formatShortTimeRange, formatShortTimestamp } from "./format-utils.ts";

describe("formatShortTimestamp", () => {
  it("formats timestamps into a compact local label", () => {
    expect(formatShortTimestamp("2026-05-22T10:03:45.000Z")).toMatch(
      /^\d{2}-\d{2} \d{2}:\d{2}$/,
    );
  });

  it("falls back to a trimmed raw timestamp for invalid dates", () => {
    expect(formatShortTimestamp("not-a-date-value")).toBe("not-a-date-value");
  });
});

describe("formatShortTimeRange", () => {
  it("collapses same-day ranges", () => {
    expect(
      formatShortTimeRange(
        "2026-05-22T10:03:00.000Z",
        "2026-05-22T10:15:00.000Z",
      ),
    ).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}–\d{2}:\d{2}$/);
  });

  it("keeps both sides when the dates differ", () => {
    expect(
      formatShortTimeRange(
        "2026-05-22T10:00:00.000Z",
        "2026-05-24T10:00:00.000Z",
      ),
    ).toMatch(/^\d{2}-\d{2} \d{2}:\d{2} – \d{2}-\d{2} \d{2}:\d{2}$/);
  });
});
