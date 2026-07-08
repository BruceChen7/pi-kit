import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildTruncationWarning,
  loadCheckpoint,
  parseBookmarkItems,
  prepareBookmarkChunks,
  saveCheckpoint,
} from "../../shared/bookmark-pipeline.ts";
import {
  type BookmarkItem,
  computeIncrement,
  formatIncrement,
} from "./bookmarks.ts";

const TELEGRAM_MAX = 4096;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "bkmk-test-"));
}

function cleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures
  }
}

const sampleItem = (overrides: Partial<BookmarkItem> = {}): BookmarkItem => {
  const author = overrides.author ?? "alice";
  const id = overrides.id ?? "1";
  return {
    id,
    author,
    name: "Alice",
    text: "hello world",
    likes: 5,
    retweets: 1,
    bookmarks: 2,
    created_at: "Wed Apr 16 10:00:00 +0000 2026",
    url: `https://x.com/${author}/status/${id}`,
    has_media: false,
    media_urls: [],
    ...overrides,
  };
};

describe("computeIncrement", () => {
  it("returns skip for empty items regardless of checkpoint", () => {
    expect(computeIncrement([], { lastHeadTweetId: null })).toEqual({
      kind: "skip",
    });
    expect(computeIncrement([], { lastHeadTweetId: "1" })).toEqual({
      kind: "skip",
    });
  });

  it("returns init with all items when no checkpoint exists", () => {
    const items = [sampleItem({ id: "3" }), sampleItem({ id: "2" })];
    expect(computeIncrement(items, { lastHeadTweetId: null })).toEqual({
      kind: "init",
      items,
      headId: "3",
    });
  });

  it("returns increment with items before checkpoint", () => {
    const items = [
      sampleItem({ id: "3" }), // most recent bookmark → new headId
      sampleItem({ id: "2" }), // new bookmark (before old head)
      sampleItem({ id: "1" }), // old checkpoint
    ];
    const result = computeIncrement(items, { lastHeadTweetId: "1" });
    expect(result).toEqual({
      kind: "increment",
      items: [items[0], items[1]],
      headId: "3",
    });
  });

  it("returns skip when first item is the checkpoint (nothing new)", () => {
    const items = [sampleItem({ id: "1" }), sampleItem({ id: "0" })];
    expect(computeIncrement(items, { lastHeadTweetId: "1" })).toEqual({
      kind: "skip",
    });
  });

  it("returns warning when checkpoint not found in fetched range", () => {
    const items = [sampleItem({ id: "3" }), sampleItem({ id: "2" })];
    const result = computeIncrement(items, { lastHeadTweetId: "1" });
    expect(result).toEqual({
      kind: "warning",
      items,
      headId: "3",
    });
  });
});

describe("formatIncrement", () => {
  it("formats a single item without warning", () => {
    const items = [
      sampleItem({
        id: "1",
        author: "bob",
        text: "hello",
      }),
    ];
    const output = formatIncrement(items);
    expect(output).toContain("## 1.");
    expect(output).toContain("@bob");
    expect(output).toContain("hello");
    expect(output).toContain("x.com/bob/status/1");
    expect(output).not.toContain("⚠️");
  });

  it("prepends warning when provided", () => {
    const items = [sampleItem()];
    const output = formatIncrement(items, "可能截断");
    expect(output).toContain("⚠️");
    expect(output).toContain("可能截断");
  });

  it("truncates very long text with ellipsis", () => {
    const longText = "x".repeat(500);
    const items = [sampleItem({ text: longText })];
    const output = formatIncrement(items);
    expect(output).toContain(`${"x".repeat(300)}…`);
    expect(output).not.toContain("x".repeat(301));
  });

  it("numbers items sequentially", () => {
    const items = [sampleItem({ id: "1" }), sampleItem({ id: "2" })];
    const output = formatIncrement(items);
    expect(output).toContain("## 1.");
    expect(output).toContain("## 2.");
  });
});

