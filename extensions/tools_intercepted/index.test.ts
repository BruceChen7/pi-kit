import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import extension, { computeToolCorrection } from "./index.js";

const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
});

type EventHandlers = Record<string, Array<(...args: unknown[]) => unknown>>;

type FakeCtx = { getSystemPrompt: () => string };

function createFakeApi(initialTools: string[]): {
  api: ExtensionAPI;
  handlers: EventHandlers;
  activeTools: () => string[];
  ctx: FakeCtx;
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
  } as unknown as ExtensionAPI;

  return {
    api,
    handlers,
    activeTools: () => [...tools],
    // getSystemPrompt lives on ExtensionContext (the ctx handler arg), not on
    // the ExtensionAPI (pi) object.
    ctx: { getSystemPrompt: () => `tools:${tools.join(",")}` },
  };
}

function trigger(
  handlers: EventHandlers,
  event: string,
  eventPayload: object,
  ctx: FakeCtx = { getSystemPrompt: () => "" },
): unknown {
  const callbacks = handlers[event];
  if (!callbacks || callbacks.length === 0) {
    throw new Error(`No handler registered for ${event}`);
  }
  return (
    callbacks[callbacks.length - 1] as (e: object, c: FakeCtx) => unknown
  )(eventPayload, ctx);
}

describe("computeToolCorrection", () => {
  it.each([
    {
      name: "adds rg/fd and removes grep/find when both pairs are present",
      current: ["read", "bash", "write", "grep", "find", "ls"],
      expectedNext: ["read", "bash", "write", "ls", "rg", "fd"],
      expectedChanged: true,
    },
    {
      name: "adds rg/fd when only grep is present",
      current: ["read", "grep", "ls"],
      expectedNext: ["read", "ls", "rg", "fd"],
      expectedChanged: true,
    },
    {
      name: "keeps unrelated active tools untouched",
      current: ["cs_search", "qmd_query", "grep", "find"],
      expectedNext: ["cs_search", "qmd_query", "rg", "fd"],
      expectedChanged: true,
    },
    {
      name: "is a no-op when the tool set is already correct",
      current: ["read", "bash", "ls", "rg", "fd"],
      expectedNext: ["read", "bash", "ls", "rg", "fd"],
      expectedChanged: false,
    },
    {
      name: "is a no-op when rg/fd are present and grep/find absent",
      current: ["rg", "fd", "bash"],
      expectedNext: ["rg", "fd", "bash"],
      expectedChanged: false,
    },
  ])("$name", ({ current, expectedNext, expectedChanged }) => {
    const { next, changed } = computeToolCorrection(current);
    expect(next).toEqual(expectedNext);
    expect(changed).toBe(expectedChanged);
  });
});

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

    // The chained system prompt accumulates earlier before_agent_start
    // handlers' injections. Contract: our correction appends to it instead
    // of replacing the chain with a session-level snapshot.
    const chainedPrompt =
      "## Plan Mode Extension\n...injections from earlier handlers...";
    const result = trigger(handlers, "before_agent_start", {
      type: "before_agent_start",
      prompt: "search the repo",
      systemPrompt: chainedPrompt,
      systemPromptOptions: {},
    });

    expect(activeTools()).toContain("rg");
    expect(activeTools()).toContain("fd");
    expect(activeTools()).not.toContain("grep");
    expect(activeTools()).not.toContain("find");

    // The returned system prompt preserves the chain (earlier injections
    // stay intact) and appends the rg/fd correction notice.
    const resultObj = result as { systemPrompt?: string } | undefined;
    expect(resultObj?.systemPrompt).toContain(chainedPrompt);
    expect(resultObj?.systemPrompt).toContain("rg");
    expect(resultObj?.systemPrompt).toContain("fd");
    expect(resultObj?.systemPrompt).toContain("grep/find tools are disabled");
  });

  it("returns the session prompt when the chain is unavailable", () => {
    const { api, handlers, ctx } = createFakeApi([
      "read",
      "write",
      "grep",
      "find",
      "ls",
    ]);

    extension(api);

    // Defensive path: the event contract guarantees systemPrompt, but handle
    // a missing field by falling back to ctx.getSystemPrompt().
    const result = trigger(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "hi",
        systemPromptOptions: {},
      } as object,
      ctx,
    );

    const resultObj = result as { systemPrompt?: string } | undefined;
    expect(resultObj?.systemPrompt).toBeDefined();
    expect(resultObj?.systemPrompt).toContain("rg");
    expect(resultObj?.systemPrompt).toContain("grep/find tools are disabled");
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
