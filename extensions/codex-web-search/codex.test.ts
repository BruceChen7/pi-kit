import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCodexExecArgs, executeCodexWebSearch } from "./codex.js";
import { DEFAULT_CODEX_WEB_SEARCH_MODEL } from "./constants.js";
import { DEFAULT_WEB_SEARCH_SETTINGS } from "./settings.js";
import type {
  RunCodexCommand,
  RunCodexCommandOptions,
  RunCodexCommandResult,
  WebSearchProgressDetails,
  WebSearchSettings,
} from "./types.js";

function settingsWith(
  overrides: Partial<WebSearchSettings> = {},
): WebSearchSettings {
  return { ...DEFAULT_WEB_SEARCH_SETTINGS, ...overrides };
}

function outputPathFrom(args: string[]): string {
  const index = args.indexOf("--output-last-message");
  const path = index === -1 ? undefined : args[index + 1];
  if (!path) {
    throw new Error("run args are missing --output-last-message");
  }
  return path;
}

async function writeCodexResult(
  options: RunCodexCommandOptions,
  payload: unknown,
): Promise<void> {
  const outputPath = outputPathFrom(options.args);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(payload), "utf-8");
}

function searchEventLine(query: string): string {
  return JSON.stringify({
    type: "item.completed",
    item: { type: "web_search_call", action: { type: "search", query } },
  });
}

describe("buildCodexExecArgs", () => {
  it("keeps the stdin marker last and omits -m by default", () => {
    const args = buildCodexExecArgs(
      { schemaPath: "/tmp/schema.json", outputPath: "/tmp/out.json" },
      "cached",
    );

    expect(args).toEqual([
      "exec",
      "--json",
      "-c",
      'web_search="cached"',
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--color",
      "never",
      "--ephemeral",
      "--output-schema",
      "/tmp/schema.json",
      "--output-last-message",
      "/tmp/out.json",
      "-",
    ]);
  });

  it("pins the model when one is configured", () => {
    const args = buildCodexExecArgs(
      { schemaPath: "/tmp/schema.json", outputPath: "/tmp/out.json" },
      "live",
      "  llm-gateway--gpt-5.5  ",
    );

    expect(args.slice(0, 6)).toEqual([
      "exec",
      "--json",
      "-c",
      'web_search="live"',
      "-m",
      "llm-gateway--gpt-5.5",
    ]);
    expect(args.at(-1)).toBe("-");
  });

  it("omits -m when the model override is blank", () => {
    const args = buildCodexExecArgs(
      { schemaPath: "/tmp/schema.json", outputPath: "/tmp/out.json" },
      "cached",
      "   ",
    );

    expect(args).not.toContain("-m");
  });
});

