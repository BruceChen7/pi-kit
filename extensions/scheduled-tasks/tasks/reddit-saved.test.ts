import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildTruncationWarning,
  computeIncrement,
  extractPostIdFromUrl,
  formatSavedPost,
  formatSavedPosts,
  loadCheckpoint,
  parseSavedItems,
  prepareSavedChunks,
  type SavedPost,
  saveCheckpoint,
  splitEntries,
} from "./reddit-saved.ts";

const TELEGRAM_MAX = 4096;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "reddit-saved-test-"));
}

function cleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures
  }
}

function samplePost(overrides: Partial<SavedPost> = {}): SavedPost {
  const id = overrides.url ? extractPostIdFromUrl(overrides.url) : "1u5g1wo";
  return {
    title: "Minimal subagents for Pi",
    subreddit: "r/PiCodingAgent",
    score: 23,
    comments: 5,
    url: `https://www.reddit.com/r/PiCodingAgent/comments/${id}/title/`,
    ...overrides,
  };
}

describe("extractPostIdFromUrl", () => {
  it("extracts post ID from a standard URL", () => {
    expect(
      extractPostIdFromUrl(
        "https://www.reddit.com/r/neovim/comments/1twb7s8/my_first_neovim_plugin/",
      ),
    ).toBe("1twb7s8");
  });

  it("extracts post ID from a URL with comment permalink suffix", () => {
    expect(
      extractPostIdFromUrl(
        "https://www.reddit.com/r/PiCodingAgent/comments/1tvko93/title/opiff4v/",
      ),
    ).toBe("1tvko93");
  });

  it("throws on URL without /comments/ segment", () => {
    expect(() =>
      extractPostIdFromUrl("https://www.reddit.com/r/test/"),
    ).toThrow(/Cannot extract post ID/);
  });

  it("throws on empty URL", () => {
    expect(() => extractPostIdFromUrl("")).toThrow(/Cannot extract post ID/);
  });
});

describe("computeIncrement", () => {
  it("returns skip for empty items regardless of checkpoint", () => {
    expect(computeIncrement([], { lastHeadPostId: null })).toEqual({
      kind: "skip",
    });
    expect(computeIncrement([], { lastHeadPostId: "1" })).toEqual({
      kind: "skip",
    });
  });

  it("returns init with all items when no checkpoint exists", () => {
    const items = [
      samplePost({ url: "https://www.reddit.com/r/a/comments/3/t/" }),
      samplePost({ url: "https://www.reddit.com/r/a/comments/2/t/" }),
    ];
    const result = computeIncrement(items, { lastHeadPostId: null });
    expect(result).toEqual({
      kind: "init",
      items,
      headId: "3",
    });
  });

  it("returns init with a single item when no checkpoint exists", () => {
    const items = [
      samplePost({ url: "https://www.reddit.com/r/a/comments/1/t/" }),
    ];
    const result = computeIncrement(items, { lastHeadPostId: null });
    expect(result).toEqual({
      kind: "init",
      items,
      headId: "1",
    });
  });

  it("returns increment with items before checkpoint", () => {
    const items = [
      samplePost({ url: "https://www.reddit.com/r/a/comments/3/t/" }), // most recent → new headId
      samplePost({ url: "https://www.reddit.com/r/a/comments/2/t/" }), // new saved post
      samplePost({ url: "https://www.reddit.com/r/a/comments/1/t/" }), // old checkpoint
    ];
    const result = computeIncrement(items, { lastHeadPostId: "1" });
    expect(result).toEqual({
      kind: "increment",
      items: [items[0], items[1]],
      headId: "3",
    });
  });

  it("returns skip when first item is the checkpoint (nothing new)", () => {
    const items = [
      samplePost({ url: "https://www.reddit.com/r/a/comments/1/t/" }),
      samplePost({ url: "https://www.reddit.com/r/a/comments/0/t/" }),
    ];
    expect(computeIncrement(items, { lastHeadPostId: "1" })).toEqual({
      kind: "skip",
    });
  });

  it("returns warning when checkpoint not found in fetched range", () => {
    const items = [
      samplePost({ url: "https://www.reddit.com/r/a/comments/3/t/" }),
      samplePost({ url: "https://www.reddit.com/r/a/comments/2/t/" }),
    ];
    const result = computeIncrement(items, { lastHeadPostId: "1" });
    expect(result).toEqual({
      kind: "warning",
      items,
      headId: "3",
    });
  });
});

