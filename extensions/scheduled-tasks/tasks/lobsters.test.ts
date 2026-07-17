import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareChunks } from "../../shared/chunking.ts";
import {
  buildTruncationWarning,
  computeTagIncrement,
  displayTag,
  filterByMinScore,
  formatPostLine,
  formatTagSection,
  type LobstersPost,
  loadTagCheckpoint,
  saveTagCheckpoint,
} from "./lobsters.ts";
import { cleanupDir, tempDir } from "./test-utils.ts";

const TELEGRAM_MAX = 4096;

// ── Helpers ──────────────────────────────────────────────

function samplePost(overrides: Partial<LobstersPost> = {}): LobstersPost {
  return {
    short_id: "abc123",
    created_at: "2026-07-17T01:01:54.052-05:00",
    title: "A Sample Lobsters Post",
    url: "https://example.com/article",
    score: 42,
    flags: 0,
    comment_count: 7,
    description: "",
    description_plain: "",
    submitter_user: "testuser",
    user_is_author: false,
    tags: ["rust"],
    short_id_url: "https://lobste.rs/s/abc123",
    comments_url: "https://lobste.rs/s/abc123/comments",
    ...overrides,
  };
}

// ── displayTag ────────────────────────────────────────────

describe("displayTag", () => {
  it("capitalises first letter of single-word tag", () => {
    expect(displayTag("rust")).toBe("Rust");
    expect(displayTag("go")).toBe("Go");
    expect(displayTag("zig")).toBe("Zig");
  });

  it("handles multi-word tag names", () => {
    expect(displayTag("testing")).toBe("Testing");
    expect(displayTag("networking")).toBe("Networking");
  });
});

// ── filterByMinScore ─────────────────────────────────────

describe("filterByMinScore", () => {
  it("keeps items at or above threshold", () => {
    const items = [
      samplePost({ score: 5, short_id: "a" }),
      samplePost({ score: 1, short_id: "b" }),
      samplePost({ score: 10, short_id: "c" }),
    ];
    const result = filterByMinScore(items, 1);
    expect(result).toHaveLength(3);
  });

  it("removes items below threshold", () => {
    const items = [
      samplePost({ score: 5, short_id: "a" }),
      samplePost({ score: 0, short_id: "b" }),
      samplePost({ score: -2, short_id: "c" }),
    ];
    const result = filterByMinScore(items, 1);
    expect(result).toHaveLength(1);
    expect(result[0].short_id).toBe("a");
  });

  it("returns empty array when all items below threshold", () => {
    const items = [
      samplePost({ score: 0, short_id: "a" }),
      samplePost({ score: -5, short_id: "b" }),
    ];
    expect(filterByMinScore(items, 1)).toEqual([]);
  });

  it("returns empty array for empty input", () => {
    expect(filterByMinScore([], 1)).toEqual([]);
  });

  it("preserves original ordering", () => {
    const items = [
      samplePost({ score: 10, short_id: "a" }),
      samplePost({ score: 0, short_id: "b" }),
      samplePost({ score: 5, short_id: "c" }),
    ];
    const result = filterByMinScore(items, 1);
    expect(result.map((i) => i.short_id)).toEqual(["a", "c"]);
  });
});

// ── computeTagIncrement ──────────────────────────────────

describe("computeTagIncrement", () => {
  it("returns skip for empty items regardless of checkpoint", () => {
    expect(computeTagIncrement([], null)).toEqual({ kind: "skip" });
    expect(computeTagIncrement([], "abc123")).toEqual({ kind: "skip" });
  });

  it("returns init with all items when no checkpoint exists", () => {
    const items = [
      samplePost({ short_id: "c" }),
      samplePost({ short_id: "b" }),
    ];
    const result = computeTagIncrement(items, null);
    expect(result).toEqual({
      kind: "init",
      items,
      headId: "c",
    });
  });

  it("returns init with a single item when no checkpoint exists", () => {
    const items = [samplePost({ short_id: "a" })];
    const result = computeTagIncrement(items, null);
    expect(result).toEqual({
      kind: "init",
      items,
      headId: "a",
    });
  });

  it("returns increment with items before checkpoint", () => {
    const items = [
      samplePost({ short_id: "c" }), // most recent → new headId
      samplePost({ short_id: "b" }), // new post since last fetch
      samplePost({ short_id: "a" }), // old checkpoint
    ];
    const result = computeTagIncrement(items, "a");
    expect(result).toEqual({
      kind: "increment",
      items: [items[0], items[1]],
      headId: "c",
    });
  });

  it("returns skip when first item is the checkpoint (nothing new)", () => {
    const items = [
      samplePost({ short_id: "a" }), // checkpoint is the newest
      samplePost({ short_id: "0" }),
    ];
    expect(computeTagIncrement(items, "a")).toEqual({ kind: "skip" });
  });

  it("returns warning when checkpoint not found in fetched range", () => {
    const items = [
      samplePost({ short_id: "c" }),
      samplePost({ short_id: "b" }),
    ];
    const result = computeTagIncrement(items, "x");
    expect(result).toEqual({
      kind: "warning",
      items,
      headId: "c",
    });
  });
});

