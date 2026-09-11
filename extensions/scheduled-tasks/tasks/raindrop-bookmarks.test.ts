import { describe, expect, it } from "vitest";
import {
  type BookmarkItem,
  buildArchiveEntry,
  formatIncrement,
  renderArchiveEntry,
  selectNewArchiveItems,
} from "./raindrop-bookmarks.ts";

// ── Fixtures ──────────────────────────────────────────

const sampleItem = (overrides: Partial<BookmarkItem> = {}): BookmarkItem => ({
  title: "An Article",
  link: "https://example.com/a",
  domain: "example.com",
  created: "2026-07-31T10:00:00.000Z",
  tags: ["go", "testing"],
  excerpt: "Some excerpt text",
  ...overrides,
});

// ── buildArchiveEntry ─────────────────────────────────

describe("buildArchiveEntry", () => {
  it("creates the file title and a dated section on first run", () => {
    const items = [
      sampleItem({ title: "First", link: "https://a.example.com" }),
      sampleItem({ title: "Second", link: "https://b.example.com" }),
    ];

    const out = buildArchiveEntry("2026-07-31", items, "");

    expect(out).toContain("# Raindrop 书签档案（2026）");
    expect(out).toContain("## 2026-07-31");
    expect(out).toContain("1. **First**");
    expect(out).toContain("2. **Second**");
    expect(out).toContain("🔗 https://a.example.com");
    expect(out).toContain("🔗 https://b.example.com");
    expect(out).toContain("📍 example.com 🏷️ go, testing");
    expect(out).toContain("💬 Some excerpt text");
  });

  it("does not repeat the file title on subsequent appends", () => {
    const existing = [
      "# Raindrop 书签档案（2026）",
      "",
      "## 2026-07-30",
      "",
      "1. **Old**",
      "🔗 https://old.example.com",
      "📍 old.example.com",
      "",
    ].join("\n");

    const out = buildArchiveEntry(
      "2026-07-31",
      [sampleItem({ title: "New", link: "https://new.example.com" })],
      existing,
    );

    expect(out).not.toContain("# Raindrop 书签档案");
    expect(out).toContain("## 2026-07-31");
    expect(out).toContain("New");
  });

  it("dedupes by link: only appends items whose link is not archived yet", () => {
    const existing = [
      "## 2026-07-30",
      "",
      "1. **Old**",
      "🔗 https://a.example.com",
      "📍 example.com",
      "",
    ].join("\n");

    const items = [
      sampleItem({ title: "Dup", link: "https://a.example.com" }),
      sampleItem({ title: "Fresh", link: "https://c.example.com" }),
    ];

    const out = buildArchiveEntry("2026-07-31", items, existing);

    expect(out).not.toContain("Dup");
    expect(out).toContain("Fresh");
    expect(out).toContain("🔗 https://c.example.com");
  });

  it("returns empty string when everything is already archived", () => {
    const existing = [
      "## 2026-07-30",
      "",
      "1. **Old**",
      "🔗 https://a.example.com",
      "📍 example.com",
      "",
    ].join("\n");

    expect(
      buildArchiveEntry(
        "2026-07-31",
        [sampleItem({ link: "https://a.example.com" })],
        existing,
      ),
    ).toBe("");
  });

  it("falls back to title as the dedupe key when the link is empty", () => {
    const out = buildArchiveEntry(
      "2026-07-31",
      [sampleItem({ link: "", title: "NoLink" })],
      "",
    );

    expect(out).toContain("🔗 NoLink");
  });

  it("skips items with neither link nor title", () => {
    const out = buildArchiveEntry(
      "2026-07-31",
      [sampleItem({ link: "", title: "" })],
      "",
    );

    expect(out).toBe("");
  });

  it("truncates the excerpt to 200 chars in the archive", () => {
    const out = buildArchiveEntry(
      "2026-07-31",
      [sampleItem({ excerpt: "x".repeat(500) })],
      "",
    );

    expect(out).toContain(`💬 ${"x".repeat(200)}`);
    expect(out).not.toContain("x".repeat(201));
  });

  it("keeps the excerpt on a single line so excerpt text cannot forge dedupe keys", () => {
    const out = buildArchiveEntry(
      "2026-07-31",
      [
        sampleItem({
          excerpt: "first line\n🔗 https://example.com/a\nlast line",
        }),
      ],
      "",
    );

    // Exactly one 🔗 line: the real key line, not the excerpt content
    const linkLines = out.match(/^🔗 .+$/gm) ?? [];
    expect(linkLines).toHaveLength(1);
    expect(linkLines[0]).toBe("🔗 https://example.com/a");
    expect(out).toContain("💬 first line 🔗 https://example.com/a last line");
  });

  it("collapses newlines in the title fallback key", () => {
    const out = buildArchiveEntry(
      "2026-07-31",
      [sampleItem({ link: "", title: "Multi\nline" })],
      "",
    );

    expect(out).toContain("🔗 Multi line");
  });

  it("dedupes against the previous year file when starting a new year", () => {
    const prevYearContent = [
      "# Raindrop 书签档案（2025）",
      "",
      "## 2025-12-31",
      "",
      "1. **Old**",
      "🔗 https://a.example.com",
      "📍 example.com",
      "",
    ].join("\n");

    const out = buildArchiveEntry(
      "2026-01-01",
      [sampleItem({ title: "Dup", link: "https://a.example.com" })],
      "", // current year file is still empty
      prevYearContent,
    );

    expect(out).toBe("");
  });

  it("appends genuinely new items when only the previous year had keys", () => {
    const prevYearContent = [
      "## 2025-12-31",
      "",
      "1. **Old**",
      "🔗 https://a.example.com",
      "📍 example.com",
      "",
    ].join("\n");

    const out = buildArchiveEntry(
      "2026-01-01",
      [
        sampleItem({ link: "https://a.example.com" }),
        sampleItem({ link: "https://b.example.com", title: "Fresh" }),
      ],
      "",
      prevYearContent,
    );

    expect(out).toContain("# Raindrop 书签档案（2026）");
    expect(out).not.toContain("An Article");
    expect(out).not.toContain("https://a.example.com");
    expect(out).toContain("🔗 https://b.example.com");
    expect(out).toContain("**Fresh**");
  });
});

