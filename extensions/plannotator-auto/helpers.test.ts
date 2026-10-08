import { describe, expect, it } from "vitest";

import { isReviewTrackedToolCall } from "./helpers.js";

describe("isReviewTrackedToolCall", () => {
  it("tracks pi's own write, edit and bash calls", () => {
    for (const toolName of ["write", "edit", "bash"]) {
      expect(isReviewTrackedToolCall(toolName, { path: "x.ts" })).toBe(true);
    }
  });

  it("tracks MCP writes that name file paths", () => {
    expect(
      isReviewTrackedToolCall("mcp__fs__write_file", {
        file_path: "docs/a.md",
        content: "x",
      }),
    ).toBe(true);
    expect(
      isReviewTrackedToolCall("mcp__fs__move_file", {
        path: "docs/a.md",
      }),
    ).toBe(true);
  });

  it("ignores declared read-only MCP tools", () => {
    expect(
      isReviewTrackedToolCall(
        "mcp__fs__read_file",
        { path: "docs/a.md" },
        { readOnlyHint: true },
      ),
    ).toBe(false);
  });

  it("ignores MCP calls without file paths", () => {
    expect(
      isReviewTrackedToolCall("mcp__linear__create_issue", { title: "x" }),
    ).toBe(false);
  });

  it("ignores pi-kit extension tools", () => {
    expect(isReviewTrackedToolCall("qmd_query", { query: "guards" })).toBe(
      false,
    );
  });
});
