import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { KanbanLocalStateStore } from "../extensions/kanban-orchestrator/local-state-store.js";
import { recoverKanbanTasks } from "./recovery.js";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-kanban-recovery-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("recoverKanbanTasks", () => {
  it("records adapter attach failures as recoverable recovery events", async () => {
    const dir = createTempDir();
    const store = new KanbanLocalStateStore({
      dbPath: path.join(dir, "kanban-state.sqlite"),
    });
    store.registerRepo({
      repoId: "repo-1",
      repoPath: "/tmp/repo-1",
      boardPath: "workitems/features.kanban.md",
      defaultAdapter: "pi",
      createdAt: "2026-04-21T00:00:00.000Z",
      updatedAt: "2026-04-21T00:00:00.000Z",
    });
    store.upsertTask({
      taskId: "task-attach-fail",
      repoId: "repo-1",
      cardId: "child-attach-fail",
      intentType: "start-child",
      runtimeState: "running",
      conflict: false,
      attempt: 1,
      createdAt: "2026-04-21T00:00:00.000Z",
      updatedAt: "2026-04-21T00:00:01.000Z",
      request: {
        action: "apply",
        worktreeKey: "wt-child-attach-fail",
      },
      summary: "running",
    });
    store.upsertSession({
      sessionId: "session-attach-fail",
      taskId: "task-attach-fail",
      adapterType: "pi",
      adapterSessionRef: "chat:child-attach-fail",
      repoPath: "/tmp/repo-1",
      worktreePath: "/tmp/repo-1/.worktrees/wt-child-attach-fail",
      status: "running",
      resumable: true,
      lastEventAt: "2026-04-21T00:00:01.000Z",
      createdAt: "2026-04-21T00:00:00.000Z",
      updatedAt: "2026-04-21T00:00:01.000Z",
    });

    await recoverKanbanTasks({
      store,
      repoId: "repo-1",
      adapters: {
        pi: {
          kind: "pi",
          openSession: vi.fn(),
          resumeSession: vi.fn(async () => {
            throw new Error("bridge unavailable");
          }),
          sendPrompt: vi.fn(),
          interrupt: vi.fn(),
          closeSession: vi.fn(),
          getSessionStatus: vi.fn(async () => ({
            status: "unknown",
            resumable: true,
          })),
          streamEvents: vi.fn(async function* () {}),
        },
      },
      now: () => "2026-04-21T00:00:02.000Z",
    });

    expect(store.getTask("task-attach-fail")).toMatchObject({
      runtimeState: "recoverable-failed",
      updatedAt: "2026-04-21T00:00:02.000Z",
      summary: "adapter attach failed",
    });
    expect(store.listTaskEvents("task-attach-fail").at(-1)).toEqual({
      eventId: "recovery:task-attach-fail:2026-04-21T00:00:02.000Z",
      taskId: "task-attach-fail",
      eventType: "recovery-attach-failed",
      payload: {
        adapterType: "pi",
        reason: "attach-failed",
        error: "bridge unavailable",
      },
      ts: "2026-04-21T00:00:02.000Z",
    });
  });

  it("marks running tasks as recoverable-failed when the adapter cannot resume them", async () => {
    const dir = createTempDir();
    const store = new KanbanLocalStateStore({
      dbPath: path.join(dir, "kanban-state.sqlite"),
    });
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
        action: "apply",
        worktreeKey: "wt-child-a",
      },
      summary: "running",
    });
    store.upsertSession({
      sessionId: "session-1",
      taskId: "task-1",
      adapterType: "pi",
      adapterSessionRef: "chat:child-a",
      repoPath: "/tmp/repo-1",
      worktreePath: "/tmp/repo-1/.worktrees/wt-child-a",
      status: "running",
      resumable: true,
      lastEventAt: "2026-04-21T00:00:01.000Z",
      createdAt: "2026-04-21T00:00:00.000Z",
      updatedAt: "2026-04-21T00:00:01.000Z",
    });

    await recoverKanbanTasks({
      store,
      repoId: "repo-1",
      adapters: {
        pi: {
          kind: "pi",
          openSession: vi.fn(),
          resumeSession: vi.fn(async () => ({
            sessionRef: "chat:child-a",
            attached: false,
            resumable: false,
          })),
          sendPrompt: vi.fn(),
          interrupt: vi.fn(),
          closeSession: vi.fn(),
          getSessionStatus: vi.fn(async () => ({
            status: "failed",
            resumable: false,
          })),
          streamEvents: vi.fn(async function* () {}),
        },
      },
      now: () => "2026-04-21T00:00:02.000Z",
    });

    expect(store.getTask("task-1")).toMatchObject({
      runtimeState: "recoverable-failed",
      updatedAt: "2026-04-21T00:00:02.000Z",
      summary: "session could not be resumed",
    });
    expect(store.listTaskEvents("task-1").at(-1)).toEqual({
      eventId: "recovery:task-1:2026-04-21T00:00:02.000Z",
      taskId: "task-1",
      eventType: "recovery-failed",
      payload: {
        adapterType: "pi",
        resumable: false,
      },
      ts: "2026-04-21T00:00:02.000Z",
    });
  });

  it("records successful resume when the adapter reattaches a running session", async () => {
    const dir = createTempDir();
    const store = new KanbanLocalStateStore({
      dbPath: path.join(dir, "kanban-state.sqlite"),
    });
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
      runtimeState: "running",
      conflict: false,
      attempt: 1,
      createdAt: "2026-04-21T00:00:00.000Z",
      updatedAt: "2026-04-21T00:00:01.000Z",
      request: {
        action: "apply",
        worktreeKey: "wt-child-b",
      },
      summary: "running",
    });
    store.upsertSession({
      sessionId: "session-2",
      taskId: "task-2",
      adapterType: "pi",
      adapterSessionRef: "chat:child-b",
      repoPath: "/tmp/repo-1",
      worktreePath: "/tmp/repo-1/.worktrees/wt-child-b",
      status: "running",
      resumable: true,
      lastEventAt: "2026-04-21T00:00:01.000Z",
      createdAt: "2026-04-21T00:00:00.000Z",
      updatedAt: "2026-04-21T00:00:01.000Z",
    });

    await recoverKanbanTasks({
      store,
      repoId: "repo-1",
      adapters: {
        pi: {
          kind: "pi",
          openSession: vi.fn(),
          resumeSession: vi.fn(async () => ({
            sessionRef: "chat:child-b",
            attached: true,
            resumable: true,
          })),
          sendPrompt: vi.fn(),
          interrupt: vi.fn(),
          closeSession: vi.fn(),
          getSessionStatus: vi.fn(async () => ({
            status: "running",
            resumable: true,
          })),
          streamEvents: vi.fn(async function* () {}),
        },
      },
      now: () => "2026-04-21T00:00:02.000Z",
    });

    expect(store.getTask("task-2")).toMatchObject({
      runtimeState: "running",
      updatedAt: "2026-04-21T00:00:02.000Z",
      summary: "session resumed",
    });
    expect(store.listTaskEvents("task-2").at(-1)).toEqual({
      eventId: "recovery:task-2:2026-04-21T00:00:02.000Z",
      taskId: "task-2",
      eventType: "recovery-resumed",
      payload: {
        adapterType: "pi",
        sessionRef: "chat:child-b",
      },
      ts: "2026-04-21T00:00:02.000Z",
    });
  });
});
