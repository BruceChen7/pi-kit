import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { KanbanOrchestratorService } from "../extensions/kanban-orchestrator/service.js";
import { createKanbanDaemon } from "./daemon.js";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-kanban-daemon-"));
  tempDirs.push(dir);
  return dir;
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number = 1000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error("timed out waiting for condition");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("createKanbanDaemon", () => {
  it("refreshes service runtime state from recovered daemon store before serving requests", async () => {
    const dir = createTempDir();
    const repoRoot = "/tmp/repo-recovery-refresh";
    const service = new KanbanOrchestratorService({
      repoRoot,
      boardPath: "workitems/features.kanban.md",
      defaultAdapter: "pi",
      localStatePath: path.join(dir, "kanban-state.sqlite"),
      auditLogPath: path.join(dir, "execution.log.jsonl"),
      actionExecutors: {},
    });
    const recovery = service.getRecoveryContext();
    if (!recovery) {
      throw new Error("missing recovery context");
    }
    recovery.store.upsertTask({
      taskId: "task-recovery-refresh",
      repoId: repoRoot,
      cardId: "child-recovery-refresh",
      intentType: "start-child",
      runtimeState: "running",
      conflict: false,
      attempt: 1,
      createdAt: "2026-04-21T00:00:00.000Z",
      updatedAt: "2026-04-21T00:00:01.000Z",
      request: {
        action: "apply",
        worktreeKey: "wt-child-recovery-refresh",
        startedAt: "2026-04-21T00:00:01.000Z",
      },
      summary: "running",
    });

    const daemon = createKanbanDaemon({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      workspaceId: "workspace-kanban-drive",
      service,
      adapters: {},
      recover: vi.fn(async ({ store }) => {
        const task = store.getTask("task-recovery-refresh");
        if (!task) {
          throw new Error("missing task");
        }
        store.upsertTask({
          ...task,
          runtimeState: "recoverable-failed",
          updatedAt: "2026-04-21T00:00:02.000Z",
          summary: "session could not be resumed",
          request: {
            ...task.request,
            finishedAt: "2026-04-21T00:00:02.000Z",
          },
        });
      }),
      resolveContext: () => ({
        ok: true,
        context: {
          cardId: "child-recovery-refresh",
          lane: "In Progress",
          branch: "child-recovery-refresh",
          worktreePath: "wt-child-recovery-refresh",
          session: null,
        },
      }),
      applyBoardPatch: () => ({
        ok: false,
        error: "unused",
      }),
      readBoard: () => ({
        path: "workitems/features.kanban.md",
        lanes: [],
        cards: [],
        errors: [],
      }),
    });

    await daemon.start();

    expect(daemon.getCardRuntime("child-recovery-refresh")).toEqual({
      status: 200,
      body: expect.objectContaining({
        execution: expect.objectContaining({
          status: "recoverable-failed",
          summary: "session could not be resumed",
          requestId: "task-recovery-refresh",
        }),
      }),
    });

    await daemon.stop();
  });

  it("runs recovery before serving requests when adapters are configured", async () => {
    const dir = createTempDir();
    const service = new KanbanOrchestratorService({
      repoRoot: "/tmp/repo-1",
      boardPath: "workitems/features.kanban.md",
      defaultAdapter: "pi",
      localStatePath: path.join(dir, "kanban-state.sqlite"),
      auditLogPath: path.join(dir, "execution.log.jsonl"),
      actionExecutors: {},
    });
    const recover = vi.fn(async () => {});
    const daemon = createKanbanDaemon({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      workspaceId: "workspace-kanban-drive",
      service,
      adapters: {},
      recover,
      resolveContext: () => ({
        ok: false,
        error: "unused",
      }),
      applyBoardPatch: () => ({
        ok: false,
        error: "unused",
      }),
      readBoard: () => ({
        path: "workitems/features.kanban.md",
        lanes: [],
        cards: [],
        errors: [],
      }),
    });

    await daemon.start();

    expect(recover).toHaveBeenCalledTimes(1);
    expect(recover).toHaveBeenCalledWith({
      store: expect.anything(),
      repoId: "/tmp/repo-1",
      adapters: {},
    });

    await daemon.stop();
  });

  it("cancels an active task and interrupts the adapter session when available", async () => {
    const dir = createTempDir();
    const repoRoot = "/tmp/repo-cancel";
    const interrupt = vi.fn(async () => {});
    const service = new KanbanOrchestratorService({
      repoRoot,
      boardPath: "workitems/features.kanban.md",
      defaultAdapter: "pi",
      localStatePath: path.join(dir, "kanban-state.sqlite"),
      auditLogPath: path.join(dir, "execution.log.jsonl"),
      actionExecutors: {},
    });
    const recovery = service.getRecoveryContext();
    if (!recovery) {
      throw new Error("missing recovery context");
    }
    recovery.store.upsertTask({
      taskId: "task-cancel-1",
      repoId: repoRoot,
      cardId: "child-cancel",
      intentType: "open-session",
      runtimeState: "running",
      conflict: false,
      attempt: 1,
      createdAt: "2026-04-21T00:00:00.000Z",
      updatedAt: "2026-04-21T00:00:01.000Z",
      request: {
        action: "open-session",
        worktreeKey: "wt-child-cancel",
        startedAt: "2026-04-21T00:00:01.000Z",
      },
      summary: "running",
    });
    recovery.store.upsertSession({
      sessionId: "session-cancel-1",
      taskId: "task-cancel-1",
      adapterType: "pi",
      adapterSessionRef: "chat:child-cancel",
      repoPath: repoRoot,
      worktreePath: "wt-child-cancel",
      status: "running",
      resumable: true,
      lastEventAt: "2026-04-21T00:00:01.000Z",
      createdAt: "2026-04-21T00:00:01.000Z",
      updatedAt: "2026-04-21T00:00:01.000Z",
    });
    service.refreshPersistedRuntimeStates();

    const daemon = createKanbanDaemon({
      host: "127.0.0.1",
      port: 0,
      token: "",
      workspaceId: "workspace-kanban-drive",
      service,
      adapters: {
        pi: {
          kind: "pi",
          openSession: vi.fn(),
          resumeSession: vi.fn(async () => ({
            sessionRef: "chat:child-cancel",
            attached: true,
            resumable: true,
          })),
          sendPrompt: vi.fn(),
          interrupt,
          closeSession: vi.fn(),
          getSessionStatus: vi.fn(async () => ({
            status: "running",
            resumable: true,
          })),
          streamEvents: vi.fn(async function* () {}),
        },
      },
      recover: vi.fn(async () => {}),
      resolveContext: () => ({
        ok: true,
        context: {
          cardId: "child-cancel",
          lane: "In Progress",
          branch: "child-cancel",
          worktreePath: "wt-child-cancel",
          session: null,
        },
      }),
      applyBoardPatch: () => ({ ok: true, summary: "board updated" }),
      readBoard: () => ({
        path: "workitems/features.kanban.md",
        lanes: [],
        cards: [{ id: "child-cancel", lane: "In Progress" }],
        errors: [],
      }),
    });

    await daemon.start();

    const cancelled = await daemon.cancelAction("task-cancel-1");
    expect(cancelled).toEqual({
      status: 200,
      body: expect.objectContaining({
        requestId: "task-cancel-1",
        status: "cancelled",
      }),
    });
    expect(interrupt).toHaveBeenCalledWith("chat:child-cancel");
    expect(daemon.getCardRuntime("child-cancel")).toEqual({
      status: 200,
      body: expect.objectContaining({
        execution: expect.objectContaining({
          status: "cancelled",
          requestId: "task-cancel-1",
        }),
      }),
    });
    expect(recovery.store.getTask("task-cancel-1")).toMatchObject({
      runtimeState: "cancelled",
    });

    await daemon.stop();
  });

  it("still cancels locally when adapter interrupt is unavailable", async () => {
    const dir = createTempDir();
    const repoRoot = "/tmp/repo-cancel-fallback";
    const service = new KanbanOrchestratorService({
      repoRoot,
      boardPath: "workitems/features.kanban.md",
      defaultAdapter: "pi",
      localStatePath: path.join(dir, "kanban-state.sqlite"),
      auditLogPath: path.join(dir, "execution.log.jsonl"),
      actionExecutors: {},
    });
    const recovery = service.getRecoveryContext();
    if (!recovery) {
      throw new Error("missing recovery context");
    }
    recovery.store.upsertTask({
      taskId: "task-cancel-2",
      repoId: repoRoot,
      cardId: "child-cancel-fallback",
      intentType: "open-session",
      runtimeState: "running",
      conflict: false,
      attempt: 1,
      createdAt: "2026-04-21T00:00:00.000Z",
      updatedAt: "2026-04-21T00:00:01.000Z",
      request: {
        action: "open-session",
        worktreeKey: "wt-child-cancel-fallback",
        startedAt: "2026-04-21T00:00:01.000Z",
      },
      summary: "running",
    });
    recovery.store.upsertSession({
      sessionId: "session-cancel-2",
      taskId: "task-cancel-2",
      adapterType: "pi",
      adapterSessionRef: "chat:child-cancel-fallback",
      repoPath: repoRoot,
      worktreePath: "wt-child-cancel-fallback",
      status: "running",
      resumable: true,
      lastEventAt: "2026-04-21T00:00:01.000Z",
      createdAt: "2026-04-21T00:00:01.000Z",
      updatedAt: "2026-04-21T00:00:01.000Z",
    });
    service.refreshPersistedRuntimeStates();

    const daemon = createKanbanDaemon({
      host: "127.0.0.1",
      port: 0,
      token: "",
      workspaceId: "workspace-kanban-drive",
      service,
      adapters: {
        pi: {
          kind: "pi",
          openSession: vi.fn(),
          resumeSession: vi.fn(async () => ({
            sessionRef: "chat:child-cancel-fallback",
            attached: true,
            resumable: true,
          })),
          sendPrompt: vi.fn(),
          interrupt: vi.fn(async () => {
            throw new Error("interrupt unavailable");
          }),
          closeSession: vi.fn(),
          getSessionStatus: vi.fn(async () => ({
            status: "running",
            resumable: true,
          })),
          streamEvents: vi.fn(async function* () {}),
        },
      },
      recover: vi.fn(async () => {}),
      resolveContext: () => ({
        ok: true,
        context: {
          cardId: "child-cancel-fallback",
          lane: "In Progress",
          branch: "child-cancel-fallback",
          worktreePath: "wt-child-cancel-fallback",
          session: null,
        },
      }),
      applyBoardPatch: () => ({ ok: true, summary: "board updated" }),
      readBoard: () => ({
        path: "workitems/features.kanban.md",
        lanes: [],
        cards: [{ id: "child-cancel-fallback", lane: "In Progress" }],
        errors: [],
      }),
    });

    await daemon.start();

    const cancelled = await daemon.cancelAction("task-cancel-2");
    expect(cancelled).toEqual({
      status: 200,
      body: expect.objectContaining({
        requestId: "task-cancel-2",
        status: "cancelled",
      }),
    });

    await daemon.stop();
  });

  it("identifies whether a worktree path belongs to an active child runtime", () => {
    const daemon = createKanbanDaemon({
      host: "127.0.0.1",
      port: 0,
      token: "",
      workspaceId: "workspace-kanban-drive",
      service: new KanbanOrchestratorService({
        auditLogPath: "/tmp/unused.log",
        actionExecutors: {},
      }),
      resolveContext: () => ({ ok: false, error: "unused" }),
      resolveContextByWorktreePath: (worktreePath) => {
        if (worktreePath === "/tmp/wt/child-running") {
          return {
            ok: true,
            context: {
              cardId: "child-running",
              lane: "In Progress",
              kind: "child",
              title: "Child Running",
              parentCardId: null,
              branch: "child-running",
              baseBranch: "main",
              mergeTarget: "main",
              worktreePath,
              session: null,
            },
          };
        }

        if (worktreePath === "/tmp/wt/child-done") {
          return {
            ok: true,
            context: {
              cardId: "child-done",
              lane: "Done",
              kind: "child",
              title: "Child Done",
              parentCardId: null,
              branch: "child-done",
              baseBranch: "main",
              mergeTarget: "main",
              worktreePath,
              session: null,
            },
          };
        }

        return {
          ok: false,
          error: "unknown worktree",
        };
      },
      applyBoardPatch: () => ({ ok: false, error: "unused" }),
      readBoard: () => ({
        path: "workitems/features.kanban.md",
        lanes: [],
        cards: [],
        errors: [],
      }),
    });

    expect(daemon.acceptsRuntimeWorktree("/tmp/wt/child-running")).toBe(true);
    expect(daemon.acceptsRuntimeWorktree("/tmp/wt/child-done")).toBe(false);
    expect(daemon.acceptsRuntimeWorktree("/tmp/wt/unknown")).toBe(false);
  });

  it("handles product actions through daemon control-plane methods", async () => {
    const dir = createTempDir();
    const service = new KanbanOrchestratorService({
      repoRoot: "/tmp/repo-2",
      boardPath: "workitems/features.kanban.md",
      defaultAdapter: "pi",
      localStatePath: path.join(dir, "kanban-state.sqlite"),
      auditLogPath: path.join(dir, "execution.log.jsonl"),
      createRequestId: () => "req-daemon-1",
      now: () => "2026-04-21T00:00:00.000Z",
      actionExecutors: {
        apply: async () => ({ summary: "applied" }),
      },
    });
    const daemon = createKanbanDaemon({
      host: "127.0.0.1",
      port: 0,
      token: "",
      workspaceId: "workspace-kanban-drive",
      service,
      adapters: {},
      recover: vi.fn(async () => {}),
      resolveContext: () => ({
        ok: true,
        context: {
          cardId: "feat-checkout-v2",
          worktreePath: "/tmp/wt/main--feat-checkout-v2",
          branch: "main--feat-checkout-v2",
        },
      }),
      applyBoardPatch: () => ({ ok: true, summary: "board updated" }),
      readBoard: () => ({
        path: "workitems/features.kanban.md",
        lanes: [],
        cards: [],
        errors: [],
      }),
    });

    const execute = daemon.executeAction({
      action: "apply",
      cardId: "feat-checkout-v2",
    });
    expect(execute).toEqual({
      status: 202,
      body: {
        requestId: "req-daemon-1",
        status: "queued",
      },
    });

    await service.waitFor("req-daemon-1");

    expect(daemon.getActionStatus("req-daemon-1")).toEqual({
      status: 200,
      body: expect.objectContaining({
        requestId: "req-daemon-1",
        status: "success",
      }),
    });
    expect(daemon.getCardContext("feat-checkout-v2")).toEqual({
      status: 200,
      body: expect.objectContaining({
        cardId: "feat-checkout-v2",
      }),
    });
    expect(daemon.readBoard()).toEqual({
      status: 200,
      body: {
        path: "workitems/features.kanban.md",
        lanes: [],
        cards: [],
        errors: [],
      },
    });
    expect(daemon.patchBoard("next board text")).toEqual({
      status: 200,
      body: {
        summary: "board updated",
      },
    });
  });

  it("marks runtime conflict when board intent diverges from an active task", async () => {
    const dir = createTempDir();
    const repoRoot = "/tmp/repo-conflict";
    const boardPath = path.join(dir, "features.kanban.md");
    fs.writeFileSync(boardPath, "initial board\n", "utf-8");

    let lane: "In Progress" | "Done" = "In Progress";
    const service = new KanbanOrchestratorService({
      repoRoot,
      boardPath: "workitems/features.kanban.md",
      defaultAdapter: "pi",
      localStatePath: path.join(dir, "kanban-state.sqlite"),
      auditLogPath: path.join(dir, "execution.log.jsonl"),
      actionExecutors: {},
    });
    const recovery = service.getRecoveryContext();
    if (!recovery) {
      throw new Error("missing recovery context");
    }
    recovery.store.upsertTask({
      taskId: "task-conflict-1",
      repoId: repoRoot,
      cardId: "child-conflict",
      intentType: "start-child",
      runtimeState: "running",
      conflict: false,
      attempt: 1,
      createdAt: "2026-04-21T00:00:00.000Z",
      updatedAt: "2026-04-21T00:00:01.000Z",
      request: {
        action: "open-session",
        worktreeKey: "wt-child-conflict",
        startedAt: "2026-04-21T00:00:01.000Z",
      },
      summary: "running",
    });
    service.refreshPersistedRuntimeStates();

    const daemon = createKanbanDaemon({
      host: "127.0.0.1",
      port: 0,
      token: "",
      workspaceId: "workspace-kanban-drive",
      service,
      boardPath,
      adapters: {},
      recover: vi.fn(async () => {}),
      resolveContext: () => ({
        ok: true,
        context: {
          cardId: "child-conflict",
          lane,
          branch: "child-conflict",
          worktreePath: "wt-child-conflict",
          session: null,
        },
      }),
      applyBoardPatch: (nextBoardText) => {
        fs.writeFileSync(boardPath, nextBoardText, "utf-8");
        lane = nextBoardText.includes("Done") ? "Done" : "In Progress";
        return { ok: true, summary: "board updated" };
      },
      readBoard: () => ({
        path: boardPath,
        lanes: [],
        cards: [{ id: "child-conflict", lane }],
        errors: [],
      }),
    });

    await daemon.start();
    expect(daemon.getCardRuntime("child-conflict")).toEqual({
      status: 200,
      body: expect.objectContaining({
        execution: expect.objectContaining({
          status: "running",
        }),
        conflict: false,
      }),
    });

    fs.writeFileSync(boardPath, "move to Done\n", "utf-8");
    lane = "Done";
    await waitUntil(() => service.getCardRuntime("child-conflict").conflict);

    expect(daemon.getCardRuntime("child-conflict")).toEqual({
      status: 200,
      body: expect.objectContaining({
        execution: expect.objectContaining({
          status: "running",
        }),
        conflict: true,
      }),
    });

    await daemon.stop();
  });

  it("keeps a daemon-owned board snapshot fresh across file changes and patches", async () => {
    const dir = createTempDir();
    const boardPath = path.join(dir, "features.kanban.md");
    fs.writeFileSync(boardPath, "initial board\n", "utf-8");

    let readCount = 0;
    const daemon = createKanbanDaemon({
      host: "127.0.0.1",
      port: 0,
      token: "",
      workspaceId: "workspace-kanban-drive",
      service: new KanbanOrchestratorService({
        auditLogPath: path.join(dir, "execution.log.jsonl"),
        actionExecutors: {},
      }),
      boardPath,
      adapters: {},
      recover: vi.fn(async () => {}),
      resolveContext: () => ({ ok: false, error: "unused" }),
      applyBoardPatch: (nextBoardText) => {
        fs.writeFileSync(boardPath, nextBoardText, "utf-8");
        return { ok: true, summary: "board updated" };
      },
      readBoard: () => {
        readCount += 1;
        return {
          path: boardPath,
          lanes: [],
          cards: [fs.readFileSync(boardPath, "utf-8").trim()],
          errors: [],
        };
      },
    });

    await daemon.start();
    expect(readCount).toBe(1);
    expect(daemon.readBoard()).toEqual({
      status: 200,
      body: {
        path: boardPath,
        lanes: [],
        cards: ["initial board"],
        errors: [],
      },
    });
    expect(readCount).toBe(1);

    fs.writeFileSync(boardPath, "external update\n", "utf-8");
    await waitUntil(() => readCount >= 2);

    expect(readCount).toBeGreaterThanOrEqual(2);
    expect(daemon.readBoard()).toEqual({
      status: 200,
      body: {
        path: boardPath,
        lanes: [],
        cards: ["external update"],
        errors: [],
      },
    });
    expect(readCount).toBeGreaterThanOrEqual(2);

    expect(daemon.patchBoard("patched board\n")).toEqual({
      status: 200,
      body: {
        summary: "board updated",
      },
    });
    expect(readCount).toBeGreaterThanOrEqual(3);
    expect(daemon.readBoard()).toEqual({
      status: 200,
      body: {
        path: boardPath,
        lanes: [],
        cards: ["patched board"],
        errors: [],
      },
    });
    expect(readCount).toBeGreaterThanOrEqual(3);

    await daemon.stop();
  });

  it("serves the existing /kanban bootstrap surface through the daemon wrapper", async () => {
    const dir = createTempDir();
    const service = new KanbanOrchestratorService({
      auditLogPath: path.join(dir, "execution.log.jsonl"),
      actionExecutors: {},
    });
    const daemon = createKanbanDaemon({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      workspaceId: "workspace-kanban-drive",
      service,
      resolveContext: () => ({
        ok: false,
        error: "unused",
      }),
      applyBoardPatch: () => ({
        ok: false,
        error: "unused",
      }),
      readBoard: () => ({
        path: "workitems/features.kanban.md",
        lanes: [],
        cards: [],
        errors: [],
      }),
    });

    await daemon.start();

    const response = await fetch(`${daemon.baseUrl}/kanban/bootstrap`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
      },
    });
    const payload = (await response.json()) as {
      status: string;
      workspaceId: string;
    };

    expect(response.status).toBe(200);
    expect(payload).toEqual({
      status: "ready",
      workspaceId: "workspace-kanban-drive",
      sessionId: "workspace:workspace-kanban-drive",
      capabilities: {
        stream: true,
        actions: true,
      },
    });

    await daemon.stop();
  });
});
