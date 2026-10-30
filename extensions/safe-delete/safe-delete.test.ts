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

describe("safe-delete MCP calls", () => {
  // Only bash is gated: MCP annotations are self-declared and unverified.
  it("leaves MCP tool calls untouched, even destructive-looking ones", async () => {
    const handlers = new Map<
      string,
      (event: unknown, ctx: unknown) => unknown
    >();
    const events = { emit: vi.fn(), on: vi.fn() };
    const safeDelete = await loadSafeDelete();
    safeDelete({
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
        handlers.set(name, handler);
      },
      events,
      // Names and hints a gate would have acted on.
      getAllTools: () => [
        { name: "mcp__filesystem__delete_file" },
        {
          name: "mcp__jira__create_ticket",
          annotations: { destructiveHint: true, openWorldHint: true },
        },
      ],
    } as unknown as ExtensionAPI);

    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      ui: { confirm: vi.fn(async () => true) },
      sessionManager: { getEntries: () => [] },
    };

    for (const toolName of [
      "mcp__filesystem__delete_file",
      "mcp__jira__create_ticket",
      "mcp__filesystem__read_file",
    ]) {
      const result = await handlers.get("tool_call")?.(
        { toolName, input: { path: "/etc/passwd" } },
        ctx,
      );

      expect(result).toBeUndefined();
    }

    expect(ctx.ui.confirm).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("does not read prose inside a heredoc as a deletion", async () => {
    // 实录（2026-10-27 07:58:03）：agent 往测试文件里追加用例，正文明写了
    // 「重定向 / tee / sed -i / rm / mv」这句测试标题，被读成 `rm /`。
    const handlers = new Map<
      string,
      (event: unknown, ctx: unknown) => unknown
    >();
    const events = { emit: vi.fn(), on: vi.fn() };
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
      ui: { confirm: vi.fn(async () => true) },
      sessionManager: { getEntries: () => [] },
    };

    const heredoc = [
      "cat >> notes-core.test.ts <<'EOF'",
      "",
      'it("重定向 / tee / sed -i / rm / mv 指到章节文件：拦", () => {',
      '  expect(find("rm 06-控制面.md")).toBe("06-控制面.md");',
      "});",
      "EOF",
      "",
    ].join("\n");

    const heredocResult = await handlers.get("tool_call")?.(
      { toolName: "bash", input: { command: heredoc } },
      ctx,
    );
    expect(heredocResult).toBeUndefined();

    const quotedProse = await handlers.get("tool_call")?.(
      {
        toolName: "bash",
        input: {
          command: 'echo "重定向 / tee / sed -i / rm / mv 指到章节文件"',
        },
      },
      ctx,
    );
    expect(quotedProse).toBeUndefined();

    expect(ctx.ui.confirm).not.toHaveBeenCalled();

    // The detector still fires on a real deletion command.
    const deleteCtx = {
      cwd: process.cwd(),
      hasUI: true,
      ui: { confirm: vi.fn(async () => false) },
      sessionManager: { getEntries: () => [] },
    };
    const blocked = (await handlers.get("tool_call")?.(
      { toolName: "bash", input: { command: "rm -rf /" } },
      deleteCtx,
    )) as { block?: boolean; reason?: string } | undefined;

    expect(blocked?.block).toBe(true);
    expect(blocked?.reason ?? "").toContain("Deletion targets protected path");
  });
});
