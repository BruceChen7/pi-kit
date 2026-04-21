import { describe, expect, it } from "vitest";

import { KanbanRuntimeStateStore } from "./runtime-state.js";

describe("KanbanRuntimeStateStore", () => {
  it("tracks child lifecycle state and terminal output", () => {
    const store = new KanbanRuntimeStateStore();
    const lifecycleEvents: string[] = [];
    const terminalEvents: string[] = [];

    const unsubscribeLifecycle = store.subscribeLifecycle((event) => {
      lifecycleEvents.push(event.type);
    });
    const unsubscribeTerminal = store.subscribeTerminal("child-a", (event) => {
      terminalEvents.push(event.type);
    });

    store.recordChildLifecycle({
      type: "child-running",
      cardId: "child-a",
      summary: "agent started",
      ts: "2026-04-20T00:00:00.000Z",
    });
    store.appendTerminalChunk({
      cardId: "child-a",
      chunk: "hello world",
      ts: "2026-04-20T00:00:01.000Z",
    });
    store.recordChildLifecycle({
      type: "child-completed",
      cardId: "child-a",
      summary: "done",
      ts: "2026-04-20T00:00:02.000Z",
    });

    unsubscribeLifecycle();
    unsubscribeTerminal();

    expect(lifecycleEvents).toEqual(["child-running", "child-completed"]);
    expect(terminalEvents).toEqual(["ready", "status", "chunk", "done"]);
    expect(store.getCardRuntime("child-a")).toEqual({
      cardId: "child-a",
      status: "completed",
      summary: "done",
      requestId: null,
      startedAt: "2026-04-20T00:00:00.000Z",
      completedAt: "2026-04-20T00:00:02.000Z",
      terminalAvailable: true,
      terminalChunks: ["hello world"],
      terminalProtocol: "sse-text-stream",
      conflict: false,
    });
  });

  it("maps failed action state into failed child lifecycle state", () => {
    const store = new KanbanRuntimeStateStore();
    const lifecycleEvents: string[] = [];
    store.subscribeLifecycle((event) => {
      lifecycleEvents.push(event.type);
    });

    store.recordActionState({
      requestId: "req-1",
      action: "apply",
      cardId: "child-b",
      worktreeKey: "wt-child-b",
      status: "failed",
      summary: "dispatch failed",
      startedAt: "2026-04-20T00:00:00.000Z",
      finishedAt: "2026-04-20T00:00:01.000Z",
      durationMs: 1000,
    });

    expect(lifecycleEvents).toEqual(["child-failed"]);
    expect(store.getCardRuntime("child-b")).toEqual({
      cardId: "child-b",
      status: "failed",
      summary: "dispatch failed",
      requestId: "req-1",
      startedAt: "2026-04-20T00:00:00.000Z",
      completedAt: "2026-04-20T00:00:01.000Z",
      terminalAvailable: false,
      terminalChunks: [],
      terminalProtocol: "sse-text-stream",
      conflict: false,
    });
  });
});