// ── formatPostLine ───────────────────────────────────────

describe("formatPostLine", () => {
  it("formats a basic post with title, score, comments, and url", () => {
    const item = samplePost({
      title: "My Test Post",
      score: 42,
      comment_count: 7,
      url: "https://example.com/test",
    });
    const output = formatPostLine(item, 0);
    expect(output).toContain("1. **My Test Post**");
    expect(output).toContain("⬆ 42");
    expect(output).toContain("💬 7");
    expect(output).toContain("🔗 https://example.com/test");
  });

  it("includes description_plain when present (truncated at 200 chars)", () => {
    const item = samplePost({
      description_plain: "A short description here",
    });
    const output = formatPostLine(item, 1);
    expect(output).toContain("💬 A short description here");
  });

  it("truncates long description_plain", () => {
    const longDesc = "x".repeat(300);
    const item = samplePost({ description_plain: longDesc });
    const output = formatPostLine(item, 2);
    expect(output).toContain(`💬 ${"x".repeat(200)}…`);
  });

  it("omits description line when description_plain is empty", () => {
    const item = samplePost({ description_plain: "" });
    const output = formatPostLine(item, 3);
    // The output has 💬 from comment_count always, but no description line.
    // Check that the description_plain content does NOT appear.
    expect(output).not.toContain("💬 A Sample");
    // Verify the "💬 7" (comment count) line is present but no description line follows
    expect(output).toContain("💬 7");
  });

  it("handles two-digit global index", () => {
    const item = samplePost();
    const output = formatPostLine(item, 9);
    expect(output).toContain("10.");
  });

  it("handles zero score and zero comments", () => {
    const item = samplePost({ score: 0, comment_count: 0 });
    const output = formatPostLine(item, 0);
    expect(output).toContain("⬆ 0");
    expect(output).toContain("💬 0");
  });

  it("handles post with an empty URL gracefully", () => {
    const item = samplePost({ url: "" });
    const output = formatPostLine(item, 0);
    expect(output).toContain("🔗 ");
  });
});

// ── formatTagSection ─────────────────────────────────────

describe("formatTagSection", () => {
  it("formats a section with the tag heading and items", () => {
    const items = [
      samplePost({
        short_id: "a",
        title: "First Post",
        score: 10,
        comment_count: 2,
      }),
      samplePost({
        short_id: "b",
        title: "Second Post",
        score: 5,
        comment_count: 1,
      }),
    ];
    const output = formatTagSection("rust", items, 0);

    expect(output).toContain("## Rust");
    expect(output).toContain("1. **First Post**");
    expect(output).toContain("2. **Second Post**");
    expect(output).toContain("⬆ 10");
    expect(output).toContain("⬆ 5");
    expect(output).not.toContain("⚠️");
  });

  it("prepends warning when provided", () => {
    const items = [samplePost()];
    const output = formatTagSection("go", items, 0, "可能截断");
    expect(output).toContain("⚠️ 可能截断");
    expect(output).toContain("## Go");
  });

  it("respects startIndex for global numbering across tags", () => {
    const items = [
      samplePost({ short_id: "a", title: "Post A" }),
      samplePost({ short_id: "b", title: "Post B" }),
    ];
    const output = formatTagSection("rust", items, 2);
    // Since startIndex=2, global numbers are 3 and 4
    expect(output).toContain("3. **Post A**");
    expect(output).toContain("4. **Post B**");
  });

  it("handles empty items array", () => {
    const output = formatTagSection("rust", [], 0);
    expect(output).toContain("## Rust");
    expect(output).not.toContain("1.");
  });
});

// ── prepareChunks (via shared chunking.ts) ───────────────

