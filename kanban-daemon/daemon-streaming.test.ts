import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { KanbanOrchestratorService } from "../extensions/kanban-orchestrator/service.js";
import { createKanbanDaemon } from "./daemon.js";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-kit-kanban-daemon-streaming-"),
  );
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("createKanbanDaemon session streaming", () => {
  it("consumes adapter session streams after a session-backed action succeeds", async () => {
    const dir = createTempDir();
    const dbPath = path.join(dir, "kanban-state.sqlite");
    const service = new KanbanOrchestratorService({
      repoRoot: "/tmp/repo-1",
      boardPath: "workitems/features.kanban.md",
      defaultAdapter: "pi",
      localStatePath: dbPath,
      auditLogPath: path.join(dir, "execution.log.jsonl"),
      createRequestId: () => "task-stream-1",
      actionExecutors: {
        "open-session": async () => ({
          summary: "opened",
          chatJid: "chat:child-a",
          worktreePath: "/tmp/repo-1/.worktrees/child-a",
          adapterType: "pi",
        }),
      },
    });

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
            sessionRef: "chat:child-a",
            attached: false,
            resumable: false,
          })),
          sendPrompt: vi.fn(),
          interrupt: vi.fn(),
          closeSession: vi.fn(),
          getSessionStatus: vi.fn(async () => ({
            status: "unknown",
            resumable: false,
          })),
          streamEvents: vi.fn(async function* () {
            yield { type: "session-opened", sessionRef: "chat:child-a" };
            yield { type: "agent-started", sessionRef: "chat:child-a" };
            yield {
              type: "output-delta",
              sessionRef: "chat:child-a",
              chunk: "hello world",
            };
            yield {
              type: "agent-completed",
              sessionRef: "chat:child-a",
              summary: "done",
            };
          }),
        },
      },
      recover: vi.fn(async () => {}),
      resolveContext: () => ({ ok: false, error: "unused" }),
      applyBoardPatch: () => ({ ok: false, error: "unused" }),
      readBoard: () => ({
        path: "workitems/features.kanban.md",
        lanes: [],
        cards: [],
        errors: [],
      }),
    });

    await daemon.start();

    const requestId = service.enqueueAction({
      action: "open-session",
      cardId: "child-a",
      worktreeKey: "wt-child-a",
    });
    await service.waitFor(requestId);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(service.getCardRuntime("child-a")).toEqual({
      cardId: "child-a",
      status: "completed",
      summary: "done",
      requestId: "task-stream-1",
      startedAt: expect.any(String),
      completedAt: expect.any(String),
      terminalAvailable: true,
      terminalChunks: ["hello world"],
      terminalProtocol: "sse-text-stream",
      conflict: false,
    });

    await daemon.stop();
  });
});
