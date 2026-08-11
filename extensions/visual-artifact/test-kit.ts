import { vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  CalldiffRunErrorCode,
  CalldiffRunOutcome,
} from "../shared/calldiff-runner.ts";
import type { CalldiffResult } from "./calldiff-bridge.ts";

/**
 * Shared fixtures + fake-pi harness for the visual-artifact tool tests.
 *
 * Module mocks (calldiff-runner / artifact-store / glimpse-host / paths)
 * stay in each test file — `vi.mock` is per-module — but every other piece
 * of scaffolding is shared here so the two tool suites can't drift apart.
 */

export type ToolExecute = (
  toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: unknown,
  ctx: { cwd?: string },
) => Promise<{
  content: Array<{ type: string; text: string }>;
  details?: Record<string, unknown>;
  isError?: boolean;
}>;

export type RegisteredTool = { name: string; execute: ToolExecute };

export type ToolHarness = {
  pi: ExtensionAPI;
  tools: Map<string, RegisteredTool>;
  callTool: (
    name: string,
    params: Record<string, unknown>,
    ctx?: { cwd?: string },
  ) => ReturnType<ToolExecute>;
};

export const createToolHarness = (): ToolHarness => {
  const tools = new Map<string, RegisteredTool>();
  const pi = {
    registerTool: vi.fn((tool: RegisteredTool) => tools.set(tool.name, tool)),
    registerCommand: vi.fn(),
    sendUserMessage: vi.fn(),
  } as unknown as ExtensionAPI;

  const callTool: ToolHarness["callTool"] = (
    name,
    params,
    ctx = { cwd: "/repo" },
  ) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`${name} not registered`);
    return tool.execute("t1", params, undefined, undefined, ctx);
  };

  return { pi, tools, callTool };
};

export const makeNode = (
  key: string,
  label: string,
  status: "same" | "added" | "removed" = "same",
) => ({
  key,
  label,
  status,
  children: [],
});

export const diffResult: CalldiffResult = {
  mode: "diff",
  from: "abc123",
  to: "WORKTREE",
  trees: [
    {
      entry: "boot",
      ascii: "  boot()\n+ ├─ register()",
      tree: makeNode("boot", "boot()"),
    },
  ],
  ascii: "  1 entrypoint",
};

export const okOutcome = (result: CalldiffResult): CalldiffRunOutcome => ({
  status: "ok",
  stdout: JSON.stringify(result),
});

export const errOutcome = (
  code: CalldiffRunErrorCode,
  message: string,
): CalldiffRunOutcome => ({ status: "error", code, message });
