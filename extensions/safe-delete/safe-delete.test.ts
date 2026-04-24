import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { SAFE_DELETE_APPROVAL_CHANNEL } from "../shared/internal-events.ts";

const loadSafeDelete = async () => (await import("./safe-delete.ts")).default;

describe("safe-delete remote approval events", () => {
  it("emits an approval event and accepts an attached remote decision", async () => {
    const handlers = new Map<
      string,
      (event: unknown, ctx: unknown) => unknown
    >();
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
        confirm: vi.fn(async () => await new Promise<boolean>(() => undefined)),
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
});
