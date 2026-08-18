import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  aggregateBatchResults,
  buildSubagentPrompt,
  buildTelegramSuccessMessage,
  formatDuration,
  formatStageStartTime,
  interpretBatchResult,
  parseResultJson,
  runQmdStep,
  runShardMigration,
  runSummarizePipeline,
} from "./knowledge-wiki-daily.js";

// Mock Telegram to prevent actual network calls during shell function tests.
vi.mock("../../shared/telegram.ts", () => ({
  sendTelegramNotification: vi.fn(() => Promise.resolve()),
  escapeHtml: (text: string) =>
    text
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;"),
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

// ── Test helpers ──────────────────────────────────────

/**
 * Create a subagent mock whose calls only resolve when manually resolved.
 * Lets tests control completion order / concurrency deterministically.
 */
function deferredSubagentMock() {
  const resolvers: Array<(value: unknown) => void> = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const subagent = vi.fn().mockImplementation(() => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return new Promise((resolve) => {
      resolvers.push((value: unknown) => {
        inFlight--;
        resolve(value);
      });
    });
  });

  return {
    subagent,
    resolvers,
    get maxInFlight() {
      return maxInFlight;
    },
  };
}

/**
 * Build a successful subagent result. A batch number tags the done text and
 * adds one summary file; batch 0 produces an empty summary list.
 */
function makeOkResult(batch = 0) {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    summary: JSON.stringify({
      ok: true,
      done: batch ? `batch-${batch} done` : "done",
      summaries: batch ? [`Wiki/Summaries/B${batch}.summary.md`] : [],
    }),
  };
}

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
    expect(result).toContain("<path-to-wiki-index.mjs>");
    expect(result).toContain("wiki-index.mjs path");
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

// ── Telegram summary formatting ───────────────────────

describe("Telegram summary formatting", () => {
  it("formats stage times and durations for mobile-readable output", () => {
    const timestamp = Date.UTC(2026, 5, 30, 10, 11, 12);
    expect(formatStageStartTime(timestamp)).toBe(
      new Date(timestamp).toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }),
    );
    expect(formatDuration(450)).toBe("0.5s");
    expect(formatDuration(68_000)).toBe("1m 08s");
  });

  it("renders batch summaries as escaped bullet points with timings", () => {
    const message = buildTelegramSuccessMessage(
      ["Notes/source.md"],
      ["Wiki/Summaries/source.summary.md"],
      "Batch 1: 2 summaries <ready> | Batch 2: 1 summary & linked",
      true,
      true,
      [
        {
          label: "Step 1–3 · wiki-summarize",
          startedAt: Date.UTC(2026, 5, 30, 10, 11, 12),
          durationMs: 42_800,
          ok: true,
        },
      ],
    );

    expect(message).toContain("<b>⏱️ 执行摘要</b>");
    expect(message).toContain(
      `开始：<code>${formatStageStartTime(Date.UTC(2026, 5, 30, 10, 11, 12))}</code>`,
    );
    expect(message).toContain("耗时：<code>42.8s</code>");
    expect(message).toContain("• Batch 1: 2 summaries &lt;ready&gt;");
    expect(message).toContain("• Batch 2: 1 summary &amp; linked");
    expect(message).toContain("Wiki/Summaries/source.summary.md");
    expect(message).not.toContain("Batch 1: 2 summaries <ready> | Batch 2");
  });

  it("omits an empty wiki summary without leaving an empty section", () => {
    const message = buildTelegramSuccessMessage([], undefined, "", true, true);
    expect(message).not.toContain("wiki-summarize");
    expect(message).toContain("qmd update：✓");
    expect(message).toContain("qmd embed：✓");
  });
});

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

// ── runShardMigration ─────────────────────────────────

