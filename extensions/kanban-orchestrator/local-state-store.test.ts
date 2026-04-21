import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { KanbanLocalStateStore } from "./local-state-store.js";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-kit-kanban-local-state-"),
  );
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("KanbanLocalStateStore", () => {
  it("persists repo, task, session, event, and handoff records", () => {
    const dir = createTempDir();
    const dbPath = path.join(dir, "kanban-state.sqlite");

    const first = new KanbanLocalStateStore({ dbPath });
    first.registerRepo({
      repoId: "repo-1",
      repoPath: "/tmp/repo-1",
      boardPath: "workitems/features.kanban.md",
      defaultAdapter: "pi",
      createdAt: "2026-04-21T00:00:00.000Z",
      updatedAt: "2026-04-21T00:00:00.000Z",
    });
    first.upsertTask({
      taskId: "task-1",
      repoId: "repo-1",
      cardId: "child-pricing-widget",
      intentType: "start-child",
      runtimeState: "running",
      conflict: true,
      attempt: 1,
      createdAt: "2026-04-21T00:00:00.000Z",
      updatedAt: "2026-04-21T00:00:01.000Z",
      request: {
        action: "apply",
        worktreeKey: "wt-1",
      },
      summary: "running",
    });
    first.upsertSession({
      sessionId: "session-1",
      taskId: "task-1",
      adapterType: "pi",
      adapterSessionRef: "chat:child-pricing-widget",
      repoPath: "/tmp/repo-1",
      worktreePath: "/tmp/repo-1/.worktrees/wt-1",
      status: "running",
      resumable: true,
      lastEventAt: "2026-04-21T00:00:02.000Z",
      createdAt: "2026-04-21T00:00:00.000Z",
      updatedAt: "2026-04-21T00:00:02.000Z",
    });
    first.appendTaskEvent({
      eventId: "event-1",
      taskId: "task-1",
      eventType: "runtime-state-changed",
      payload: {
        runtimeState: "running",
      },
      ts: "2026-04-21T00:00:01.000Z",
    });
    first.upsertHandoff({
      taskId: "task-1",
      summary: "ready for review",
      artifacts: ["diff-summary.md"],
      generatedAt: "2026-04-21T00:00:03.000Z",
    });

    const second = new KanbanLocalStateStore({ dbPath });

    expect(second.getRepo("repo-1")).toEqual({
      repoId: "repo-1",
      repoPath: "/tmp/repo-1",
      boardPath: "workitems/features.kanban.md",
      defaultAdapter: "pi",
      createdAt: "2026-04-21T00:00:00.000Z",
      updatedAt: "2026-04-21T00:00:00.000Z",
    });
    expect(second.getTask("task-1")).toEqual({
      taskId: "task-1",
      repoId: "repo-1",
      cardId: "child-pricing-widget",
      intentType: "start-child",
      runtimeState: "running",
      conflict: true,
      attempt: 1,
      createdAt: "2026-04-21T00:00:00.000Z",
      updatedAt: "2026-04-21T00:00:01.000Z",
      request: {
        action: "apply",
        worktreeKey: "wt-1",
      },
      summary: "running",
    });
    expect(second.getSessionByTask("task-1")).toEqual({
      sessionId: "session-1",
      taskId: "task-1",
      adapterType: "pi",
      adapterSessionRef: "chat:child-pricing-widget",
      repoPath: "/tmp/repo-1",
      worktreePath: "/tmp/repo-1/.worktrees/wt-1",
      status: "running",
      resumable: true,
      lastEventAt: "2026-04-21T00:00:02.000Z",
      createdAt: "2026-04-21T00:00:00.000Z",
      updatedAt: "2026-04-21T00:00:02.000Z",
    });
    expect(second.listTaskEvents("task-1")).toEqual([
      {
        eventId: "event-1",
        taskId: "task-1",
        eventType: "runtime-state-changed",
        payload: {
          runtimeState: "running",
        },
        ts: "2026-04-21T00:00:01.000Z",
      },
    ]);
    expect(second.getHandoff("task-1")).toEqual({
      taskId: "task-1",
      summary: "ready for review",
      artifacts: ["diff-summary.md"],
      generatedAt: "2026-04-21T00:00:03.000Z",
    });
  });
});
