import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { SAFE_DELETE_APPROVAL_CHANNEL } from "../shared/internal-events.ts";

const loadSafeDelete = async () => (await import("./safe-delete.ts")).default;

describe("safe-delete command analysis", () => {
  it.each([
    "npm format",
    "npm run format",
    "pnpm format",
    "biome format --write .",
  ])("does not intercept language formatter command: %s", async (command) => {
    const handlers = new Map<
      string,
      (event: unknown, ctx: unknown) => unknown
    >();
    const events = {
      emit: vi.fn(),
      on: vi.fn(),
    };
    const safeDelete = await loadSafeDelete();
    safeDelete({
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
        handlers.set(name, handler);
      },
      events,
    } as unknown as ExtensionAPI);

    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      ui: {
        confirm: vi.fn(async () => true),
      },
      sessionManager: {
        getEntries: () => [],
      },
    };

    const result = await handlers.get("tool_call")?.(
      { toolName: "bash", input: { command } },
      ctx,
    );

    expect(result).toBeUndefined();
    expect(ctx.ui.confirm).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("still intercepts direct filesystem format commands", async () => {
    const handlers = new Map<
      string,
      (event: unknown, ctx: unknown) => unknown
    >();
    const events = {
      emit: vi.fn(),
      on: vi.fn(),
    };
    const safeDelete = await loadSafeDelete();
    safeDelete({
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
        handlers.set(name, handler);
      },
      events,
    } as unknown as ExtensionAPI);

    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      ui: {
        confirm: vi.fn(async () => true),
      },
      sessionManager: {
        getEntries: () => [],
      },
    };

    const result = await handlers.get("tool_call")?.(
      { toolName: "bash", input: { command: "format /dev/disk2" } },
      ctx,
    );

    expect(result).toBeUndefined();
    expect(ctx.ui.confirm).toHaveBeenCalledWith(
      "CRITICAL: Destructive command detected",
      expect.stringContaining("Filesystem format command detected"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(events.emit).toHaveBeenCalledTimes(1);
  });
});

describe("safe-delete remote approval events", () => {
  it("closes local confirmation when an attached remote decision wins", async () => {
    const handlers = new Map<
      string,
      (event: unknown, ctx: unknown) => unknown
    >();
    let abortSignal: AbortSignal | undefined;
    const events = {
      emitted: [] as Array<{ channel: string; payload: unknown }>,
      emit(channel: string, payload: unknown) {
        this.emitted.push({ channel, payload });
        const event = payload as {
          attachRemoteDecision: (decision: Promise<boolean>) => void;
        };
        event.attachRemoteDecision(Promise.resolve(true));
      },
      on: vi.fn(),
    };
    const safeDelete = await loadSafeDelete();
    safeDelete({
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
        handlers.set(name, handler);
      },
      events,
    } as unknown as ExtensionAPI);

    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      ui: {
        confirm: vi.fn(
          async (
            _title: string,
            _body: string,
            options?: { signal?: AbortSignal },
          ) => {
            abortSignal = options?.signal;
            return await new Promise<boolean>((resolve) => {
              options?.signal?.addEventListener("abort", () => resolve(false));
            });
          },
        ),
      },
      sessionManager: {
        getEntries: () => [],
      },
    };

    const result = await handlers.get("tool_call")?.(
      { toolName: "bash", input: { command: "rm -rf /" } },
      ctx,
    );

    expect(result).toBeUndefined();
    expect(ctx.ui.confirm).toHaveBeenCalledWith(
      "CRITICAL: Destructive command detected",
      expect.stringContaining("rm -rf /"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(abortSignal?.aborted).toBe(true);
    expect(events.emitted).toHaveLength(1);
    expect(events.emitted[0]).toEqual({
      channel: SAFE_DELETE_APPROVAL_CHANNEL,
      payload: expect.objectContaining({
        type: "safe-delete.approval",
        command: "rm -rf /",
        title: "CRITICAL: Destructive command detected",
        body: expect.stringContaining("rm -rf /"),
        ctx,
      }),
    });
  });

  it("blocks the command when an attached remote decision denies", async () => {
    const handlers = new Map<
      string,
      (event: unknown, ctx: unknown) => unknown
    >();
    let abortSignal: AbortSignal | undefined;
    const events = {
      emit(_channel: string, payload: unknown) {
        const event = payload as {
          attachRemoteDecision: (decision: Promise<boolean>) => void;
        };
        event.attachRemoteDecision(Promise.resolve(false));
      },
      on: vi.fn(),
    };
    const safeDelete = await loadSafeDelete();
    safeDelete({
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
        handlers.set(name, handler);
      },
      events,
    } as unknown as ExtensionAPI);

    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      ui: {
        confirm: vi.fn(
          async (
            _title: string,
            _body: string,
            options?: { signal?: AbortSignal },
          ) => {
            abortSignal = options?.signal;
            return await new Promise<boolean>(() => undefined);
          },
        ),
      },
      sessionManager: {
        getEntries: () => [],
      },
    };

    const result = await handlers.get("tool_call")?.(
      { toolName: "bash", input: { command: "rm -rf /" } },
      ctx,
    );

    expect(result).toMatchObject({
      block: true,
      reason: expect.stringContaining("User blocked destructive command"),
    });
    expect(abortSignal?.aborted).toBe(true);
  });

  it("falls back to local confirmation when no remote decision is attached", async () => {
    const handlers = new Map<
      string,
      (event: unknown, ctx: unknown) => unknown
    >();
    const events = {
      emitted: [] as Array<{ channel: string; payload: unknown }>,
      emit(channel: string, payload: unknown) {
        this.emitted.push({ channel, payload });
      },
      on: vi.fn(),
    };
    const safeDelete = await loadSafeDelete();
    safeDelete({
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
        handlers.set(name, handler);
      },
      events,
    } as unknown as ExtensionAPI);

    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      ui: {
        confirm: vi.fn(async () => true),
      },
      sessionManager: {
        getEntries: () => [],
      },
    };

    const result = await handlers.get("tool_call")?.(
      { toolName: "bash", input: { command: "rm -rf /" } },
      ctx,
    );

    expect(result).toBeUndefined();
    expect(ctx.ui.confirm).toHaveBeenCalledWith(
      "CRITICAL: Destructive command detected",
      expect.stringContaining("rm -rf /"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(events.emitted).toHaveLength(1);
  });
});

