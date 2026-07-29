import { describe, expect, it } from "vitest";
import { renderInlineMarkdown } from "./inline-markdown.ts";

describe("renderInlineMarkdown", () => {
  it("renders inline code and strong emphasis", () => {
    expect(renderInlineMarkdown("Use `alias` with **care**.")).toBe(
      "Use <code>alias</code> with <strong>care</strong>.",
    );
  });

  it("escapes arbitrary html before adding supported markup", () => {
    expect(renderInlineMarkdown('<img src=x onerror="alert(1)">')).toBe(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
    );
  });

  it("escapes html inside code spans", () => {
    expect(renderInlineMarkdown("`<script>`")).toBe(
      "<code>&lt;script&gt;</code>",
    );
  });
});