describe("runShardMigration", () => {
  it("runs split-daily-shards with the index script and base path", async () => {
    const exec = {
      exec: vi.fn().mockResolvedValue({
        code: 0,
        stdout:
          '{"years": {"2026": 3}, "kept": 2, "backup": "index.md.bak-20260101"}',
        stderr: "",
      }),
    };

    await runShardMigration(exec);

    expect(exec.exec).toHaveBeenCalledWith("node", [
      expect.stringContaining("knowledge-wiki"),
      "split-daily-shards",
      "--base-path",
      expect.stringContaining("notes"),
    ]);
  });

  it("swallows a non-zero exit code", async () => {
    const exec = {
      exec: vi.fn().mockResolvedValue({ code: 1, stdout: "", stderr: "boom" }),
    };

    await expect(runShardMigration(exec)).resolves.toBeUndefined();
  });

  it("swallows a thrown error", async () => {
    const exec = {
      exec: vi.fn().mockRejectedValue(new Error("spawn failed")),
    };

    await expect(runShardMigration(exec)).resolves.toBeUndefined();
  });
});

// ── aggregateBatchResults ─────────────────────────────

describe("aggregateBatchResults", () => {
  it("accumulates summaries and done text in batch order", () => {
    const result = aggregateBatchResults([
      { ok: true, done: "a", summaries: ["S1", "S2"] },
      { ok: true, done: "b" },
    ]);
    expect(result.createdSummaries).toEqual(["S1", "S2"]);
    expect(result.wikiSummaryDone).toBe("Batch 1: a | Batch 2: b");
    expect(result.failed).toEqual([]);
  });

  it("collects failed batches and skips them in the output", () => {
    const result = aggregateBatchResults([
      { ok: true, done: "a", summaries: ["S1"] },
      { ok: false, done: "boom" },
      { ok: true, done: "c", summaries: ["S3"] },
    ]);
    expect(result.createdSummaries).toEqual(["S1", "S3"]);
    expect(result.wikiSummaryDone).toBe("Batch 1: a | Batch 3: c");
    expect(result.failed).toEqual([{ batch: 2, error: "boom" }]);
  });

  it("uses 'unknown error' when a failed batch has no message", () => {
    const result = aggregateBatchResults([{ ok: false }]);
    expect(result.failed).toEqual([{ batch: 1, error: "unknown error" }]);
    expect(result.createdSummaries).toEqual([]);
    expect(result.wikiSummaryDone).toBe("");
  });

  it("handles empty results", () => {
    const result = aggregateBatchResults([]);
    expect(result.createdSummaries).toEqual([]);
    expect(result.wikiSummaryDone).toBe("");
    expect(result.failed).toEqual([]);
  });
});

// ── interpretBatchResult ──────────────────────────────