describe("formatSavedPost", () => {
  it("formats a single post entry", () => {
    const item = samplePost({
      title: "My Title",
      subreddit: "r/test",
      score: 42,
      comments: 7,
      url: "https://www.reddit.com/r/test/comments/abc123/title/",
    });
    const output = formatSavedPost(item, 0);
    expect(output).toContain("## 1.");
    expect(output).toContain("r/test");
    expect(output).toContain("⬆ 42");
    expect(output).toContain("💬 7");
    expect(output).toContain(
      "[My Title](https://www.reddit.com/r/test/comments/abc123/title/)",
    );
  });

  it("handles index 9 to 10 correctly (two-digit numbering)", () => {
    const item = samplePost();
    const output9 = formatSavedPost(item, 9);
    const output10 = formatSavedPost(item, 10);
    expect(output9).toContain("## 10.");
    expect(output10).toContain("## 11.");
  });
});

describe("formatSavedPosts", () => {
  it("formats multiple items without warning", () => {
    const items = [
      samplePost({ title: "First", subreddit: "r/a" }),
      samplePost({ title: "Second", subreddit: "r/b" }),
    ];
    const output = formatSavedPosts(items);
    expect(output).toContain("## 1.");
    expect(output).toContain("First");
    expect(output).toContain("## 2.");
    expect(output).toContain("Second");
    expect(output).not.toContain("⚠️");
  });

  it("prepends warning when provided", () => {
    const items = [samplePost()];
    const output = formatSavedPosts(items, "可能截断");
    expect(output).toContain("⚠️");
    expect(output).toContain("可能截断");
  });

  it("handles empty items with warning", () => {
    const output = formatSavedPosts([], "test warning");
    expect(output).toContain("⚠️");
    expect(output).toContain("test warning");
  });
});

describe("parseSavedItems", () => {
  it("parses a valid JSON array", () => {
    const json = JSON.stringify([
      {
        title: "Post 1",
        subreddit: "r/a",
        score: 10,
        comments: 2,
        url: "https://reddit.com/r/a/comments/1/t/",
      },
      {
        title: "Post 2",
        subreddit: "r/b",
        score: 20,
        comments: 3,
        url: "https://reddit.com/r/b/comments/2/t/",
      },
    ]);
    const items = parseSavedItems(json);
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe("Post 1");
    expect(items[1].subreddit).toBe("r/b");
  });

  it("throws on non-array JSON", () => {
    expect(() => parseSavedItems('{"title":"post"}')).toThrow(
      /Expected JSON array/,
    );
  });

  it("throws on invalid JSON", () => {
    expect(() => parseSavedItems("not-json")).toThrow();
  });

  it("parses an empty array", () => {
    const items = parseSavedItems("[]");
    expect(items).toEqual([]);
  });
});

describe("buildTruncationWarning", () => {
  it("includes the limit number in the warning", () => {
    const msg = buildTruncationWarning(50);
    expect(msg).toContain("50");
  });

  it("works with different limits", () => {
    expect(buildTruncationWarning(100)).toContain("100");
    expect(buildTruncationWarning(10)).toContain("10");
  });
});

describe("loadCheckpoint / saveCheckpoint", () => {
  it("returns null state when path does not exist", () => {
    const state = loadCheckpoint("/nonexistent/path.json");
    expect(state).toEqual({ lastHeadPostId: null });
  });

  it("round-trips a checkpoint value", () => {
    const dir = tempDir();
    const path = join(dir, "checkpoint.json");
    try {
      saveCheckpoint("abc123", path);
      const state = loadCheckpoint(path);
      expect(state).toEqual({ lastHeadPostId: "abc123" });
    } finally {
      cleanupDir(dir);
    }
  });

  it("returns null state for corrupt JSON", () => {
    const dir = tempDir();
    const path = join(dir, "corrupt.json");
    try {
      writeFileSync(path, "not-json{", "utf-8");
      const state = loadCheckpoint(path);
      expect(state).toEqual({ lastHeadPostId: null });
    } finally {
      cleanupDir(dir);
    }
  });

  it("creates parent directories on save", () => {
    const dir = tempDir();
    const nested = join(dir, "sub", "nested", "checkpoint.json");
    try {
      saveCheckpoint("xyz", nested);
      expect(existsSync(nested)).toBe(true);
      const state = loadCheckpoint(nested);
      expect(state).toEqual({ lastHeadPostId: "xyz" });
    } finally {
      cleanupDir(dir);
    }
  });
});

describe("splitEntries", () => {
  it("splits entries by ## N. heading markers", () => {
    const text = ["## 1. First", "content 1", "## 2. Second", "content 2"].join(
      "\n",
    );
    const entries = splitEntries(text);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toContain("## 1.");
    expect(entries[1]).toContain("## 2.");
  });

  it("splits entries at heading lines without trailing space (as produced by formatSavedPosts)", () => {
    // formatSavedPosts joins entries with \n, so heading lines like "## 1." end at EOL.
    // The regex must match both "## 1. text" (with space) and "## 1." (no trailing space).
    // Before the fix, /^## \d+\.\s/ required whitespace after the period and would skip EOL.
    const text = ["## 1.", "content line 1", "## 2.", "content line 2"].join(
      "\n",
    );
    const entries = splitEntries(text);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toBe("## 1.\ncontent line 1");
    expect(entries[1]).toBe("## 2.\ncontent line 2");
  });

  it("handles a single entry with no heading marker", () => {
    const text = "just some text\nwithout heading";
    const entries = splitEntries(text);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toBe("just some text\nwithout heading");
  });

  it("handles empty text", () => {
    expect(splitEntries("")).toEqual([]);
  });

  it("handles text with only whitespace", () => {
    // Whitespace-only text is trimmed to empty, resulting in no entries.
    expect(splitEntries("   \n  ")).toEqual([]);
  });
});

