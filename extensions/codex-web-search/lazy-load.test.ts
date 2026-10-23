import { describe, expect, it, vi } from "vitest";

const loads: number[] = [];
vi.mock("./codex.js", () => {
  loads.push(performance.now());
  return {
    executeCodexWebSearch: vi.fn(async () => ({
      content: [{ type: "text" as const, text: "lazy search result" }],
    })),
  };
});

type RegisteredTool = {
  name: string;
  execute: (
    id: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<{ content: Array<{ text: string }> }>;
};

describe("codex-web-search lazy search pipeline", () => {
  it("loads ./codex.js on the first tool call, once", async () => {
    const { default: codexWebSearchExtension } = await import("./index.js");
    const tools = new Map<string, RegisteredTool>();
    const pi = {
      on: vi.fn(),
      registerCommand: vi.fn(),
      registerTool: vi.fn((tool: RegisteredTool) => tools.set(tool.name, tool)),
    };
    codexWebSearchExtension(
      pi as unknown as Parameters<typeof codexWebSearchExtension>[0],
    );

    expect(loads).toHaveLength(0);
    const tool = tools.get("web_search");
    if (!tool) throw new Error("web_search was not registered");

    const result = await tool.execute(
      "call-1",
      { query: "vitest" },
      undefined,
      undefined,
      { cwd: process.cwd() },
    );

    expect(loads).toHaveLength(1);
    expect(result.content[0]?.text).toBe("lazy search result");
  });
});
