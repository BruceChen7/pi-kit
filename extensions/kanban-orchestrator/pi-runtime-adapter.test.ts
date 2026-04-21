import { describe, expect, it, vi } from "vitest";

import { createPiRuntimeAdapterWithDeps } from "./pi-runtime-adapter.js";
import { createPiRuntimeEventBridge } from "./pi-runtime-event-bridge.js";

describe("createPiRuntimeAdapterWithDeps", () => {
  it("opens a pi session by switching to the target branch", async () => {
    const runFeatureSwitch = vi.fn(async () => {});
    const adapter = createPiRuntimeAdapterWithDeps({
      runFeatureSwitch,
      sendUserMessage: vi.fn(),
      eventBridge: createPiRuntimeEventBridge(),
    });

    const result = await adapter.openSession({
      repoPath: "/tmp/repo",
      worktreePath: "/tmp/repo/.worktrees/main--feat-checkout-v2",
      taskId: "task-1",
      metadata: {
        branch: "main--feat-checkout-v2",
        sessionRef: "chat:feat-checkout-v2",
      },
    });

    expect(runFeatureSwitch).toHaveBeenCalledWith("main--feat-checkout-v2");
    expect(result).toEqual({
      sessionRef: "chat:feat-checkout-v2",
      resumable: false,
    });
  });

  it("sends prompts through pi follow-up messages", async () => {
    const sendUserMessage = vi.fn();
    const adapter = createPiRuntimeAdapterWithDeps({
      runFeatureSwitch: vi.fn(async () => {}),
      sendUserMessage,
      eventBridge: createPiRuntimeEventBridge(),
    });

    await adapter.sendPrompt({
      sessionRef: "chat:feat-checkout-v2",
      prompt: "[CTX]\nhello",
    });

    expect(sendUserMessage).toHaveBeenCalledWith("[CTX]\nhello", {
      deliverAs: "followUp",
    });
  });

  it("streams events emitted for the attached worktree", async () => {
    const eventBridge = createPiRuntimeEventBridge();
    const adapter = createPiRuntimeAdapterWithDeps({
      runFeatureSwitch: vi.fn(async () => {}),
      sendUserMessage: vi.fn(),
      eventBridge,
    });

    await adapter.openSession({
      repoPath: "/tmp/repo",
      worktreePath: "/tmp/repo/.worktrees/main--feat-checkout-v2",
      taskId: "task-2",
      metadata: {
        branch: "main--feat-checkout-v2",
        sessionRef: "chat:feat-checkout-v2",
      },
    });

    const received: string[] = [];
    const streamTask = (async () => {
      for await (const event of adapter.streamEvents("chat:feat-checkout-v2")) {
        received.push(event.type);
      }
    })();

    eventBridge.emitForWorktreePath(
      "/tmp/repo/.worktrees/main--feat-checkout-v2",
      {
        type: "agent-started",
      },
    );
    eventBridge.emitForWorktreePath(
      "/tmp/repo/.worktrees/main--feat-checkout-v2",
      {
        type: "output-delta",
        chunk: "hello world",
      },
    );
    eventBridge.emitForWorktreePath(
      "/tmp/repo/.worktrees/main--feat-checkout-v2",
      {
        type: "agent-completed",
        summary: "done",
      },
    );

    await streamTask;

    expect(received).toEqual([
      "session-opened",
      "agent-started",
      "output-delta",
      "agent-completed",
    ]);
  });
});