describe("prepareSavedChunks", () => {
  it("returns empty array for empty output", () => {
    const result = prepareSavedChunks({
      rawOutput: "",
      prefix: "📑 Reddit Saved\n\n",
      maxChunkLength: 3800,
      maxHtmlLength: TELEGRAM_MAX,
    });

    expect(result).toEqual([]);
  });

  it("returns one chunk with prefix for a single entry", () => {
    const result = prepareSavedChunks({
      rawOutput: "# Saved Posts\n\nplain text",
      prefix: "📑 Reddit Saved\n\n",
      maxChunkLength: 3800,
      maxHtmlLength: TELEGRAM_MAX,
    });

    expect(result).toHaveLength(1);
    expect(result[0].html).toContain("📑 Reddit Saved");
    expect(result[0].html).toContain("<b>Saved Posts</b>");
  });

  it("strips **bold** markers inside headings", () => {
    const result = prepareSavedChunks({
      rawOutput: "## 1. AI **coding** agents\ncontent",
      prefix: "",
      maxChunkLength: 3800,
      maxHtmlLength: TELEGRAM_MAX,
    });

    expect(result).toHaveLength(1);
    const html = result[0].html;
    expect(html).toContain("<b>1. AI coding agents</b>");
    expect(html).not.toContain("<b>1. AI <b>coding</b> agents</b>");
  });

  it("splits entries across chunks when HTML would exceed maxHtmlLength", () => {
    const entry = [
      "## 1. Entry title",
      "- subreddit：r/test",
      `- ⬆ 42 • 💬 7`,
      `- [Link](${"x".repeat(4000)})`,
    ].join("\n");

    const rawOutput = [entry, entry].join("\n");

    const result = prepareSavedChunks({
      rawOutput,
      prefix: "",
      maxChunkLength: 5000,
      maxHtmlLength: 4096,
    });

    expect(result.length).toBeGreaterThanOrEqual(2);
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

    const result = prepareSavedChunks({
      rawOutput,
      prefix: "",
      maxChunkLength: 3800,
      maxHtmlLength: 4096,
    });

    expect(result).toHaveLength(1);
    expect(result[0].html).toContain("<b>1. First</b>");
    expect(result[0].html).toContain("<b>2. Second</b>");
  });

  it("preserves inline code and links in the conversion", () => {
    const result = prepareSavedChunks({
      rawOutput:
        "# Summary\nSee `code & stuff` and [docs](https://example.com)",
      prefix: "",
      maxChunkLength: 3800,
      maxHtmlLength: TELEGRAM_MAX,
    });

    expect(result).toHaveLength(1);
    const html = result[0].html;
    // Inline code content is preserved as-is (no HTML escaping inside backticks)
    expect(html).toContain("<code>code & stuff</code>");
    expect(html).toContain('<a href="https://example.com">docs</a>');
  });

  it("handles raw HTML characters by escaping them", () => {
    const result = prepareSavedChunks({
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
    const entryLines = (n: number, char: string) =>
      [`## ${n}. Entry ${n}`, char.repeat(80)].join("\n");
    const rawOutput = [
      "# Saved Posts",
      entryLines(1, "a"),
      entryLines(2, "b"),
      entryLines(3, "c"),
    ].join("\n");

    const result = prepareSavedChunks({
      rawOutput,
      prefix: "📑 Reddit Saved\n\n",
      maxChunkLength: 500,
      maxHtmlLength: 150,
    });

    expect(result.length).toBeGreaterThan(1);
    expect(result[0].html).toContain("📑 Reddit Saved");
    for (let i = 1; i < result.length; i++) {
      expect(result[i].html).not.toContain("📑 Reddit Saved");
    }
  });

  it("handles a single oversized entry gracefully (no infinite loop)", () => {
    const singleHugeEntry = ["## 1. Huge entry", "x".repeat(5000)].join("\n");

    const result = prepareSavedChunks({
      rawOutput: singleHugeEntry,
      prefix: "",
      maxChunkLength: 5000,
      maxHtmlLength: 100,
    });

    expect(result).toHaveLength(1);
    expect(result[0].html.length).toBeGreaterThan(100);
  });
});
