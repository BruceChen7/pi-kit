import { describe, expect, it } from "vitest";
import { buildSubagentArgs, extractSubagentSummary } from "./subagent-args.ts";

// ── buildSubagentArgs ─────────────────────────────────

describe("buildSubagentArgs", () => {
  it("defaults to json mode with minimal flags", () => {
    expect(buildSubagentArgs({})).toEqual([
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--no-extensions",
      "--no-themes",
    ]);
  });

  it("switches to text mode when requested", () => {
    expect(buildSubagentArgs({ outputMode: "text" })).toEqual([
      "--mode",
      "text",
      "-p",
      "--no-session",
      "--no-extensions",
      "--no-themes",
    ]);
  });

  it("appends --models, -e, and --prompt-template in stable order", () => {
    const args = buildSubagentArgs({
      model: "opencode-go/deepseek-v4-flash",
      extensionPaths: ["/ext/one.ts", "/ext/two.ts"],
      promptTemplatePaths: ["/prompts/wiki-summarize.md"],
    });

    expect(args).toEqual([
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--no-extensions",
      "--no-themes",
      "--models",
      "opencode-go/deepseek-v4-flash",
      "-e",
      "/ext/one.ts",
      "-e",
      "/ext/two.ts",
      "--prompt-template",
      "/prompts/wiki-summarize.md",
    ]);
  });

  it("omits optional flags when not provided", () => {
    const args = buildSubagentArgs({ model: "m1", outputMode: "text" });
    expect(args).not.toContain("-e");
    expect(args).not.toContain("--prompt-template");
    expect(args).toContain("--models");
  });
});

// ── extractSubagentSummary ────────────────────────────

describe("extractSubagentSummary", () => {
  it("text mode: returns the trimmed stdout as the summary", () => {
    expect(extractSubagentSummary("text", "  hello world\n")).toBe(
      "hello world",
    );
  });

  it("text mode: falls back to the truncation-time snapshot when stdout is empty", () => {
    expect(extractSubagentSummary("text", "", "partial-output")).toBe(
      "partial-output",
    );
  });

  it("text mode: returns undefined when both stdout and fallback are empty", () => {
    expect(extractSubagentSummary("text", "   ")).toBeUndefined();
  });

  it("undefined mode defaults to json behavior", () => {
    const stdout = JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "x" }] },
    });
    expect(extractSubagentSummary(undefined, stdout)).toBe("x");
  });
});