describe("interpretBatchResult", () => {
  const okSummary = (done = "done") =>
    JSON.stringify({ ok: true, done, summaries: ["S1"] });

  it("succeeds on exit 0 with an ok:true summary", () => {
    expect(
      interpretBatchResult({
        exitCode: 0,
        stderr: "",
        summary: okSummary("Phase 1 done"),
      }),
    ).toEqual({ ok: true, done: "Phase 1 done", summaries: ["S1"] });
  });

  it("fails on non-zero exit code even when the summary says ok", () => {
    const result = interpretBatchResult({
      exitCode: 143,
      stderr: "",
      summary: okSummary(),
    });
    expect(result.ok).toBe(false);
  });

  it("fails when the agent reports ok:false and uses its done text", () => {
    const result = interpretBatchResult({
      exitCode: 0,
      stderr: "",
      summary: JSON.stringify({ ok: false, done: "Phase 2 failed: boom" }),
    });
    expect(result).toEqual({ ok: false, done: "Phase 2 failed: boom" });
  });

  it("falls back to stderr (truncated to 500 chars) when done text is missing", () => {
    const stderr = "x".repeat(600);
    const result = interpretBatchResult({
      exitCode: 1,
      stderr,
      summary: undefined,
    });
    expect(result).toEqual({ ok: false, done: "x".repeat(500) });
  });

  it("uses 'unknown error' when both done text and stderr are empty", () => {
    const result = interpretBatchResult({
      exitCode: 1,
      stderr: "",
      summary: undefined,
    });
    expect(result).toEqual({ ok: false, done: "unknown error" });
  });

  it("prefers the agent's done text over stderr", () => {
    const result = interpretBatchResult({
      exitCode: 1,
      stderr: "noise in stderr",
      summary: JSON.stringify({ ok: false, done: "agent says why" }),
    });
    expect(result).toEqual({ ok: false, done: "agent says why" });
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

  it("keeps collecting results when a subagent call rejects", async () => {
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

    // BATCH_SIZE = 3 → 4 files → 2 batches, run concurrently.
    // Batch 1 succeeds, batch 2 throws; the throw only fails that batch.
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

  it("never runs more than 3 subagents at once and processes every batch", async () => {
    const mock = deferredSubagentMock();

    // BATCH_SIZE = 3 → 10 files → 4 batches.
    const files = Array.from({ length: 10 }, (_, i) => `Notes/F${i}.md`);
    const pipelinePromise = runSummarizePipeline(
      { subagent: mock.subagent },
      files,
    );

    // The pool starts at most 3; the 4th batch is scheduled only after a
    // slot frees up — observable behavior, not internal timing.
    await vi.waitFor(() => expect(mock.resolvers).toHaveLength(3));
    mock.resolvers[0](makeOkResult());
    await vi.waitFor(() => expect(mock.resolvers).toHaveLength(4));
    mock.resolvers.slice(1).forEach((resolve) => {
      resolve(makeOkResult());
    });

    const result = await pipelinePromise;
    expect(mock.maxInFlight).toBe(3);
    expect(mock.subagent).toHaveBeenCalledTimes(4);
    expect(result.wikiSummaryDone).toContain("Batch 4");
  });

  // Configuration-contract test: runSummarizePipeline's public return value
  // cannot observe what options reach the subagent, so this asserts the
  // wiring of the pinned model/outputMode constants. It is not a
  // behavior test — behavior lives in interpretBatchResult's table tests.
  it("pins the subagent model, output mode, and timeout for every batch", async () => {
    const mock = deferredSubagentMock();

    // BATCH_SIZE = 3 → 4 files → 2 batches.
    const files = ["A.md", "B.md", "C.md", "D.md"];
    const pipelinePromise = runSummarizePipeline(
      { subagent: mock.subagent },
      files,
    );

    await vi.waitFor(() => expect(mock.resolvers).toHaveLength(2));
    for (const resolve of mock.resolvers) {
      resolve(makeOkResult());
    }
    await pipelinePromise;

    for (const call of mock.subagent.mock.calls) {
      const options = call[0] as {
        model?: string;
        outputMode?: "json" | "text";
        promptTemplatePaths?: string[];
        timeoutMs?: number;
      };
      expect(options.model).toBe("opencode-go/deepseek-v4-flash");
      expect(options.outputMode).toBe("text");
      expect(options.promptTemplatePaths).toHaveLength(1);
      expect(options.timeoutMs).toBe(600_000);
    }
  });

  it("collects results in batch order regardless of completion order", async () => {
    const mock = deferredSubagentMock();

    // BATCH_SIZE = 3 → 10 files → 4 batches.
    const files = Array.from({ length: 10 }, (_, i) => `Notes/F${i}.md`);
    const pipelinePromise = runSummarizePipeline(
      { subagent: mock.subagent },
      files,
    );

    await vi.waitFor(() => expect(mock.resolvers).toHaveLength(3));
    // Resolve out of order: batch 3 first, then batch 2, batch 1, batch 4.
    mock.resolvers[2](makeOkResult(3));
    await vi.waitFor(() => expect(mock.resolvers).toHaveLength(4));
    mock.resolvers[1](makeOkResult(2));
    mock.resolvers[0](makeOkResult(1));
    mock.resolvers[3](makeOkResult(4));

    const result = await pipelinePromise;
    // Collected in batch order, not completion order.
    expect(result.createdSummaries).toEqual([
      "Wiki/Summaries/B1.summary.md",
      "Wiki/Summaries/B2.summary.md",
      "Wiki/Summaries/B3.summary.md",
      "Wiki/Summaries/B4.summary.md",
    ]);
    expect(result.wikiSummaryDone).toBe(
      "Batch 1: batch-1 done | Batch 2: batch-2 done | Batch 3: batch-3 done | Batch 4: batch-4 done",
    );
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
