import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  buildSubagentPrompt,
  parseResultJson,
  runQmdStep,
  runSummarizePipeline,
} from "./knowledge-wiki-daily.js";

// Mock Telegram to prevent actual network calls during shell function tests.
vi.mock("../../shared/telegram.ts", () => ({
  sendTelegramNotification: vi.fn(() => Promise.resolve()),
}));

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
    const result = buildSubagentPrompt([]);
    expect(result).toContain("work/notes");
    expect(result).toContain("wiki-summary.mjs");
    expect(result).toContain("wiki-concept.mjs");
  });

  it("should include path replacement instructions", () => {
    const result = buildSubagentPrompt([]);
    expect(result).toContain("<cwd>");
    expect(result).toContain("<path-to-wiki-summary.mjs>");
    expect(result).toContain("<path-to-wiki-concept.mjs>");
  });

  it("should mention the 4-phase workflow", () => {
    const result = buildSubagentPrompt([]);
    expect(result).toContain("4 phases");
    expect(result).toContain("list-stale");
    expect(result).toContain("verify");
  });

  it("should require a JSON output summary with summaries field", () => {
    const result = buildSubagentPrompt([]);
    expect(result).toContain('"ok"');
    expect(result).toContain('"done"');
    expect(result).toContain('"summaries"');
  });

  it("should not contain @prompts/ reference (template is loaded via CLI arg)", () => {
    const result = buildSubagentPrompt([]);
    expect(result).not.toContain("@prompts/");
  });

  it("should list stale files when provided", () => {
    const files = ["Notes/Foo.md", "Notes/Bar.md"];
    const result = buildSubagentPrompt(files);
    expect(result).toContain("Stale Files");
    expect(result).toContain("2 total");
    expect(result).toContain("Notes/Foo.md");
    expect(result).toContain("Notes/Bar.md");
  });

  it("should show 'No stale files found' for empty list", () => {
    const result = buildSubagentPrompt([]);
    expect(result).toContain("No stale files found");
  });

  it("should truncate long stale file list beyond limit", () => {
    const manyFiles = Array.from({ length: 25 }, (_, i) => `Notes/File${i}.md`);
    const result = buildSubagentPrompt(manyFiles);
    expect(result).toContain("25 stale files");
    expect(result).toContain("listing first 20");
    expect(result).toContain("Notes/File0.md");
    expect(result).toContain("Notes/File19.md");
    expect(result).not.toContain("Notes/File20.md");
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

  it("should parse summaries field when present", () => {
    const text = JSON.stringify({
      ok: true,
      done: "Phase 1: 2 stale files. Phase 2: 2 summaries created. Phase 3: 5 concepts linked.",
      summaries: [
        "Wiki/Summaries/Foo.summary.md",
        "Wiki/Summaries/Bar.summary.md",
      ],
    });

    const result = parseResultJson(text);
    expect(result).not.toBeNull();
    expect(result?.ok).toBe(true);
    expect(result?.summaries).toEqual([
      "Wiki/Summaries/Foo.summary.md",
      "Wiki/Summaries/Bar.summary.md",
    ]);
  });

  it("should return undefined summaries when field is missing", () => {
    const text = JSON.stringify({
      ok: true,
      done: "All done",
    });

    const result = parseResultJson(text);
    expect(result).not.toBeNull();
    expect(result?.ok).toBe(true);
    expect(result?.summaries).toBeUndefined();
  });

  it("should return undefined summaries when field is not an array", () => {
    const text = JSON.stringify({
      ok: true,
      done: "All done",
      summaries: "not-an-array",
    });

    const result = parseResultJson(text);
    expect(result).not.toBeNull();
    expect(result?.ok).toBe(true);
    expect(result?.summaries).toBeUndefined();
  });
});

// ── runQmdStep ────────────────────────────────────────

describe("runQmdStep", () => {
  it("returns true when exec succeeds with code 0", async () => {
    const exec = {
      exec: vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" }),
    };
    const result = await runQmdStep(exec, "4", "test step", ["test"]);
    expect(result).toBe(true);
    expect(exec.exec).toHaveBeenCalledWith("qmd", ["test"]);
  });

  it("returns false when exec returns non-zero code", async () => {
    const exec = {
      exec: vi.fn().mockResolvedValue({ code: 1, stdout: "", stderr: "" }),
    };
    const result = await runQmdStep(exec, "4", "test step", ["test"]);
    expect(result).toBe(false);
  });

  it("returns false when exec throws", async () => {
    const exec = {
      exec: vi.fn().mockRejectedValue(new Error("network error")),
    };
    const result = await runQmdStep(exec, "4", "test step", ["test"]);
    expect(result).toBe(false);
  });

  it("sets and restores environment variables", async () => {
    const key = "QMD_EMBED_MODEL";
    const orig = process.env[key];
    process.env[key] = "original-value";

    const exec = {
      exec: vi.fn().mockImplementation(async () => {
        // During execution, env var should be overridden
        expect(process.env[key]).toBe("override-value");
        return { code: 0, stdout: "", stderr: "" };
      }),
    };

    await runQmdStep(exec, "5", "test step", ["embed"], {
      [key]: "override-value",
    });

    // After execution, env var should be restored
    expect(process.env[key]).toBe("original-value");
    process.env[key] = orig;
  });

  it("restores env vars even when exec throws", async () => {
    const key = "TEST_ENV_VAR";
    process.env[key] = "before";

    const exec = {
      exec: vi.fn().mockRejectedValue(new Error("fail")),
    };

    await runQmdStep(exec, "5", "test step", ["embed"], { [key]: "override" });

    expect(process.env[key]).toBe("before");
    delete process.env[key];
  });

  it("deletes env var that did not exist before", async () => {
    const key = "NONEXISTENT_TEST_VAR";
    delete process.env[key];

    const exec = {
      exec: vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" }),
    };

    await runQmdStep(exec, "5", "test step", ["embed"], {
      [key]: "temp-value",
    });

    expect(process.env[key]).toBeUndefined();
  });
});

