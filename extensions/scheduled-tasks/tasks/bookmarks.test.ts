import { describe, expect, it } from "vitest";
import { prepareBookmarkChunks } from "./bookmarks.ts";

const TELEGRAM_MAX = 4096;

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