// ── selectNewArchiveItems（纯决策）─────────────────────

describe("selectNewArchiveItems", () => {
  it("keeps only items whose key is not in the existing set", () => {
    const items = [
      sampleItem({ title: "Dup", link: "https://a.example.com" }),
      sampleItem({ title: "Fresh", link: "https://b.example.com" }),
    ];

    const result = selectNewArchiveItems(
      items,
      new Set(["https://a.example.com"]),
    );

    expect(result).toEqual([items[1]]);
  });

  it("falls back to title as the key when the link is empty", () => {
    const result = selectNewArchiveItems(
      [sampleItem({ link: "", title: "NoLink" })],
      new Set(["NoLink"]),
    );

    expect(result).toEqual([]);
  });

  it("skips items with neither link nor title", () => {
    const result = selectNewArchiveItems(
      [sampleItem({ link: "", title: "" })],
      new Set(),
    );

    expect(result).toEqual([]);
  });
});

// ── renderArchiveEntry（纯渲染）────────────────────────

describe("renderArchiveEntry", () => {
  it("writes the file title only when includeFileTitle is set", () => {
    const item = sampleItem({ title: "First" });

    const withTitle = renderArchiveEntry("2026-07-31", [item], true);
    const withoutTitle = renderArchiveEntry("2026-07-31", [item], false);

    expect(withTitle).toContain("# Raindrop 书签档案（2026）");
    expect(withoutTitle).not.toContain("# Raindrop 书签档案");
    expect(withoutTitle).toContain("## 2026-07-31");
    expect(withoutTitle).toContain("1. **First**");
  });
});

// ── 回归：块之间必须有空行（CommonMark 段落吞列表项）──────
//
// GitHub 用 CommonMark 渲染：`💬 摘录` 行后若直接跟 `N. **标题**`（或下一次
// append 的 `## 日期`），没有空行的话列表项会被当作段落文字原样吞进段落里
// （`N. **标题**`、🔗、📍 全部挤成一团文字）。这里断言结构行前面必有空行。

/** 结构性行（`N. **标题**` 或 `## 日期`）前必须是空行，否则会被吞进段落。 */
function expectStructuralLinesSeparated(md: string): void {
  const lines = md.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^(## |\d+\. \*\*)/.test(line)) {
      expect(
        lines[i - 1],
        `第 ${i + 1} 行前必须是空行，否则会被吞进段落: ${line}`,
      ).toBe("");
    }
  }
}

describe("renderArchiveEntry — 块间空行（回归）", () => {
  it("摘录与下一条目之间保留空行", () => {
    const out = renderArchiveEntry(
      "2026-09-03",
      [
        sampleItem({
          title: "A",
          link: "https://a.example.com",
          excerpt: "excerpt A",
        }),
        sampleItem({ title: "B", link: "https://b.example.com" }),
      ],
      false,
    );

    expect(out).toContain("💬 excerpt A\n\n2. **B**");
  });

  it("摘录与下一次 append 的日期标题之间保留空行", () => {
    const first = renderArchiveEntry(
      "2026-09-03",
      [sampleItem({ title: "A", excerpt: "excerpt A" })],
      false,
    );
    const second = renderArchiveEntry(
      "2026-09-04",
      [sampleItem({ title: "B", link: "https://b.example.com" })],
      false,
    );

    expect(first + second).toContain("💬 excerpt A\n\n## 2026-09-04");
  });

  it("所有条目行与日期标题前都有空行（结构不变量）", () => {
    const out = renderArchiveEntry(
      "2026-09-03",
      [
        sampleItem({
          title: "A",
          link: "https://a.example.com",
          excerpt: "excerpt A",
        }),
        sampleItem({
          title: "B",
          link: "https://b.example.com",
          excerpt: "excerpt B",
        }),
      ],
      true,
    );

    expectStructuralLinesSeparated(out);
  });
});

describe("formatIncrement — 块间空行（回归）", () => {
  it("摘录与下一条目之间保留空行", () => {
    const out = formatIncrement([
      sampleItem({
        title: "A",
        link: "https://a.example.com",
        excerpt: "excerpt A",
      }),
      sampleItem({ title: "B", link: "https://b.example.com" }),
    ]);

    expect(out).toContain("💬 excerpt A\n\n## 2. **B**");
    expectStructuralLinesSeparated(out);
  });
});
