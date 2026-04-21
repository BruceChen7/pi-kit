import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { KanbanLocalStateStore } from "../extensions/kanban-orchestrator/local-state-store.js";
import { KanbanOrchestratorService } from "../extensions/kanban-orchestrator/service.js";
import { consumeRuntimeSessionStream } from "./runtime-stream.js";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-kit-kanban-runtime-stream-"),
  );
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("consumeRuntimeSessionStream", () => {
  it("marks unexpected stream disconnects as awaiting reconnect and records an audit event", async () => {
    const dir = createTempDir();
    const dbPath = path.join(dir, "kanban-state.sqlite");
    const store = new KanbanLocalStateStore({ dbPath });
    store.registerRepo({
      repoId: "/tmp/repo-1",
      repoPath: "/tmp/repo-1",
      boardPath: "workitems/features.kanban.md",
      defaultAdapter: "pi",
      createdAt: "2026-04-21T00:00:00.000Z",
      updatedAt: "2026-04-21T00:00:00.000Z",
    });
    store.upsertTask({
      taskId: "task-stream-disconnect",
      repoId: "/tmp/repo-1",
      cardId: "child-disconnect",
      intentType: "start-child",
      runtimeState: "running",
      conflict: false,
      attempt: 1,
      createdAt: "2026-04-21T00:00:00.000Z",
      updatedAt: "2026-04-21T00:00:00.000Z",
      request: {
        action: "apply",
        worktreeKey: "wt-child-disconnect",
      },
      summary: "running",
    });

    const service = new KanbanOrchestratorService({
      repoRoot: "/tmp/repo-1",
      boardPath: "workitems/features.kanban.md",
      defaultAdapter: "pi",
      localStatePath: dbPath,
      auditLogPath: path.join(dir, "execution.log.jsonl"),
      actionExecutors: {},
    });

    await consumeRuntimeSessionStream({
      store,
      service,
      taskId: "task-stream-disconnect",
      cardId: "child-disconnect",
      sessionRef: "chat:child-disconnect",
      events: (async function* () {
        yield {
          type: "agent-started",
          sessionRef: "chat:child-disconnect",
        } as const;
        throw new Error("socket closed");
      })(),
      now: (() => {
        const values = ["2026-04-21T00:00:01.000Z", "2026-04-21T00:00:02.000Z"];
        return () => values.shift() ?? "2026-04-21T00:00:02.000Z";
      })(),
    });

    expect(service.getCardRuntime("child-disconnect")).toEqual({
      cardId: "child-disconnect",
      status: "awaiting-reconnect",
      summary: "stream disconnected",
      requestId: "task-stream-disconnect",
      startedAt: "2026-04-21T00:00:01.000Z",
      completedAt: null,
      terminalAvailable: true,
      terminalChunks: [],
      terminalProtocol: "sse-text-stream",
      conflict: false,
    });
    expect(store.listTaskEvents("task-stream-disconnect").at(-1)).toEqual({
      eventId:
        "runtime:task-stream-disconnect:stream-disconnected:2026-04-21T00:00:02.000Z",
      taskId: "task-stream-disconnect",
      eventType: "runtime-stream-disconnected",
      payload: {
        sessionRef: "chat:child-disconnect",
        error: "socket closed",
      },
      ts: "2026-04-21T00:00:02.000Z",
    });
  });

  it("marks session loss as awaiting reconnect instead of collapsing it into failed", async () => {
    const dir = createTempDir();
    const dbPath = path.join(dir, "kanban-state.sqlite");
    const store = new KanbanLocalStateStore({ dbPath });
    store.registerRepo({
      repoId: "/tmp/repo-1",
      repoPath: "/tmp/repo-1",
      boardPath: "workitems/features.kanban.md",
      defaultAdapter: "pi",
      createdAt: "2026-04-21T00:00:00.000Z",
      updatedAt: "2026-04-21T00:00:00.000Z",
    });
    store.upsertTask({
      taskId: "task-session-lost",
      repoId: "/tmp/repo-1",
      cardId: "child-lost",
      intentType: "start-child",
      runtimeState: "running",
      conflict: false,
      attempt: 1,
      createdAt: "2026-04-21T00:00:00.000Z",
      updatedAt: "2026-04-21T00:00:00.000Z",
      request: {
        action: "apply",
        worktreeKey: "wt-child-lost",
      },
      summary: "running",
    });

    const service = new KanbanOrchestratorService({
      repoRoot: "/tmp/repo-1",
      boardPath: "workitems/features.kanban.md",
      defaultAdapter: "pi",
      localStatePath: dbPath,
      auditLogPath: path.join(dir, "execution.log.jsonl"),
      actionExecutors: {},
    });

    await consumeRuntimeSessionStream({
      store,
      service,
      taskId: "task-session-lost",
      cardId: "child-lost",
      sessionRef: "chat:child-lost",
      events: (async function* () {
        yield { type: "agent-started", sessionRef: "chat:child-lost" } as const;
        yield { type: "session-lost", sessionRef: "chat:child-lost" } as const;
      })(),
      now: (() => {
        const values = ["2026-04-21T00:00:01.000Z", "2026-04-21T00:00:02.000Z"];
        return () => values.shift() ?? "2026-04-21T00:00:02.000Z";
      })(),
    });

    expect(service.getCardRuntime("child-lost")).toEqual({
      cardId: "child-lost",
      status: "awaiting-reconnect",
      summary: "session lost",
      requestId: "task-session-lost",
      startedAt: "2026-04-21T00:00:01.000Z",
      completedAt: null,
      terminalAvailable: true,
      terminalChunks: [],
      terminalProtocol: "sse-text-stream",
      conflict: false,
    });
  });

  it("normalizes runtime events into card runtime state and persisted task events", async () => {
    const dir = createTempDir();
    const dbPath = path.join(dir, "kanban-state.sqlite");
    const store = new KanbanLocalStateStore({ dbPath });
    store.registerRepo({
      repoId: "/tmp/repo-1",
      repoPath: "/tmp/repo-1",
      boardPath: "workitems/features.kanban.md",
      defaultAdapter: "pi",
      createdAt: "2026-04-21T00:00:00.000Z",
      updatedAt: "2026-04-21T00:00:00.000Z",
    });
    store.upsertTask({
      taskId: "task-1",
      repoId: "/tmp/repo-1",
      cardId: "child-a",
      intentType: "start-child",
      runtimeState: "running",
      conflict: false,
      attempt: 1,
      createdAt: "2026-04-21T00:00:00.000Z",
      updatedAt: "2026-04-21T00:00:00.000Z",
      request: {
        action: "apply",
        worktreeKey: "wt-child-a",
      },
      summary: "running",
    });

    const service = new KanbanOrchestratorService({
      repoRoot: "/tmp/repo-1",
      boardPath: "workitems/features.kanban.md",
      defaultAdapter: "pi",
      localStatePath: dbPath,
      auditLogPath: path.join(dir, "execution.log.jsonl"),
      actionExecutors: {},
    });

    await consumeRuntimeSessionStream({
      store,
      service,
      taskId: "task-1",
      cardId: "child-a",
      sessionRef: "chat:child-a",
      events: (async function* () {
        yield { type: "session-opened", sessionRef: "chat:child-a" } as const;
        yield { type: "agent-started", sessionRef: "chat:child-a" } as const;
        yield {
          type: "output-delta",
          sessionRef: "chat:child-a",
          chunk: "hello world",
        } as const;
        yield {
          type: "agent-completed",
          sessionRef: "chat:child-a",
          summary: "done",
        } as const;
      })(),
      now: (() => {
        const values = [
          "2026-04-21T00:00:01.000Z",
          "2026-04-21T00:00:02.000Z",
          "2026-04-21T00:00:03.000Z",
        ];
        return () => values.shift() ?? "2026-04-21T00:00:03.000Z";
      })(),
    });

    expect(service.getCardRuntime("child-a")).toEqual({
      cardId: "child-a",
      status: "completed",
      summary: "done",
      requestId: "task-1",
      startedAt: "2026-04-21T00:00:01.000Z",
      completedAt: "2026-04-21T00:00:03.000Z",
      terminalAvailable: true,
      terminalChunks: ["hello world"],
      terminalProtocol: "sse-text-stream",
      conflict: false,
    });
    expect(store.listTaskEvents("task-1").slice(-4)).toEqual([
      {
        eventId: "runtime:task-1:session-opened:2026-04-21T00:00:01.000Z",
        taskId: "task-1",
        eventType: "runtime-session-opened",
        payload: {
          sessionRef: "chat:child-a",
        },
        ts: "2026-04-21T00:00:01.000Z",
      },
      {
        eventId: "runtime:task-1:agent-started:2026-04-21T00:00:01.000Z",
        taskId: "task-1",
        eventType: "runtime-agent-started",
        payload: {
          sessionRef: "chat:child-a",
        },
        ts: "2026-04-21T00:00:01.000Z",
      },
      {
        eventId: "runtime:task-1:output-delta:2026-04-21T00:00:02.000Z",
        taskId: "task-1",
        eventType: "runtime-output-delta",
        payload: {
          sessionRef: "chat:child-a",
          chunk: "hello world",
        },
        ts: "2026-04-21T00:00:02.000Z",
      },
      {
        eventId: "runtime:task-1:agent-completed:2026-04-21T00:00:03.000Z",
        taskId: "task-1",
        eventType: "runtime-agent-completed",
        payload: {
          sessionRef: "chat:child-a",
          summary: "done",
        },
        ts: "2026-04-21T00:00:03.000Z",
      },
    ]);
  });
});