describe("parseBookmarkItems", () => {
  it("parses a valid JSON array", () => {
    const json = JSON.stringify([
      { id: "1", author: "a", text: "hi" },
      { id: "2", author: "b", text: "hello" },
    ]);
    const items = parseBookmarkItems(json);
    expect(items).toHaveLength(2);
    expect(items[0].id).toBe("1");
    expect(items[1].id).toBe("2");
  });

  it("throws on non-array JSON", () => {
    expect(() => parseBookmarkItems('{"id":"1"}')).toThrow(
      /Expected JSON array/,
    );
  });

  it("throws on invalid JSON", () => {
    expect(() => parseBookmarkItems("not-json")).toThrow();
  });
});

describe("buildTruncationWarning", () => {
  it("includes the limit number in the warning", () => {
    const msg = buildTruncationWarning(200);
    expect(msg).toContain("200");
  });
});

describe("loadCheckpoint / saveCheckpoint", () => {
  const FIELD = "lastHeadTweetId";

  it("returns null when path does not exist", () => {
    expect(loadCheckpoint("/nonexistent/path.json", FIELD)).toBeNull();
  });

  it("round-trips a checkpoint value", () => {
    const dir = tempDir();
    const path = join(dir, "checkpoint.json");
    try {
      saveCheckpoint(FIELD, "abc123", path);
      expect(loadCheckpoint(path, FIELD)).toBe("abc123");
    } finally {
      cleanupDir(dir);
    }
  });

  it("returns null for corrupt JSON", () => {
    const dir = tempDir();
    const path = join(dir, "corrupt.json");
    try {
      writeFileSync(path, "not-json{", "utf-8");
      expect(loadCheckpoint(path, FIELD)).toBeNull();
    } finally {
      cleanupDir(dir);
    }
  });

  it("creates parent directories on save", () => {
    const dir = tempDir();
    const nested = join(dir, "sub", "nested", "checkpoint.json");
    try {
      saveCheckpoint(FIELD, "xyz", nested);
      expect(existsSync(nested)).toBe(true);
      expect(loadCheckpoint(nested, FIELD)).toBe("xyz");
    } finally {
      cleanupDir(dir);
    }
  });
});

