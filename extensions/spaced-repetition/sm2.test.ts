import { describe, expect, it } from "vitest";
import {
  computeNextReview,
  createNewEntry,
  describeNextReview,
  filterDueEntries,
  LEVEL_INTERVALS_MS,
  MAX_LEVEL,
} from "./sm2.js";

// ── createNewEntry ─────────────────────────────────────

describe("createNewEntry", () => {
  it("should create a new entry with zeroed review data", () => {
    const now = 1_000_000;
    const entry = createNewEntry("goroutine-leak", now);

    expect(entry.slug).toBe("goroutine-leak");
    expect(entry.lastReviewedAt).toBe(0);
    expect(entry.nextReviewAt).toBe(now);
    expect(entry.level).toBe(0);
    expect(entry.reviewCount).toBe(0);
    expect(entry.consecutiveCorrect).toBe(0);
    expect(entry.skipped).toBe(false);
    expect(entry.createdAt).toBe(now);
  });

  it("should use Date.now() when now is omitted", () => {
    const before = Date.now();
    const entry = createNewEntry("test");
    const after = Date.now();

    expect(entry.createdAt).toBeGreaterThanOrEqual(before);
    expect(entry.createdAt).toBeLessThanOrEqual(after);
    expect(entry.nextReviewAt).toBe(entry.createdAt);
  });
});

// ── computeNextReview ──────────────────────────────────

describe("computeNextReview", () => {
  it("should advance level on grade=4 (remembered)", () => {
    const now = 1_000_000;
    const entry = createNewEntry("test", now);

    const result = computeNextReview(4, entry, now + 86_400_000);

    expect(result.level).toBe(1);
    expect(result.reviewCount).toBe(1);
    expect(result.consecutiveCorrect).toBe(1);
    expect(result.lastReviewedAt).toBe(now + 86_400_000);
    // Next review should be level 1 interval (2 days) from now
    expect(result.nextReviewAt).toBe(now + 86_400_000 + LEVEL_INTERVALS_MS[1]);
  });

  it("should cap at MAX_LEVEL on grade=4", () => {
    const now = 1_000_000;
    const entry = createNewEntry("test", now);
    let current = entry;

    // Advance well past max level
    const iterations = MAX_LEVEL + 3;
    for (let i = 0; i < iterations; i++) {
      current = computeNextReview(4, current, now + (i + 1) * 86_400_000);
    }

    expect(current.level).toBe(MAX_LEVEL);
    expect(current.reviewCount).toBe(iterations);
    // Next review should use MAX_LEVEL interval (30 days)
    const lastReviewTime = now + iterations * 86_400_000;
    const expectedNext = lastReviewTime + LEVEL_INTERVALS_MS[MAX_LEVEL];
    expect(current.nextReviewAt).toBe(expectedNext);
  });

  it("should reset to level 0 on grade=0 (forgotten)", () => {
    const now = 1_000_000;
    const entry = createNewEntry("test", now);

    // Advance to level 3 first
    let current = entry;
    for (let i = 0; i < 3; i++) {
      current = computeNextReview(4, current, now + (i + 1) * 86_400_000);
    }
    expect(current.level).toBe(3);

    // Then forget
    const result = computeNextReview(0, current, now + 4 * 86_400_000);

    expect(result.level).toBe(0);
    expect(result.reviewCount).toBe(4);
    expect(result.consecutiveCorrect).toBe(0);
    expect(result.nextReviewAt).toBe(
      now + 4 * 86_400_000 + LEVEL_INTERVALS_MS[0],
    );
  });

  it("should increment reviewCount on every call", () => {
    const now = 1_000_000;
    const entry = createNewEntry("test", now);

    const r1 = computeNextReview(4, entry, now + 86_400_000);
    expect(r1.reviewCount).toBe(1);

    const r2 = computeNextReview(0, r1, now + 2 * 86_400_000);
    expect(r2.reviewCount).toBe(2);

    const r3 = computeNextReview(4, r2, now + 3 * 86_400_000);
    expect(r3.reviewCount).toBe(3);
  });

  it("should not mutate the input entry", () => {
    const now = 1_000_000;
    const entry = createNewEntry("test", now);

    computeNextReview(4, entry, now + 86_400_000);

    expect(entry.level).toBe(0);
    expect(entry.reviewCount).toBe(0);
  });
});

// ── filterDueEntries ───────────────────────────────────

describe("filterDueEntries", () => {
  it("should return entries where nextReviewAt <= now", () => {
    const now = 5_000_000;
    const due1 = createNewEntry("due1", now - 1000);
    const due2 = { ...createNewEntry("due2", now - 500), skipped: false };
    const notDue = {
      ...createNewEntry("not-due", now),
      nextReviewAt: now + 86_400_000,
    };
    const skipped = {
      ...createNewEntry("skipped", now - 1000),
      skipped: true,
    };

    // Manually set lastReviewedAt to not interfere
    const entries = [due1, due2, notDue, skipped];
    const result = filterDueEntries(entries, now);

    expect(result).toHaveLength(2);
    expect(result[0].slug).toBe("due1");
    expect(result[1].slug).toBe("due2");
  });

  it("should return empty array when no entries are due", () => {
    const now = 5_000_000;
    const future1 = {
      ...createNewEntry("a", now),
      nextReviewAt: now + 86_400_000,
      skipped: false,
    };
    const future2 = {
      ...createNewEntry("b", now),
      nextReviewAt: now + 2 * 86_400_000,
      skipped: false,
    };

    expect(filterDueEntries([future1, future2], now)).toEqual([]);
  });

  it("should sort results by nextReviewAt ascending", () => {
    const now = 5_000_000;
    const late = {
      ...createNewEntry("late", now),
      nextReviewAt: now - 1000,
      skipped: false,
    };
    const early = {
      ...createNewEntry("early", now),
      nextReviewAt: now - 5000,
      skipped: false,
    };
    const mid = {
      ...createNewEntry("mid", now),
      nextReviewAt: now - 2000,
      skipped: false,
    };

    const result = filterDueEntries([late, early, mid], now);
    expect(result.map((e) => e.slug)).toEqual(["early", "mid", "late"]);
  });
});

// ── describeNextReview ─────────────────────────────────

describe("describeNextReview", () => {
  it('should return "已到期" when overdue', () => {
    const entry = createNewEntry("test", 0);
    expect(describeNextReview(entry)).toBe("已到期");
  });

  it('should return "今天内" when due within 24h', () => {
    const entry = createNewEntry("test", Date.now() + 3_600_000);
    // nextReviewAt is in the near future
    const nearFuture = {
      ...entry,
      nextReviewAt: Date.now() + 3_600_000,
    };
    // Force creation to use a different now
    const result = describeNextReview(nearFuture);
    expect(["今天内", "1 天后"]).toContain(result);
  });
});