type ToolInfoStub = {
  name: string;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
};

const setupSafeDelete = async (toolInfos: ToolInfoStub[] = []) => {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const events = { emit: vi.fn(), on: vi.fn() };
  const safeDelete = await loadSafeDelete();
  safeDelete({
    on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(name, handler);
    },
    events,
    getAllTools: () => toolInfos,
  } as unknown as ExtensionAPI);

  return { handlers, events };
};

const buildToolCallCtx = (options: { hasUI?: boolean; approve?: boolean }) => ({
  cwd: process.cwd(),
  hasUI: options.hasUI ?? true,
  ui: {
    confirm: vi.fn(
      async (
        _title: string,
        _body: string,
        _options?: { signal?: AbortSignal },
      ) => options.approve ?? true,
    ),
  },
  sessionManager: { getEntries: () => [] },
});

describe("safe-delete MCP tool gate", () => {
  it("confirms a non-read-only MCP call and lets it through when approved", async () => {
    const { handlers, events } = await setupSafeDelete([
      {
        name: "mcp__filesystem__delete_file",
        annotations: { destructiveHint: true },
      },
    ]);
    const ctx = buildToolCallCtx({ approve: true });

    const result = await handlers.get("tool_call")?.(
      {
        toolName: "mcp__filesystem__delete_file",
        input: { path: "src/a.ts" },
      },
      ctx,
    );

    expect(result).toBeUndefined();
    expect(ctx.ui.confirm).toHaveBeenCalledWith(
      "MCP tool call may modify data",
      expect.stringContaining("mcp__filesystem__delete_file"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(ctx.ui.confirm.mock.calls[0]?.[1]).toContain('"path": "src/a.ts"');
    expect(events.emit).toHaveBeenCalledWith(
      SAFE_DELETE_APPROVAL_CHANNEL,
      expect.objectContaining({
        type: "safe-delete.approval",
        command: "mcp__filesystem__delete_file",
        title: "MCP tool call may modify data",
      }),
    );
  });

  it("blocks the MCP call when the confirmation is denied", async () => {
    const { handlers } = await setupSafeDelete([
      { name: "mcp__filesystem__delete_file" },
    ]);
    const ctx = buildToolCallCtx({ approve: false });

    const result = await handlers.get("tool_call")?.(
      {
        toolName: "mcp__filesystem__delete_file",
        input: { path: "src/a.ts" },
      },
      ctx,
    );

    expect(result).toMatchObject({
      block: true,
      reason: expect.stringContaining("was not approved"),
    });
  });

  it("skips confirmation for MCP tools that declare readOnlyHint", async () => {
    const { handlers } = await setupSafeDelete([
      {
        name: "mcp__filesystem__read_file",
        annotations: { readOnlyHint: true },
      },
    ]);
    const ctx = buildToolCallCtx({});

    const result = await handlers.get("tool_call")?.(
      { toolName: "mcp__filesystem__read_file", input: { path: "src/a.ts" } },
      ctx,
    );

    expect(result).toBeUndefined();
    expect(ctx.ui.confirm).not.toHaveBeenCalled();
  });

  it("skips confirmation for additive closed-domain MCP tools", async () => {
    const { handlers } = await setupSafeDelete([
      {
        name: "mcp__linear__create_issue",
        annotations: { destructiveHint: false, openWorldHint: false },
      },
    ]);
    const ctx = buildToolCallCtx({});

    const result = await handlers.get("tool_call")?.(
      { toolName: "mcp__linear__create_issue", input: { title: "x" } },
      ctx,
    );

    expect(result).toBeUndefined();
    expect(ctx.ui.confirm).not.toHaveBeenCalled();
  });

  it("passes MCP calls through without a UI, like the bash branch", async () => {
    const { handlers } = await setupSafeDelete([
      { name: "mcp__filesystem__delete_file" },
    ]);
    const ctx = buildToolCallCtx({ hasUI: false });

    const result = await handlers.get("tool_call")?.(
      {
        toolName: "mcp__filesystem__delete_file",
        input: { path: "src/a.ts" },
      },
      ctx,
    );

    expect(result).toBeUndefined();
    expect(ctx.ui.confirm).not.toHaveBeenCalled();
  });
});
