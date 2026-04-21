import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { KanbanOrchestratorService } from "./service.js";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-kit-orchestrator-persist-"),
  );
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("KanbanOrchestratorService persistence", () => {
  it("restores daemon runtime states beyond success and failure on restart", () => {
    const dir = createTempDir();
    const dbPath = path.join(dir, "kanban-state.sqlite");
    const auditLogPath = path.join(dir, "execution.log.jsonl");

    const seeded = new KanbanOrchestratorService({
      repoRoot: "/tmp/repo-runtime-restore",
      boardPath: "workitems/features.kanban.md",
      defaultAdapter: "pi",
      localStatePath: dbPath,
      auditLogPath,
      actionExecutors: {},
    });
    const recovery = seeded.getRecoveryContext();
    if (!recovery) {
      throw new Error("missing recovery context");
    }
    recovery.store.upsertTask({
      taskId: "req-recoverable-1",
      repoId: "/tmp/repo-runtime-restore",
      cardId: "child-runtime-restore",
      intentType: "start-child",
      runtimeState: "recoverable-failed",
      conflict: false,
      attempt: 1,
      createdAt: "2026-04-21T00:00:00.000Z",
      updatedAt: "2026-04-21T00:00:02.000Z",
      request: {
        action: "apply",
        worktreeKey:
          "/tmp/repo-runtime-restore/.worktrees/child-runtime-restore",
        startedAt: "2026-04-21T00:00:01.000Z",
        finishedAt: "2026-04-21T00:00:02.000Z",
      },
      summary: "reattach required",
    });

    const restored = new KanbanOrchestratorService({
      repoRoot: "/tmp/repo-runtime-restore",
      boardPath: "workitems/features.kanban.md",
      defaultAdapter: "pi",
      localStatePath: dbPath,
      auditLogPath,
      actionExecutors: {},
    });

    expect(restored.getCardRuntime("child-runtime-restore")).toEqual({
      cardId: "child-runtime-restore",
      status: "recoverable-failed",
      summary: "reattach required",
      requestId: "req-recoverable-1",
      startedAt: "2026-04-21T00:00:01.000Z",
      completedAt: "2026-04-21T00:00:02.000Z",
      terminalAvailable: false,
      terminalChunks: [],
      terminalProtocol: "sse-text-stream",
      conflict: false,
    });
  });

  it("restores persisted action state and card runtime after restart", async () => {
    const dir = createTempDir();
    const dbPath = path.join(dir, "kanban-state.sqlite");
    const auditLogPath = path.join(dir, "execution.log.jsonl");
    const nowValues = [
      "2026-04-21T00:00:00.000Z",
      "2026-04-21T00:00:01.000Z",
      "2026-04-21T00:00:02.000Z",
    ];

    const first = new KanbanOrchestratorService({
      repoRoot: "/tmp/repo-1",
      boardPath: "workitems/features.kanban.md",
      defaultAdapter: "pi",
      localStatePath: dbPath,
      auditLogPath,
      createRequestId: () => "req-persist-1",
      now: () => nowValues.shift() ?? "2026-04-21T00:00:02.000Z",
      actionExecutors: {
        apply: async () => ({
          summary: "applied",
          chatJid: "chat:child-pricing-widget",
          worktreePath: "/tmp/repo-1/.worktrees/child-pricing-widget",
        }),
      },
    });

    const requestId = first.enqueueAction({
      action: "apply",
      cardId: "child-pricing-widget",
      worktreeKey: "/tmp/repo-1/.worktrees/child-pricing-widget",
    });
    await first.waitFor(requestId);

    const second = new KanbanOrchestratorService({
      repoRoot: "/tmp/repo-1",
      boardPath: "workitems/features.kanban.md",
      defaultAdapter: "pi",
      localStatePath: dbPath,
      auditLogPath,
      actionExecutors: {},
    });

    expect(second.getState("req-persist-1")).toMatchObject({
      requestId: "req-persist-1",
      action: "apply",
      cardId: "child-pricing-widget",
      worktreeKey: "/tmp/repo-1/.worktrees/child-pricing-widget",
      status: "success",
      summary: "applied",
      startedAt: "2026-04-21T00:00:01.000Z",
      finishedAt: "2026-04-21T00:00:02.000Z",
    });
    expect(second.getCardRuntime("child-pricing-widget")).toEqual({
      cardId: "child-pricing-widget",
      status: "completed",
      summary: "applied",
      requestId: "req-persist-1",
      startedAt: "2026-04-21T00:00:01.000Z",
      completedAt: "2026-04-21T00:00:02.000Z",
      terminalAvailable: false,
      terminalChunks: [],
      terminalProtocol: "sse-text-stream",
      conflict: false,
    });
  });
});
