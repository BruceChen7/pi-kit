import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildSubagentPrompt,
  parseResultJson,
} from "./knowledge-wiki-daily.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WIKI_SUMMARIZE_FILE = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "prompts",
  "wiki-summarize.md",
);

// ── buildSubagentPrompt ───────────────────────────────

describe("buildSubagentPrompt", () => {
  it("should include the knowledge base path", () => {
    const result = buildSubagentPrompt();
    expect(result).toContain("work/notes");
    expect(result).toContain("wiki-summary.mjs");
    expect(result).toContain("wiki-concept.mjs");
  });

  it("should include path replacement instructions", () => {
    const result = buildSubagentPrompt();
    expect(result).toContain("<cwd>");
    expect(result).toContain("<path-to-wiki-summary.mjs>");
    expect(result).toContain("<path-to-wiki-concept.mjs>");
  });

  it("should mention the 4-phase workflow", () => {
    const result = buildSubagentPrompt();
    expect(result).toContain("4 phases");
    expect(result).toContain("list-stale");
    expect(result).toContain("verify");
  });

  it("should require a JSON output summary", () => {
    const result = buildSubagentPrompt();
    expect(result).toContain('"ok"');
    expect(result).toContain('"done"');
  });

  it("should not contain @prompts/ reference (template is loaded via CLI arg)", () => {
    const result = buildSubagentPrompt();
    expect(result).not.toContain("@prompts/");
  });
});

// ── parseResultJson ───────────────────────────────────

describe("parseResultJson", () => {
  it("should return null for undefined input", () => {
    expect(parseResultJson(undefined)).toBeNull();
  });

  it("should return null for empty string", () => {
    expect(parseResultJson("")).toBeNull();
  });

  it("should return null for text without a JSON block", () => {
    expect(parseResultJson("Some random text")).toBeNull();
  });

  it("should parse a valid success JSON block", () => {
    const text = [
      "Processing complete. Summary:",
      "",
      '{"ok": true, "done": "Phase 1: 3 stale files. Phase 2: 2 summaries created."}',
      "",
      "Ready.",
    ].join("\n");

    const result = parseResultJson(text);
    expect(result).not.toBeNull();
    expect(result?.ok).toBe(true);
    expect(result?.done).toContain("Phase 1");
  });

  it("should parse a failure JSON block", () => {
    const text = JSON.stringify({
      ok: false,
      done: "Phase 2 failed: could not generate summary for Notes/Foo.md",
    });

    const result = parseResultJson(text);
    expect(result).not.toBeNull();
    expect(result?.ok).toBe(false);
    expect(result?.done).toContain("Phase 2 failed");
  });

  it("should handle JSON with surrounding text and whitespace", () => {
    const text = [
      "Here is what I did:",
      "",
      '{"ok": true, "done": "All done"}',
      "",
      "---",
      "End of report",
    ].join("\n");

    const result = parseResultJson(text);
    expect(result).not.toBeNull();
    expect(result?.ok).toBe(true);
    expect(result?.done).toBe("All done");
  });

  it("should return null for valid JSON that lacks 'ok' field", () => {
    const text = JSON.stringify({ foo: "bar", count: 42 });
    const result = parseResultJson(text);
    expect(result).toBeNull();
  });

  it("should skip non-matching JSON and find the right one", () => {
    const text = [
      '{"some": "other", "data": true}',
      '{"ok": false, "done": "Something failed"}',
      '{"final": "note"}',
    ].join("\n");

    const result = parseResultJson(text);
    expect(result).not.toBeNull();
    expect(result?.ok).toBe(false);
    expect(result?.done).toContain("Something failed");
  });
});

// ── Prompt file integrity ─────────────────────────────

describe("wiki-summarize.md integrity", () => {
  it("should exist and be readable", () => {
    const content = readFileSync(WIKI_SUMMARIZE_FILE, "utf8");
    expect(content.length).toBeGreaterThan(100);
  });

  it("should have the wiki-summarize frontmatter", () => {
    const content = readFileSync(WIKI_SUMMARIZE_FILE, "utf8");
    expect(content).toContain("description:");
    expect(content).toContain("argument-hint:");
  });

  it("should contain all 4 workflow phases", () => {
    const content = readFileSync(WIKI_SUMMARIZE_FILE, "utf8");
    expect(content).toContain("### Phase 1:");
    expect(content).toContain("### Phase 2:");
    expect(content).toContain("### Phase 3:");
    expect(content).toContain("### Phase 4:");
  });

  it("should reference --base-path <cwd>", () => {
    const content = readFileSync(WIKI_SUMMARIZE_FILE, "utf8");
    expect(content).toContain("--base-path");
    expect(content).toContain("<cwd>");
  });
});
