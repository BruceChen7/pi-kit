import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "./index.ts";

describe("formatRelativeTime", () => {
  it('returns "just now" for < 1 minute', () => {
    expect(formatRelativeTime(Date.now())).toBe("just now");
  });

  it("returns Xm ago for < 1 hour", () => {
    const past = Date.now() - 300_000; // 5 min
    expect(formatRelativeTime(past)).toBe("5m ago");
  });

  it("returns Xh ago for < 24 hours", () => {
    const past = Date.now() - 7_200_000; // 2 hours
    expect(formatRelativeTime(past)).toBe("2h ago");
  });

  it("returns Xd ago for > 24 hours", () => {
    const past = Date.now() - 172_800_000; // 2 days
    expect(formatRelativeTime(past)).toBe("2d ago");
  });

  it("handles boundary at exactly 1 minute", () => {
    const past = Date.now() - 60_000; // 60s
    const result = formatRelativeTime(past);
    // Should be "1m ago" or "just now" depending on timing
    expect(["1m ago", "just now"]).toContain(result);
  });
});
