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
