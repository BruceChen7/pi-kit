import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { KanbanLocalStateStore } from "../extensions/kanban-orchestrator/local-state-store.js";
import { KanbanOrchestratorService } from "../extensions/kanban-orchestrator/service.js";
import { reconcileBoardRuntimeConflicts } from "./conflict-monitor.js";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-kit-kanban-conflicts-"),
  );
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("reconcileBoardRuntimeConflicts", () => {
  it("marks active runtime work as conflicting when board intent moves out of active lanes", () => {
    const dir = createTempDir();
    const dbPath = path.join(dir, "kanban-state.sqlite");
    const store = new KanbanLocalStateStore({ dbPath });
    store.registerRepo({
      repoId: "repo-1",
      repoPath: "/tmp/repo-1",
      boardPath: "workitems/features.kanban.md",
      defaultAdapter: "pi",
      createdAt: "2026-04-21T00:00:00.000Z",
      updatedAt: "2026-04-21T00:00:00.000Z",
    });
    store.upsertTask({
      taskId: "task-1",
      repoId: "repo-1",
      cardId: "child-a",
      intentType: "start-child",
      runtimeState: "running",
      conflict: false,
      attempt: 1,
      createdAt: "2026-04-21T00:00:00.000Z",
      updatedAt: "2026-04-21T00:00:01.000Z",
      request: {
        action: "open-session",
        worktreeKey: "wt-child-a",
        startedAt: "2026-04-21T00:00:01.000Z",
      },
      summary: "running",
    });

    const service = new KanbanOrchestratorService({
      repoRoot: "repo-1",
      boardPath: "workitems/features.kanban.md",
      defaultAdapter: "pi",
      localStatePath: dbPath,
      auditLogPath: path.join(dir, "execution.log.jsonl"),
      actionExecutors: {},
    });

    reconcileBoardRuntimeConflicts({
      store,
      service,
      repoId: "repo-1",
      board: {
        path: "workitems/features.kanban.md",
        lanes: [],
        cards: [{ id: "child-a", lane: "Done" }],
        errors: [],
      },
      now: () => "2026-04-21T00:00:02.000Z",
    });

    expect(store.getTask("task-1")).toMatchObject({
      conflict: true,
      updatedAt: "2026-04-21T00:00:02.000Z",
    });
    expect(service.getCardRuntime("child-a")).toMatchObject({
      status: "running",
      conflict: true,
    });
    expect(store.listTaskEvents("task-1").at(-1)).toEqual({
      eventId: "conflict:task-1:2026-04-21T00:00:02.000Z:on",
      taskId: "task-1",
      eventType: "board-runtime-conflict-detected",
      payload: {
        cardId: "child-a",
        lane: "Done",
        reason: "lane-mismatch",
      },
      ts: "2026-04-21T00:00:02.000Z",
    });
  });

  it("clears conflict when board intent returns to an active lane", () => {
    const dir = createTempDir();
    const dbPath = path.join(dir, "kanban-state.sqlite");
    const store = new KanbanLocalStateStore({ dbPath });
    store.registerRepo({
      repoId: "repo-1",
      repoPath: "/tmp/repo-1",
      boardPath: "workitems/features.kanban.md",
      defaultAdapter: "pi",
      createdAt: "2026-04-21T00:00:00.000Z",
      updatedAt: "2026-04-21T00:00:00.000Z",
    });
    store.upsertTask({
      taskId: "task-2",
      repoId: "repo-1",
      cardId: "child-b",
      intentType: "start-child",
      runtimeState: "awaiting-reconnect",
      conflict: true,
      attempt: 1,
      createdAt: "2026-04-21T00:00:00.000Z",
      updatedAt: "2026-04-21T00:00:01.000Z",
      request: {
        action: "open-session",
        worktreeKey: "wt-child-b",
        startedAt: "2026-04-21T00:00:01.000Z",
      },
      summary: "session lost",
    });

    const service = new KanbanOrchestratorService({
      repoRoot: "repo-1",
      boardPath: "workitems/features.kanban.md",
      defaultAdapter: "pi",
      localStatePath: dbPath,
      auditLogPath: path.join(dir, "execution.log.jsonl"),
      actionExecutors: {},
    });

    reconcileBoardRuntimeConflicts({
      store,
      service,
      repoId: "repo-1",
      board: {
        path: "workitems/features.kanban.md",
        lanes: [],
        cards: [{ id: "child-b", lane: "In Progress" }],
        errors: [],
      },
      now: () => "2026-04-21T00:00:02.000Z",
    });

    expect(store.getTask("task-2")).toMatchObject({
      conflict: false,
      updatedAt: "2026-04-21T00:00:02.000Z",
    });
    expect(service.getCardRuntime("child-b")).toMatchObject({
      status: "awaiting-reconnect",
      conflict: false,
    });
    expect(store.listTaskEvents("task-2").at(-1)).toEqual({
      eventId: "conflict:task-2:2026-04-21T00:00:02.000Z:off",
      taskId: "task-2",
      eventType: "board-runtime-conflict-cleared",
      payload: {
        cardId: "child-b",
      },
      ts: "2026-04-21T00:00:02.000Z",
    });
  });
});
