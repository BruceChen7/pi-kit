import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import extension from "./index.js";

const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
});

type EventHandlers = Record<string, Array<(...args: unknown[]) => unknown>>;

function createFakeApi(initialTools: string[]): {
  api: ExtensionAPI;
  handlers: EventHandlers;
  activeTools: () => string[];
} {
  let tools = [...initialTools];
  const handlers: EventHandlers = {};

  const api = {
    on(event: string, handler: (...args: unknown[]) => unknown) {
      const list = handlers[event] ?? [];
      list.push(handler);
      handlers[event] = list;
    },
    registerTool() {
      // no-op
    },
    getActiveTools: () => [...tools],
    setActiveTools: (next: string[]) => {
      tools = [...next];
    },
    getSystemPrompt: () => `tools:${tools.join(",")}`,
  } as unknown as ExtensionAPI;

  return { api, handlers, activeTools: () => [...tools] };
}

function trigger(
  handlers: EventHandlers,
  event: string,
  eventPayload: object,
): unknown {
  const callbacks = handlers[event];
  if (!callbacks || callbacks.length === 0) {
    throw new Error(`No handler registered for ${event}`);
  }
  return (callbacks[callbacks.length - 1] as (e: object) => unknown)(
    eventPayload,
  );
}

describe("tools_intercepted extension", () => {
  it("registers session_start and before_agent_start lifecycle hooks", () => {
    const events: string[] = [];

    extension({
      on(event: string) {
        events.push(event);
      },
      registerTool() {
        // no-op
      },
    } as unknown as ExtensionAPI);

    expect(events).toEqual(["session_start", "before_agent_start"]);
  });

  it("removes grep/find and adds rg/fd on session_start", () => {
    const { api, handlers, activeTools } = createFakeApi([
      "read",
      "bash",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
    ]);

    extension(api);
    trigger(handlers, "session_start", {
      type: "session_start",
      reason: "startup",
    });

    expect(activeTools()).toContain("rg");
    expect(activeTools()).toContain("fd");
    expect(activeTools()).not.toContain("grep");
    expect(activeTools()).not.toContain("find");
  });

  it("re-enforces the tool set on before_agent_start for stale sessions", () => {
    // Simulate a long-running instance whose active tools were computed before
    // the extension loaded: grep/find are still present, rg/fd are missing.
    const { api, handlers, activeTools } = createFakeApi([
      "read",
      "bash",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
      "cs_search",
    ]);

    extension(api);

    const result = trigger(handlers, "before_agent_start", {
      type: "before_agent_start",
      prompt: "search the repo",
      systemPrompt: "old",
      systemPromptOptions: {},
    });

    expect(activeTools()).toContain("rg");
    expect(activeTools()).toContain("fd");
    expect(activeTools()).not.toContain("grep");
    expect(activeTools()).not.toContain("find");

    // The corrected system prompt is returned so this turn takes effect now.
    const resultObj = result as { systemPrompt?: string } | undefined;
    expect(resultObj?.systemPrompt).toContain("rg");
    expect(resultObj?.systemPrompt).not.toContain("grep");
  });

  it("is a no-op on before_agent_start once tools are already correct", () => {
    const { api, handlers, activeTools } = createFakeApi([
      "read",
      "bash",
      "edit",
      "write",
      "ls",
      "rg",
      "fd",
    ]);

    extension(api);

    const result = trigger(handlers, "before_agent_start", {
      type: "before_agent_start",
      prompt: "hi",
      systemPrompt: "new",
      systemPromptOptions: {},
    });

    expect(activeTools()).toEqual([
      "read",
      "bash",
      "edit",
      "write",
      "ls",
      "rg",
      "fd",
    ]);
    expect(result).toBeUndefined();
  });
});