describe("executeCodexWebSearch model override", () => {
  it("forwards the pinned Codex model to the runner", async () => {
    const calls: string[][] = [];
    const runner: RunCodexCommand = async (options) => {
      calls.push(options.args);
      await writeCodexResult(options, { summary: "ok", sources: [] });
      options.onStdoutLine?.(searchEventLine("codex cli release"));
      return { code: 0, stdout: "", stderr: "" };
    };

    await executeCodexWebSearch(
      { query: "codex cli release", mode: "fast" },
      {
        cwd: process.cwd(),
        runner,
        settings: settingsWith({ codexModel: "llm-gateway--gpt-5.5" }),
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("-m");
    expect(calls[0]).toContain("llm-gateway--gpt-5.5");
  });
});

const UNKNOWN_MODEL_STDOUT = [
  JSON.stringify({
    type: "item.completed",
    item: {
      type: "error",
      message:
        "Model metadata for `llm-gpt-5.5` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.",
    },
  }),
  JSON.stringify({
    type: "turn.failed",
    error: {
      message:
        "The 'llm-gpt-5.5' model is not supported when using Codex with a ChatGPT account.",
    },
  }),
].join("\n");

describe("executeCodexWebSearch default model", () => {
  it("pins the default Codex model when the caller overrides nothing", async () => {
    const calls: string[][] = [];
    const runner: RunCodexCommand = async (options) => {
      calls.push(options.args);
      options.onStdoutLine?.(searchEventLine("codex cli release"));
      await writeCodexResult(options, {
        summary: "ok",
        sources: [{ title: "Docs", url: "https://example.com/docs" }],
      });
      return { code: 0, stdout: "", stderr: "" };
    };

    const result = await executeCodexWebSearch(
      { query: "codex cli release", mode: "fast" },
      { cwd: process.cwd(), runner, settings: settingsWith() },
    );

    expect(calls[0]).toContain("-m");
    expect(calls[0]).toContain(DEFAULT_CODEX_WEB_SEARCH_MODEL);
    expect(result.details.failure).toBeUndefined();
  });

  it("retries without the pinned model when Codex does not know it", async () => {
    const calls: string[][] = [];
    const statusTexts: string[] = [];
    const runner: RunCodexCommand = async (options) => {
      calls.push(options.args);
      if (calls.length === 1) {
        return { code: 1, stdout: UNKNOWN_MODEL_STDOUT, stderr: "" };
      }

      options.onStdoutLine?.(searchEventLine("codex cli release"));
      await writeCodexResult(options, {
        summary: "Fallback answer.",
        sources: [{ title: "Docs", url: "https://example.com/docs" }],
      });
      return { code: 0, stdout: "", stderr: "" };
    };

    const result = await executeCodexWebSearch(
      { query: "codex cli release", mode: "fast" },
      {
        cwd: process.cwd(),
        runner,
        onUpdate: (update) => {
          const details = update.details as
            | WebSearchProgressDetails
            | undefined;
          if (details?.statusText) statusTexts.push(details.statusText);
        },
        settings: settingsWith({ codexModel: "llm-gpt-5.5" }),
      },
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("llm-gpt-5.5");
    expect(calls[1]).not.toContain("-m");
    expect(result.details.sourceCount).toBe(1);
    expect(result.details.failure).toBeUndefined();
    expect(result.details.modelFallback).toEqual({
      from: "llm-gpt-5.5",
      reason:
        "Codex does not know the pinned web search model; retrying with the model from the Codex config.",
    });
    expect(statusTexts.join("\n")).toContain(
      "does not know the pinned web search model",
    );
  });

  it("reports a failure instead of looping when the fallback run also fails", async () => {
    let calls = 0;
    const runner: RunCodexCommand = async () => {
      calls += 1;
      return { code: 1, stdout: UNKNOWN_MODEL_STDOUT, stderr: "" };
    };

    const result = await executeCodexWebSearch(
      { query: "codex cli release", mode: "fast" },
      {
        cwd: process.cwd(),
        runner,
        settings: settingsWith({ codexModel: "llm-gpt-5.5" }),
      },
    );

    expect(calls).toBe(2);
    expect(result.details.failure).toBeDefined();
    expect(result.details.modelFallback?.from).toBe("llm-gpt-5.5");
  });

  it("keeps the model fallback note when the fallback run times out", async () => {
    let calls = 0;
    const runner: RunCodexCommand = async () => {
      calls += 1;
      if (calls === 1) {
        return { code: 1, stdout: UNKNOWN_MODEL_STDOUT, stderr: "" };
      }

      throw new Error("Codex web search timed out after 5 seconds.");
    };

    const result = await executeCodexWebSearch(
      { query: "codex cli release", mode: "fast" },
      {
        cwd: process.cwd(),
        runner,
        settings: settingsWith({
          codexModel: "llm-gpt-5.5",
          fastTimeoutMs: 5_000,
        }),
      },
    );

    expect(calls).toBe(2);
    expect(result.details.failure?.kind).toBe("search_unavailable");
    expect(result.details.modelFallback?.from).toBe("llm-gpt-5.5");
  });
});

describe("executeCodexWebSearch without search activity", () => {
  it("flags an answer that was produced without any search", async () => {
    const runner: RunCodexCommand = async (options) => {
      await writeCodexResult(options, {
        summary: "The latest version is 0.155.0.",
        sources: [],
      });
      return { code: 0, stdout: "", stderr: "" };
    };

    const result = await executeCodexWebSearch(
      { query: "latest codex cli version" },
      { cwd: process.cwd(), runner, settings: settingsWith() },
    );

    expect(result.details.failure?.kind).toBe("search_unavailable");
    expect(result.details.sourceCount).toBe(0);
    expect(result.details.searchCount).toBe(0);
    expect(result.content[0]?.text).toContain("without retrieving any sources");
    expect(result.content[0]?.text).toContain("codex-model");
  });

  it("does not auto-escalate a fast timeout that never searched", async () => {
    let calls = 0;
    const runner: RunCodexCommand = async () => {
      calls += 1;
      throw new Error("Codex web search timed out after 90 seconds.");
    };

    const result = await executeCodexWebSearch(
      { query: "latest codex cli version" },
      { cwd: process.cwd(), runner, settings: settingsWith() },
    );

    expect(calls).toBe(1);
    expect(result.details.failure?.kind).toBe("search_unavailable");
    expect(result.details.failure?.message).toContain(
      "No web search activity was observed",
    );
    expect(result.details.failure?.message).toContain("codex-model");
    expect(result.details.retry).toBeUndefined();
  });

  it("still escalates a fast timeout that did search", async () => {
    const runners: RunCodexCommandOptions[] = [];
    const runner: RunCodexCommand = async (
      options,
    ): Promise<RunCodexCommandResult> => {
      runners.push(options);
      if (runners.length === 1) {
        options.onStdoutLine?.(searchEventLine("codex cli release"));
        throw new Error("Codex web search timed out after 90 seconds.");
      }

      options.onStdoutLine?.(searchEventLine("codex cli latest release"));
      await writeCodexResult(options, {
        summary: "Escalated answer.",
        sources: [{ title: "Changelog", url: "https://example.com/changelog" }],
      });
      return { code: 0, stdout: "", stderr: "" };
    };

    const result = await executeCodexWebSearch(
      { query: "latest codex cli version" },
      { cwd: process.cwd(), runner, settings: settingsWith() },
    );

    expect(runners).toHaveLength(2);
    expect(result.details.retry?.retriedFromFast).toBe(true);
    expect(result.details.mode).toBe("deep");
    expect(result.details.freshness).toBe("live");
    expect(result.details.sourceCount).toBe(1);
    expect(result.details.failure).toBeUndefined();
  });

  it("keeps successful searched results free of failure details", async () => {
    const runner: RunCodexCommand = async (options) => {
      options.onStdoutLine?.(searchEventLine("codex cli release"));
      await writeCodexResult(options, {
        summary: "Answer with sources.",
        sources: [{ title: "Docs", url: "https://example.com/docs" }],
      });
      return { code: 0, stdout: "", stderr: "" };
    };

    const result = await executeCodexWebSearch(
      { query: "codex cli release", mode: "fast" },
      { cwd: process.cwd(), runner, settings: settingsWith() },
    );

    expect(result.details.failure).toBeUndefined();
    expect(result.details.searchCount).toBe(1);
    expect(result.details.sourceCount).toBe(1);
    expect(result.content[0]?.text).not.toContain("Warning:");
  });
});