describe("prepareBookmarkChunks", () => {
  it("returns empty array for empty output", () => {
    const result = prepareBookmarkChunks({
      rawOutput: "",
      prefix: "📑 Prefix\n\n",
      maxChunkLength: 3800,
      maxHtmlLength: TELEGRAM_MAX,
    });

    expect(result).toEqual([]);
  });

  it("returns one chunk with prefix for a single entry", () => {
    const result = prepareBookmarkChunks({
      rawOutput: "# Bookmarks\n\nplain text",
      prefix: "📑 Prefix\n\n",
      maxChunkLength: 3800,
      maxHtmlLength: TELEGRAM_MAX,
    });

    expect(result).toHaveLength(1);
    expect(result[0].html).toContain("📑 Prefix");
    expect(result[0].html).toContain("<b>Bookmarks</b>");
    expect(result[0].html).toContain("plain text");
  });

  it("strips **bold** markers inside headings to prevent nested <b>", () => {
    const result = prepareBookmarkChunks({
      rawOutput: "## 1. AI **coding** agents\ncontent",
      prefix: "",
      maxChunkLength: 3800,
      maxHtmlLength: TELEGRAM_MAX,
    });

    expect(result).toHaveLength(1);
    const html = result[0].html;
    // The heading <b> wraps the whole line; bold markers ** are stripped
    expect(html).toContain("<b>1. AI coding agents</b>");
    // No nested <b> inside heading
    expect(html).not.toContain("<b>1. AI <b>coding</b> agents</b>");
  });

  it("converts non-heading bold markers to <b> tags", () => {
    const result = prepareBookmarkChunks({
      rawOutput: "## Heading\nSome **important** text",
      prefix: "",
      maxChunkLength: 3800,
      maxHtmlLength: TELEGRAM_MAX,
    });

    expect(result).toHaveLength(1);
    const html = result[0].html;
    expect(html).toContain("<b>Heading</b>");
    expect(html).toContain("<b>important</b>");
  });

  it("splits entries across chunks when HTML would exceed maxHtmlLength", () => {
    // Each entry has a long enough link line that HTML expansion pushes it over limit
    const entry = [
      "## 1. Entry title",
      "- 作者：@user",
      `- 链接：${"x".repeat(4000)}`,
    ].join("\n");

    const rawOutput = [entry, entry].join("\n");

    const result = prepareBookmarkChunks({
      rawOutput,
      prefix: "",
      maxChunkLength: 5000, // raw limit is lenient
      maxHtmlLength: 4096, // but HTML limit is strict
    });

    // Must produce at least 2 chunks since each entry's HTML is ~4000+ chars
    expect(result.length).toBeGreaterThanOrEqual(2);

    // Each chunk is a complete entry (no splitting mid-entry)
    for (const { html } of result) {
      expect(html).toMatch(/^<b>1\. Entry/);
      expect(html.length).toBeLessThanOrEqual(4096);
    }
  });

  it("keeps entries together when HTML stays under maxHtmlLength", () => {
    const rawOutput = [
      "## 1. First",
      "content 1",
      "## 2. Second",
      "content 2",
    ].join("\n");

    const result = prepareBookmarkChunks({
      rawOutput,
      prefix: "",
      maxChunkLength: 3800,
      maxHtmlLength: 4096,
    });

    // Both entries fit in one chunk
    expect(result).toHaveLength(1);
    expect(result[0].html).toContain("<b>1. First</b>");
    expect(result[0].html).toContain("<b>2. Second</b>");
  });

  it("preserves inline code and links in the conversion", () => {
    const result = prepareBookmarkChunks({
      rawOutput:
        "# Summary\nSee `code & stuff` and [docs](https://example.com)",
      prefix: "",
      maxChunkLength: 3800,
      maxHtmlLength: TELEGRAM_MAX,
    });

    expect(result).toHaveLength(1);
    const html = result[0].html;
    expect(html).toContain("<code>code & stuff</code>");
    expect(html).toContain('<a href="https://example.com">docs</a>');
  });

  it("handles raw HTML characters by escaping them", () => {
    const result = prepareBookmarkChunks({
      rawOutput: "# Title\na < b & c > d",
      prefix: "",
      maxChunkLength: 3800,
      maxHtmlLength: TELEGRAM_MAX,
    });

    expect(result).toHaveLength(1);
    const html = result[0].html;
    expect(html).toContain("a &lt; b &amp; c &gt; d");
  });

  it("handles multiple chunks with prefix only on first", () => {
    // Each entry individually fits in maxHtmlLength, but two combined exceed it
    const entryLines = (n: number, char: string) =>
      [`## ${n}. Entry ${n}`, char.repeat(80)].join("\n");
    const rawOutput = [
      "# Bookmarks",
      entryLines(1, "a"),
      entryLines(2, "b"),
      entryLines(3, "c"),
    ].join("\n");

    const result = prepareBookmarkChunks({
      rawOutput,
      prefix: "📑 X Bookmarks\n\n",
      maxChunkLength: 500,
      // Each entry is ~100 HTML chars, two entries ~200 — 150 forces each alone
      maxHtmlLength: 150,
    });

    expect(result.length).toBeGreaterThan(1);
    // Only first chunk has the prefix
    expect(result[0].html).toContain("📑 X Bookmarks");
    for (let i = 1; i < result.length; i++) {
      expect(result[i].html).not.toContain("📑 X Bookmarks");
    }
  });

  it("handles a single oversized entry gracefully (no infinite loop)", () => {
    // Single entry whose content alone exceeds maxHtmlLength
    const singleHugeEntry = ["## 1. Huge entry", "x".repeat(5000)].join("\n");

    const result = prepareBookmarkChunks({
      rawOutput: singleHugeEntry,
      prefix: "",
      maxChunkLength: 5000,
      maxHtmlLength: 100,
    });

    // Should produce exactly 1 chunk (can't split mid-entry)
    expect(result).toHaveLength(1);
    // HTML will exceed the limit, but that's expected — no crash/loop
    expect(result[0].html.length).toBeGreaterThan(100);
  });
});