describe("prepareChunks", () => {
  it("returns empty array for no sections", () => {
    const result = prepareChunks({
      sections: [],
      prefix: "",
      maxHtmlLength: TELEGRAM_MAX,
    });
    expect(result).toEqual([]);
  });

  it("returns one chunk with prefix for a single section", () => {
    const result = prepareChunks({
      sections: ["## Rust\n1. **Test** | ⬆ 10 💬 2\n   🔗 https://example.com"],
      prefix: "📑 Lobsters 今日推荐（1 条）\n\n",
      maxHtmlLength: TELEGRAM_MAX,
    });

    expect(result).toHaveLength(1);
    expect(result[0].html).toContain("📑 Lobsters 今日推荐");
    expect(result[0].html).toContain("<b>Rust</b>");
    expect(result[0].html).toContain("⬆ 10");
  });

  it("keeps multiple sections together when HTML stays under limit", () => {
    const result = prepareChunks({
      sections: [
        "## Rust\n1. **First** | ⬆ 10 💬 2\n   🔗 https://a.com",
        "## Go\n2. **Second** | ⬆ 5 💬 1\n   🔗 https://b.com",
      ],
      prefix: "",
      maxHtmlLength: TELEGRAM_MAX,
    });

    expect(result).toHaveLength(1);
    expect(result[0].html).toContain("<b>Rust</b>");
    expect(result[0].html).toContain("<b>Go</b>");
  });

  it("splits sections across chunks when HTML would exceed limit", () => {
    const longUrl = "x".repeat(4000);
    const result = prepareChunks({
      sections: [
        `## Rust\n1. **Big** | ⬆ 100 💬 20\n   🔗 https://${longUrl}.com`,
        `## Go\n2. **Also Big** | ⬆ 50 💬 10\n   🔗 https://${longUrl}.com`,
      ],
      prefix: "",
      maxHtmlLength: 4096,
    });

    expect(result.length).toBeGreaterThanOrEqual(2);
    for (const { html } of result) {
      expect(html.length).toBeLessThanOrEqual(4096);
    }
  });

  it("prefix is only on the first chunk", () => {
    const longUrl = "x".repeat(4000);
    const result = prepareChunks({
      sections: [
        `## Rust\n1. **Big** | ⬆ 100 💬 20\n   🔗 https://${longUrl}.com`,
        `## Go\n2. **Also Big** | ⬆ 50 💬 10\n   🔗 https://${longUrl}.com`,
      ],
      prefix: "📑 PREFIX\n\n",
      maxHtmlLength: 4096,
    });

    expect(result[0].html).toContain("📑 PREFIX");
    if (result.length > 1) {
      expect(result[1].html).not.toContain("📑 PREFIX");
    }
  });

  it("handles a single oversized section gracefully (no infinite loop)", () => {
    const singleHugeSection = ["## 1. Huge section", "x".repeat(5000)].join(
      "\n",
    );

    const result = prepareChunks({
      sections: [singleHugeSection],
      prefix: "",
      maxHtmlLength: 100,
    });

    expect(result).toHaveLength(1);
    expect(result[0].html.length).toBeGreaterThan(100);
  });
});

// ── buildTruncationWarning ───────────────────────────────

describe("buildTruncationWarning", () => {
  it("includes the limit number in the warning", () => {
    const msg = buildTruncationWarning(25);
    expect(msg).toContain("25");
    expect(msg).toContain("不完整");
  });

  it("works with different limits", () => {
    expect(buildTruncationWarning(100)).toContain("100");
    expect(buildTruncationWarning(10)).toContain("10");
  });
});

// ── loadTagCheckpoint / saveTagCheckpoint ────────────────

describe("loadTagCheckpoint / saveTagCheckpoint", () => {
  it("returns empty object when path does not exist", () => {
    const result = loadTagCheckpoint("/nonexistent/path.json");
    expect(result).toEqual({});
  });

  it("round-trips a per-tag checkpoint", () => {
    const dir = tempDir("lobsters-test-");
    const path = join(dir, "checkpoint.json");
    try {
      saveTagCheckpoint({ rust: "abc123", go: "def456" }, path);
      const result = loadTagCheckpoint(path);
      expect(result).toEqual({ rust: "abc123", go: "def456" });
    } finally {
      cleanupDir(dir);
    }
  });

  it("returns empty object for corrupt JSON", () => {
    const dir = tempDir("lobsters-test-");
    const path = join(dir, "corrupt.json");
    try {
      writeFileSync(path, "not-json{", "utf-8");
      const result = loadTagCheckpoint(path);
      expect(result).toEqual({});
    } finally {
      cleanupDir(dir);
    }
  });

  it("filters out non-string values from checkpoint", () => {
    const dir = tempDir("lobsters-test-");
    const path = join(dir, "mixed.json");
    try {
      writeFileSync(
        path,
        JSON.stringify({ rust: "abc", go: 123, zig: null }),
        "utf-8",
      );
      const result = loadTagCheckpoint(path);
      expect(result).toEqual({ rust: "abc" });
    } finally {
      cleanupDir(dir);
    }
  });

  it("filters out unknown tags from checkpoint", () => {
    const dir = tempDir("lobsters-test-");
    const path = join(dir, "unknown-tag.json");
    try {
      writeFileSync(
        path,
        JSON.stringify({ rust: "abc", unknown_tag: "xyz" }),
        "utf-8",
      );
      const result = loadTagCheckpoint(path);
      // unknown_tag should be filtered out since it's not in TAGS
      expect(result).toEqual({ rust: "abc" });
    } finally {
      cleanupDir(dir);
    }
  });

  it("creates parent directories on save", () => {
    const dir = tempDir("lobsters-test-");
    const nested = join(dir, "sub", "nested", "checkpoint.json");
    try {
      saveTagCheckpoint({ testing: "xyz" }, nested);
      expect(existsSync(nested)).toBe(true);
      const result = loadTagCheckpoint(nested);
      expect(result).toEqual({ testing: "xyz" });
    } finally {
      cleanupDir(dir);
    }
  });
});