// ── runSummarizePipeline ──────────────────────────────

describe("runSummarizePipeline", () => {
  it("returns early with summary message when staleFiles is empty", async () => {
    const exec = {} as Parameters<typeof runSummarizePipeline>[0];
    const result = await runSummarizePipeline(exec, []);
    expect(result.createdSummaries).toEqual([]);
    expect(result.wikiSummaryDone).toBe("No stale files found.");
  });

  it("accumulates summaries from multiple successful batches", async () => {
    const exec = {
      subagent: vi
        .fn()
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: "",
          stderr: "",
          summary: JSON.stringify({
            ok: true,
            done: "Phase 1-4 complete",
            summaries: ["Wiki/Summaries/A.summary.md"],
          }),
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: "",
          stderr: "",
          summary: JSON.stringify({
            ok: true,
            done: "Phase 1-4 complete",
            summaries: ["Wiki/Summaries/B.summary.md"],
          }),
        }),
    };

    // BATCH_SIZE = 3, so 4 files → 2 batches (3 + 1)
    const result = await runSummarizePipeline(exec, [
      "A.md",
      "B.md",
      "C.md",
      "D.md",
    ]);
    expect(result.createdSummaries).toEqual([
      "Wiki/Summaries/A.summary.md",
      "Wiki/Summaries/B.summary.md",
    ]);
    expect(result.wikiSummaryDone).toContain("Batch 1");
    expect(result.wikiSummaryDone).toContain("Batch 2");
  });

  it("continues processing remaining batches after one fails", async () => {
    const exec = {
      subagent: vi
        .fn()
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: "",
          stderr: "",
          summary: JSON.stringify({
            ok: true,
            done: "Batch 1 done",
            summaries: ["Wiki/Summaries/A.summary.md"],
          }),
        })
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: "",
          stderr: "batch 2 failed",
        }),
    };

    // BATCH_SIZE = 3, so 4 files → 2 batches (3 + 1)
    // Batch 1 succeeds, batch 2 fails
    const result = await runSummarizePipeline(exec, [
      "A.md",
      "B.md",
      "C.md",
      "D.md",
    ]);
    expect(result.createdSummaries).toEqual(["Wiki/Summaries/A.summary.md"]);
    expect(result.wikiSummaryDone).toContain("Batch 1");
    expect(result.wikiSummaryDone).not.toContain("Batch 2");
  });

  it("handles exception during iteration gracefully", async () => {
    const exec = {
      subagent: vi
        .fn()
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: "",
          stderr: "",
          summary: JSON.stringify({
            ok: true,
            done: "Batch 1 done",
            summaries: ["Wiki/Summaries/A.summary.md"],
          }),
        })
        .mockRejectedValueOnce(new Error("subagent crashed")),
    };

    // BATCH_SIZE = 3, so 4 files → 2 batches (3 + 1)
    // Batch 1 succeeds, batch 2 throws
    const result = await runSummarizePipeline(exec, [
      "A.md",
      "B.md",
      "C.md",
      "D.md",
    ]);
    expect(result.createdSummaries).toEqual(["Wiki/Summaries/A.summary.md"]);
  });

  it("handles batch failure via ok:false result", async () => {
    const exec = {
      subagent: vi
        .fn()
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: "",
          stderr: "",
          summary: JSON.stringify({
            ok: false,
            done: "Phase 2 failed: cannot process",
          }),
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: "",
          stderr: "",
          summary: JSON.stringify({
            ok: true,
            done: "Batch 2 done",
            summaries: ["Wiki/Summaries/B.summary.md"],
          }),
        }),
    };

    // BATCH_SIZE = 3, so 4 files → 2 batches (3 + 1)
    // Batch 1 returns ok:false, batch 2 succeeds
    const result = await runSummarizePipeline(exec, [
      "A.md",
      "B.md",
      "C.md",
      "D.md",
    ]);
    // Should have continued past batch 1 and collected batch 2
    expect(result.createdSummaries).toEqual(["Wiki/Summaries/B.summary.md"]);
    expect(result.wikiSummaryDone).toContain("Batch 2");
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
