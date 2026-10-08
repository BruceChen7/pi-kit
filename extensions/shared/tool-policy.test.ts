import { describe, expect, it } from "vitest";

import {
  classifyToolCall,
  findToolAnnotations,
  formatMcpCallSummary,
  isMcpToolName,
  mcpServerName,
} from "./tool-policy.js";

describe("isMcpToolName / mcpServerName", () => {
  it("recognizes MCP tool names and extracts the server", () => {
    expect(isMcpToolName("mcp__filesystem__write_file")).toBe(true);
    expect(isMcpToolName("write")).toBe(false);
    expect(mcpServerName("mcp__filesystem__write_file")).toBe("filesystem");
    expect(mcpServerName("mcp__linear")).toBe("linear");
    expect(mcpServerName("write")).toBeNull();
  });
});

describe("findToolAnnotations", () => {
  it("returns hints for a known tool", () => {
    expect(
      findToolAnnotations(
        [{ name: "mcp__fs__read_file", annotations: { readOnlyHint: true } }],
        "mcp__fs__read_file",
      ),
    ).toEqual({ readOnlyHint: true });
  });

  it("returns undefined for missing tools or missing hints", () => {
    expect(findToolAnnotations([{ name: "write" }], "read")).toBeUndefined();
    expect(
      findToolAnnotations(undefined, "mcp__fs__read_file"),
    ).toBeUndefined();
  });
});

describe("classifyToolCall", () => {
  it("leaves non-MCP tools to the caller's existing handling", () => {
    expect(
      classifyToolCall({
        toolName: "write",
        args: { path: "src/a.ts" },
        annotations: { destructiveHint: true },
      }),
    ).toEqual({
      isMcp: false,
      kind: "unknown",
      paths: [],
      readOnly: false,
      destructive: false,
      openWorld: false,
      requiresApproval: false,
    });
  });

  it("treats declared read-only MCP tools as reads", () => {
    const policy = classifyToolCall({
      toolName: "mcp__fs__read_file",
      args: { path: "src/a.ts" },
      annotations: { readOnlyHint: true, destructiveHint: true },
    });

    expect(policy).toMatchObject({
      isMcp: true,
      kind: "read",
      readOnly: true,
      destructive: false,
      openWorld: false,
      requiresApproval: false,
    });
    expect(policy.paths).toEqual([{ rawPath: "src/a.ts" }]);
  });

  it("applies the MCP defaults when hints are missing", () => {
    expect(
      classifyToolCall({
        toolName: "mcp__fs__write_file",
        args: { file_path: "src/a.ts" },
      }),
    ).toEqual({
      isMcp: true,
      kind: "write",
      paths: [{ rawPath: "src/a.ts" }],
      readOnly: false,
      destructive: true,
      openWorld: true,
      requiresApproval: true,
    });
  });

  it("requires approval for non-read-only destructive tools", () => {
    expect(
      classifyToolCall({
        toolName: "mcp__linear__delete_issue",
        args: {},
        annotations: { destructiveHint: true, openWorldHint: false },
      }),
    ).toMatchObject({ kind: "write", requiresApproval: true });
  });

  it("skips approval for additive closed-domain tools", () => {
    expect(
      classifyToolCall({
        toolName: "mcp__linear__create_issue",
        args: {},
        annotations: { destructiveHint: false, openWorldHint: false },
      }),
    ).toMatchObject({
      kind: "write",
      destructive: false,
      openWorld: false,
      requiresApproval: false,
    });
  });
});

describe("formatMcpCallSummary", () => {
  it("renders the tool, server, hints and arguments", () => {
    const summary = formatMcpCallSummary({
      toolName: "mcp__filesystem__delete_file",
      args: { path: "src/a.ts" },
      annotations: { destructiveHint: true },
    });

    expect(summary).toContain("Tool: mcp__filesystem__delete_file");
    expect(summary).toContain("Server: filesystem");
    expect(summary).toContain("not read-only, may delete or overwrite");
    expect(summary).toContain('"path": "src/a.ts"');
  });

  it("truncates long arguments", () => {
    const summary = formatMcpCallSummary({
      toolName: "mcp__fs__write_file",
      args: { content: "x".repeat(200) },
      maxChars: 40,
    });

    expect(summary).toContain("arguments truncated");
    expect(summary.length).toBeLessThan(200);
  });
});
