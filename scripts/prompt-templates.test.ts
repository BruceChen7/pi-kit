import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  findPromptFrontmatterProblems,
  type PromptDoc,
} from "./prompt-templates-rules.ts";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const PROMPTS_DIR = path.join(REPO_ROOT, "prompts");

const readPrompts = (): PromptDoc[] =>
  fs
    .readdirSync(PROMPTS_DIR)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => ({
      path: `prompts/${name}`,
      text: fs.readFileSync(path.join(PROMPTS_DIR, name), "utf8"),
    }));

const rulesOf = (text: string): string[] =>
  findPromptFrontmatterProblems([{ path: "prompts/probe.md", text }]).map(
    (finding) => finding.rule,
  );

describe("prompt templates", () => {
  it("scans every prompt file, not an empty set", () => {
    expect(readPrompts().length).toBeGreaterThan(20);
  });

  it("keeps every frontmatter block parseable and described", () => {
    expect(findPromptFrontmatterProblems(readPrompts())).toEqual([]);
  });
});

describe("findPromptFrontmatterProblems", () => {
  it("accepts a folded description indented under its header", () => {
    const text = [
      "---",
      "description: >-",
      "  第一行，",
      "  第二行",
      'argument-hint: "<url>"',
      "---",
      "",
      "# Title",
      "",
    ].join("\n");

    expect(rulesOf(text)).toEqual([]);
  });

  it("flags a block scalar header that shares its line with content", () => {
    const text = [
      "---",
      "description: >- 第一行，",
      "第二行",
      "---",
      "",
      "body",
      "",
    ].join("\n");

    expect(rulesOf(text)).toContain("block-scalar-inline");
  });

  it("flags frontmatter rewritten as a markdown heading", () => {
    const text = [
      "---",
      "",
      "## description: a prompt that lost its frontmatter",
      "",
      "body",
      "",
    ].join("\n");

    expect(rulesOf(text)).toContain("metadata-as-heading");
  });

  it("flags a prompt without a description", () => {
    expect(rulesOf("# Just a body\n")).toEqual(["description-missing"]);
  });
});
