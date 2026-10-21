import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "./frontmatter.js";

const build = (lines: string[]): string => `${lines.join("\n")}\n`;

describe("parseFrontmatter", () => {
  it("collapses a multi-line block scalar into one description", () => {
    const content = build([
      "---",
      "name: office-hours",
      "description: |",
      "  Founder-style office hours to clarify the problem, users, and wedge.",
      "  Runs in Startup or Builder mode.",
      "---",
      "",
      "body line",
    ]);

    const result = parseFrontmatter(content, "fallback");

    expect(result.name).toBe("office-hours");
    expect(result.description).toBe(
      "Founder-style office hours to clarify the problem, users, and wedge. Runs in Startup or Builder mode.",
    );
  });

  it("keeps unknown keys and strips surrounding quotes", () => {
    const content = build([
      "---",
      "name: reviewer",
      'tools: "read, grep"',
      "model: deepseek/deepseek-v4-flash",
      "thinking: high",
      "---",
      "Review the diff.",
    ]);

    const { fields, body } = parseFrontmatter(content, "fallback");

    expect(fields.tools).toBe("read, grep");
    expect(fields.model).toBe("deepseek/deepseek-v4-flash");
    expect(fields.thinking).toBe("high");
    expect(body.trimEnd()).toBe("Review the diff.");
  });

  it("ignores nested keys under a mapping", () => {
    const content = build([
      "---",
      "name: visual-explainer",
      "tools: read, grep",
      "metadata:",
      "  author: nicobailon",
      '  version: "0.6.3"',
      "  tools: bash",
      "---",
      "body",
    ]);

    const { fields } = parseFrontmatter(content, "fallback");

    expect(fields.tools).toBe("read, grep");
    expect(fields.author).toBeUndefined();
    expect(fields.version).toBeUndefined();
  });

  it("falls back when there is no frontmatter", () => {
    const content = "just a body\nsecond line";

    const result = parseFrontmatter(content, "fallback");

    expect(result).toEqual({
      name: "fallback",
      description: "",
      fields: {},
      body: content,
    });
  });

  it("falls back when the closing fence is missing", () => {
    const content = build(["---", "name: broken", "description: never closed"]);

    const result = parseFrontmatter(content, "fallback");

    expect(result.name).toBe("fallback");
    expect(result.fields).toEqual({});
  });

  it("ignores lines without a colon and keys with an empty name", () => {
    const content = build([
      "---",
      "this line has no colon",
      ": orphan value",
      "name: ok",
      "---",
    ]);

    const { name, fields } = parseFrontmatter(content, "fallback");

    expect(name).toBe("ok");
    expect(Object.keys(fields)).toEqual(["name"]);
  });

  it("keeps the body when the closing fence is followed by no blank line", () => {
    const content = build(["---", "name: tight", "---", "first body line"]);

    expect(parseFrontmatter(content, "fallback").body.trimEnd()).toBe(
      "first body line",
    );
  });
});
