import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { KanbanOrchestratorService } from "./service.js";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-kit-orchestrator-service-"),
  );
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

describe("KanbanOrchestratorService", () => {
  it("runs a whitelisted action and persists success audit logs", async () => {
    const dir = createTempDir();
    const logPath = path.join(dir, "execution.log.jsonl");

    const service = new KanbanOrchestratorService({
      auditLogPath: logPath,
      createRequestId: () => "req-1",
      now: () => "2026-04-20T00:00:00.000Z",
      actionExecutors: {
        apply: async () => ({ summary: "applied" }),
      },
    });

    const requestId = service.enqueueAction({
      action: "apply",
      cardId: "feat-checkout-v2",
      worktreeKey: "main--feat-checkout-v2",
    });

    expect(requestId).toBe("req-1");

    const completed = await service.waitFor(requestId);
    expect(completed.status).toBe("success");
    expect(completed.summary).toBe("applied");

    const lines = fs.readFileSync(logPath, "utf-8").trim().split(/\r?\n/);
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]) as { requestId: string; status: string };
    expect(entry).toMatchObject({
      requestId: "req-1",
      status: "success",
    });
  });

  it("updates session registry when executor returns session metadata", async () => {
    const dir = createTempDir();
    const logPath = path.join(dir, "execution.log.jsonl");
    const sessionRegistryPath = path.join(dir, "session-registry.json");

    const service = new KanbanOrchestratorService({
      auditLogPath: logPath,
      sessionRegistryPath,
      createRequestId: () => "req-2",
      now: () => "2026-04-20T00:00:00.000Z",
      actionExecutors: {
        "open-session": async () => ({
          summary: "opened",
          chatJid: "chat:feat-checkout-v2",
          worktreePath: "/tmp/wt/main--feat-checkout-v2",
        }),
      },
    });

    const requestId = service.enqueueAction({
      action: "open-session",
      cardId: "feat-checkout-v2",
      worktreeKey: "main--feat-checkout-v2",
    });
    await service.waitFor(requestId);

    const registry = JSON.parse(
      fs.readFileSync(sessionRegistryPath, "utf-8"),
    ) as {
      cards: Record<string, { chatJid: string; worktreePath: string }>;
    };
    expect(registry.cards["feat-checkout-v2"]).toEqual({
      chatJid: "chat:feat-checkout-v2",
      worktreePath: "/tmp/wt/main--feat-checkout-v2",
      lastActiveAt: "2026-04-20T00:00:00.000Z",
    });
  });

  it("publishes state-change events for queued/running/success", async () => {
    const dir = createTempDir();
    const service = new KanbanOrchestratorService({
      auditLogPath: path.join(dir, "execution.log.jsonl"),
      createRequestId: () => "req-3",
      now: () => "2026-04-20T00:00:00.000Z",
      actionExecutors: {
        apply: async () => ({ summary: "ok" }),
      },
    });

    const statuses: string[] = [];
    const unsubscribe = service.subscribe((event) => {
      statuses.push(event.status);
    });

    const requestId = service.enqueueAction({
      action: "apply",
      cardId: "feat-checkout-v2",
      worktreeKey: "main--feat-checkout-v2",
    });

    await service.waitFor(requestId);
    unsubscribe();

    expect(statuses).toEqual(["queued", "running", "success"]);
  });

  it("starts the configured session stream handler after a session-backed success", async () => {
    const dir = createTempDir();
    const handler = vi.fn(async () => {});
    const service = new KanbanOrchestratorService({
      auditLogPath: path.join(dir, "execution.log.jsonl"),
      createRequestId: () => "req-stream-1",
      now: () => "2026-04-20T00:00:00.000Z",
      actionExecutors: {
        "open-session": async () => ({
          summary: "opened",
          chatJid: "chat:feat-checkout-v2",
          worktreePath: "/tmp/wt/main--feat-checkout-v2",
          adapterType: "pi",
        }),
      },
    });
    service.setSessionStreamHandler(handler);

    const requestId = service.enqueueAction({
      action: "open-session",
      cardId: "feat-checkout-v2",
      worktreeKey: "main--feat-checkout-v2",
    });
    await service.waitFor(requestId);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({
      taskId: "req-stream-1",
      cardId: "feat-checkout-v2",
      sessionRef: "chat:feat-checkout-v2",
      adapterType: "pi",
      worktreePath: "/tmp/wt/main--feat-checkout-v2",
    });
  });

  it("persists preparing and opening-session runtime transitions before session start completes", async () => {
    const dir = createTempDir();
    const dbPath = path.join(dir, "kanban-state.sqlite");
    const nowValues = [
      "2026-04-20T00:00:00.000Z",
      "2026-04-20T00:00:01.000Z",
      "2026-04-20T00:00:02.000Z",
      "2026-04-20T00:00:03.000Z",
      "2026-04-20T00:00:04.000Z",
    ];

    let finishExecution: (() => void) | null = null;
    const service = new KanbanOrchestratorService({
      repoRoot: "/tmp/repo-runtime-progress",
      boardPath: "workitems/features.kanban.md",
      defaultAdapter: "pi",
      localStatePath: dbPath,
      auditLogPath: path.join(dir, "execution.log.jsonl"),
      createRequestId: () => "req-progress-1",
      now: () => nowValues.shift() ?? "2026-04-20T00:00:04.000Z",
      actionExecutors: {
        "open-session": ({ reportRuntimeStatus }) =>
          new Promise((resolve) => {
            reportRuntimeStatus?.({
              status: "preparing",
              summary: "preparing session context",
            });
            reportRuntimeStatus?.({
              status: "opening-session",
              summary: "opening session",
            });
            finishExecution = () => {
              resolve({
                summary: "opened",
                chatJid: "chat:feat-checkout-v2",
                worktreePath: "/tmp/wt/main--feat-checkout-v2",
                adapterType: "pi",
              });
            };
          }),
      },
    });
    const recovery = service.getRecoveryContext();
    if (!recovery) {
      throw new Error("missing recovery context");
    }

    const requestId = service.enqueueAction({
      action: "open-session",
      cardId: "feat-checkout-v2",
      worktreeKey: "main--feat-checkout-v2",
    });

    await waitUntil(
      () =>
        recovery.store.getTask(requestId)?.runtimeState === "opening-session",
    );
    expect(service.getCardRuntime("feat-checkout-v2")).toEqual({
      cardId: "feat-checkout-v2",
      status: "opening-session",
      summary: "opening session",
      requestId: "req-progress-1",
      startedAt: "2026-04-20T00:00:01.000Z",
      completedAt: null,
      terminalAvailable: false,
      terminalChunks: [],
      terminalProtocol: "sse-text-stream",
      conflict: false,
    });
    expect(recovery.store.getTask(requestId)).toMatchObject({
      runtimeState: "opening-session",
      summary: "opening session",
      updatedAt: "2026-04-20T00:00:03.000Z",
    });

    finishExecution?.();
    const completed = await service.waitFor(requestId);
    expect(completed.status).toBe("success");
  });

  it("keeps a request cancelled even if the underlying executor resolves later", async () => {
    const dir = createTempDir();
    let finishExecution: (() => void) | null = null;
    const service = new KanbanOrchestratorService({
      auditLogPath: path.join(dir, "execution.log.jsonl"),
      createRequestId: () => "req-cancel-1",
      now: (() => {
        const values = [
          "2026-04-20T00:00:00.000Z",
          "2026-04-20T00:00:01.000Z",
          "2026-04-20T00:00:02.000Z",
        ];
        return () => values.shift() ?? "2026-04-20T00:00:02.000Z";
      })(),
      actionExecutors: {
        "open-session": () =>
          new Promise((resolve) => {
            finishExecution = () => {
              resolve({
                summary: "opened",
                chatJid: "chat:feat-checkout-v2",
                worktreePath: "/tmp/wt/main--feat-checkout-v2",
                adapterType: "pi",
              });
            };
          }),
      },
    });

    const requestId = service.enqueueAction({
      action: "open-session",
      cardId: "feat-checkout-v2",
      worktreeKey: "main--feat-checkout-v2",
    });
    await waitUntil(() => service.getState(requestId)?.status === "running");

    const cancelled = service.cancelAction(requestId);
    expect(cancelled).toMatchObject({
      requestId: "req-cancel-1",
      status: "cancelled",
      summary: "cancelled",
    });
    expect(service.getCardRuntime("feat-checkout-v2")).toMatchObject({
      status: "cancelled",
      summary: "cancelled",
    });

    finishExecution?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(service.getState(requestId)).toMatchObject({
      status: "cancelled",
      summary: "cancelled",
    });
  });

  it("rejects non-whitelisted actions", () => {
    const service = new KanbanOrchestratorService({
      auditLogPath: "/tmp/unused.log",
      createRequestId: () => "req-x",
      now: () => "2026-04-20T00:00:00.000Z",
      actionExecutors: {},
    });

    expect(() => {
      service.enqueueAction({
        action: "feature-start",
        cardId: "feat-checkout-v2",
        worktreeKey: "main--feat-checkout-v2",
      });
    }).toThrow(/unsupported action/i);
  });
});
