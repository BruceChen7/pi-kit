import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { KanbanOrchestratorService } from "./service.js";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-kit-orchestrator-service-"),
  );
  tempDirs.push(dir);
  return dir;
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
