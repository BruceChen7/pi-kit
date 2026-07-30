import { describe, expect, it } from "vitest";
import {
  createEmptyState,
  getActiveSlugs,
  selectConcepts,
  summarizeState,
  syncConcepts,
} from "./state.js";
import { createNewEntry } from "./sm2.js";

// ── Test helpers ───────────────────────────────────────

const HOUR = 3_600_000;
const DAY = 86_400_000;

function makeEntry(slug: string, overrides: Partial<ReturnType<typeof createNewEntry>> = {}) {
  return { ...createNewEntry(slug, 0), ...overrides };
}

function makeState(concepts: Record<string, ReturnType<typeof createNewEntry>>) {
  return { version: 1 as const, concepts };
}

// ── createEmptyState ──────────────────────────────────

describe("createEmptyState", () => {
  it("should create empty state with version 1", () => {
    const state = createEmptyState();
    expect(state.version).toBe(1);
    expect(state.concepts).toEqual({});
  });
});

// ── syncConcepts ───────────────────────────────────────

describe("syncConcepts", () => {
  it("should add new concepts not in state", () => {
    const state = createEmptyState();
    const now = 1_000_000;
    const result = syncConcepts(state, new Set(["a", "b"]), now);

    expect(Object.keys(result.concepts)).toEqual(["a", "b"]);
    expect(result.concepts.a.createdAt).toBe(now);
    expect(result.concepts.a.level).toBe(0);
  });

  it("should preserve existing entries", () => {
    const existing = makeEntry("a", { level: 3, reviewCount: 5 });
    const state = makeState({ a: existing });
    const result = syncConcepts(state, new Set(["a", "b"]));

    expect(result.concepts.a.level).toBe(3);
    expect(result.concepts.a.reviewCount).toBe(5);
    expect(result.concepts.b.level).toBe(0);
  });

  it("should remove concepts no longer in the file system", () => {
    const state = makeState({
      a: makeEntry("a"),
      b: makeEntry("b"),
      c: makeEntry("c"),
    });
    const result = syncConcepts(state, new Set(["a", "c"]));

    expect(Object.keys(result.concepts)).toEqual(["a", "c"]);
    expect(result.concepts.b).toBeUndefined();
  });

  it("should not mutate the input state", () => {
    const state = createEmptyState();
    const originalKeys = Object.keys(state.concepts);
    syncConcepts(state, new Set(["x"]));
    expect(Object.keys(state.concepts)).toEqual(originalKeys);
  });
});

// ── getActiveSlugs ────────────────────────────────────

describe("getActiveSlugs", () => {
  it("should return only non-skipped slugs", () => {
    const state = makeState({
      a: makeEntry("a"),
      b: makeEntry("b", { skipped: true }),
      c: makeEntry("c"),
    });
    expect(getActiveSlugs(state)).toEqual(["a", "c"]);
  });
});

// ── selectConcepts ────────────────────────────────────

describe("selectConcepts", () => {
  it("should prefer due concepts over non-due", () => {
    const now = 1_000_000;
    const due = makeEntry("due", { nextReviewAt: now - DAY });
    const moreDue = makeEntry("more-due", { nextReviewAt: now - 2 * DAY });
    const notDue = makeEntry("not-due", { nextReviewAt: now + DAY });

    const state = makeState({ due, moreDue, notDue });
    const result = selectConcepts(state, 2, now);

    expect(result).toEqual(["more-due", "due"]);
  });

  it("should supplement with closest non-due when not enough due", () => {
    const now = 1_000_000;
    const due = makeEntry("due", { nextReviewAt: now - DAY });
    const close = makeEntry("close", { nextReviewAt: now + DAY });
    const far = makeEntry("far", { nextReviewAt: now + 7 * DAY });

    const state = makeState({ due, close, far });
    const result = selectConcepts(state, 3, now);

    expect(result).toEqual(["due", "close", "far"]);
  });

  it("should skip skipped concepts", () => {
    const now = 1_000_000;
    const state = makeState({
      a: makeEntry("a", { nextReviewAt: now - DAY, skipped: true }),
      b: makeEntry("b", { nextReviewAt: now - DAY }),
    });

    const result = selectConcepts(state, 5, now);
    expect(result).toEqual(["b"]);
  });

  it("should return empty array when no active concepts", () => {
    const state = createEmptyState();
    expect(selectConcepts(state, 5)).toEqual([]);
  });

  it("should return at most count items", () => {
    const now = 1_000_000;
    const entries: Record<string, ReturnType<typeof makeEntry>> = {};
    for (let i = 0; i < 10; i++) {
      entries[`c${i}`] = makeEntry(`c${i}`, { nextReviewAt: now - DAY });
    }

    const state = makeState(entries);
    expect(selectConcepts(state, 5, now)).toHaveLength(5);
    expect(selectConcepts(state, 3, now)).toHaveLength(3);
  });
});

// ── summarizeState ────────────────────────────────────

describe("summarizeState", () => {
  it("should return correct counts for mixed state", () => {
    const now = 1_000_000;
    const state = makeState({
      a: makeEntry("a", { nextReviewAt: now - DAY }),
      b: makeEntry("b", { nextReviewAt: now + DAY, level: 2 }),
      c: makeEntry("c", { nextReviewAt: now - DAY, level: 1 }),
      d: makeEntry("d", { skipped: true }),
    });

    const stats = summarizeState(state, now);
    expect(stats.total).toBe(4);
    expect(stats.active).toBe(3);
    expect(stats.skipped).toBe(1);
    expect(stats.due).toBe(2);
    expect(stats.levels[0]).toBe(1);
    expect(stats.levels[1]).toBe(1);
    expect(stats.levels[2]).toBe(1);
  });

  it("should handle empty state", () => {
    const state = createEmptyState();
    const stats = summarizeState(state);
    expect(stats.total).toBe(0);
    expect(stats.active).toBe(0);
    expect(stats.due).toBe(0);
    expect(stats.levels).toEqual({});
  });
});
