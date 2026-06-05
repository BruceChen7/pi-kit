import { describe, expect, it } from "vitest";
import { convertMarkdownToTelegramHtml } from "./telegram.ts";

describe("convertMarkdownToTelegramHtml", () => {
  it("converts bold markers to <b> tags", () => {
    expect(convertMarkdownToTelegramHtml("**hello**")).toBe("<b>hello</b>");
  });

  it("converts inline code to <code> tags without escaping content", () => {
    expect(convertMarkdownToTelegramHtml("use `foo & bar`")).toBe(
      "use <code>foo & bar</code>",
    );
  });

  it("converts markdown links to <a> tags", () => {
    expect(
      convertMarkdownToTelegramHtml("see [docs](https://example.com)"),
    ).toBe('see <a href="https://example.com">docs</a>');
  });

  it("escapes HTML special chars in link text", () => {
    expect(
      convertMarkdownToTelegramHtml("[a < b & c > d](https://x.com)"),
    ).toBe('<a href="https://x.com">a &lt; b &amp; c &gt; d</a>');
  });

  it("escapes double quotes in link URLs", () => {
    expect(convertMarkdownToTelegramHtml('[click](https://x.com/"foo")')).toBe(
      '<a href="https://x.com/&quot;foo&quot;">click</a>',
    );
  });

  it("converts headings to <b> tags", () => {
    expect(convertMarkdownToTelegramHtml("# Title")).toBe("<b>Title</b>");
    expect(convertMarkdownToTelegramHtml("## Subtitle")).toBe(
      "<b>Subtitle</b>",
    );
    expect(convertMarkdownToTelegramHtml("### Section")).toBe("<b>Section</b>");
  });

  it("HTML-escapes text outside code spans", () => {
    expect(convertMarkdownToTelegramHtml("a < b & c > d")).toBe(
      "a &lt; b &amp; c &gt; d",
    );
  });

  it("handles mixed content: bold, code, link, and heading together", () => {
    const input = [
      "# Bookmarks",
      "",
      "**important** `code` and [link](https://x.com)",
      "## Details",
      "plain text with & symbol",
    ].join("\n");

    const result = convertMarkdownToTelegramHtml(input);

    expect(result).toContain("<b>Bookmarks</b>");
    expect(result).toContain("<b>important</b>");
    expect(result).toContain("<code>code</code>");
    expect(result).toContain('<a href="https://x.com">link</a>');
    expect(result).toContain("<b>Details</b>");
    expect(result).toContain("plain text with &amp; symbol");
  });

  it("returns empty string for empty input", () => {
    expect(convertMarkdownToTelegramHtml("")).toBe("");
  });

  it("preserves plain text without markdown as HTML-escaped", () => {
    expect(convertMarkdownToTelegramHtml("just text")).toBe("just text");
  });
});
