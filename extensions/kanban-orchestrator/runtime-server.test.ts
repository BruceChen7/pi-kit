import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createKanbanRuntimeServer } from "./runtime-server.js";
import { KanbanOrchestratorService } from "./service.js";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-runtime-server-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("createKanbanRuntimeServer", () => {
  it("serves execute/status/context/board endpoints with token auth", async () => {
    const dir = createTempDir();
    const service = new KanbanOrchestratorService({
      auditLogPath: path.join(dir, "execution.log.jsonl"),
      createRequestId: () => "req-http-1",
      now: () => "2026-04-20T00:00:00.000Z",
      actionExecutors: {
        apply: async () => ({ summary: "applied" }),
      },
    });

    const server = createKanbanRuntimeServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      service,
      resolveContext: () => ({
        ok: true,
        context: {
          cardId: "feat-checkout-v2",
          title: "Checkout V2",
          kind: "feature",
          lane: "Spec",
          parentCardId: null,
          branch: "main--feat-checkout-v2",
          baseBranch: "main",
          mergeTarget: "main",
          worktreePath: "/tmp/wt/main--feat-checkout-v2",
          session: null,
        },
      }),
      applyBoardPatch: () => ({ ok: true, summary: "board updated" }),
      readBoard: () => ({
        path: "workitems/features.kanban.md",
        lanes: [{ name: "Spec", cards: [] }],
        cards: [],
        errors: [],
      }),
    });

    await server.start();

    const unauthorized = await fetch(
      `${server.baseUrl}/kanban/actions/execute`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          action: "apply",
          cardId: "feat-checkout-v2",
          worktreeKey: "main--feat-checkout-v2",
        }),
      },
    );
    expect(unauthorized.status).toBe(401);

    const execute = await fetch(`${server.baseUrl}/kanban/actions/execute`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-token",
      },
      body: JSON.stringify({
        action: "apply",
        cardId: "feat-checkout-v2",
        worktreeKey: "main--feat-checkout-v2",
      }),
    });
    expect(execute.status).toBe(202);
    const executeJson = (await execute.json()) as {
      requestId: string;
    };

    await new Promise((resolve) => setTimeout(resolve, 20));

    const status = await fetch(
      `${server.baseUrl}/kanban/actions/${executeJson.requestId}`,
      {
        headers: {
          authorization: "Bearer test-token",
        },
      },
    );
    const statusJson = (await status.json()) as { status: string };
    expect(status.status).toBe(200);
    expect(statusJson.status).toBe("success");

    const context = await fetch(
      `${server.baseUrl}/kanban/cards/feat-checkout-v2/context`,
      {
        headers: {
          authorization: "Bearer test-token",
        },
      },
    );
    expect(context.status).toBe(200);

    const board = await fetch(`${server.baseUrl}/kanban/board`, {
      headers: {
        authorization: "Bearer test-token",
      },
    });
    expect(board.status).toBe(200);
    const boardJson = (await board.json()) as { path: string };
    expect(boardJson.path).toBe("workitems/features.kanban.md");

    const patch = await fetch(`${server.baseUrl}/kanban/board`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-token",
      },
      body: JSON.stringify({
        nextBoardText: "## Spec\n\n- [ ] x <!-- card-id: x; kind: feature -->",
      }),
    });
    const patchJson = (await patch.json()) as { summary: string };
    expect(patch.status).toBe(200);
    expect(patchJson.summary).toBe("board updated");

    await server.stop();
  });

  it("allows requests without auth when token is disabled", async () => {
    const dir = createTempDir();
    const service = new KanbanOrchestratorService({
      auditLogPath: path.join(dir, "execution.log.jsonl"),
      createRequestId: () => "req-http-open-1",
      now: () => "2026-04-20T00:00:00.000Z",
      actionExecutors: {
        apply: async () => ({ summary: "applied" }),
      },
    });

    const server = createKanbanRuntimeServer({
      host: "127.0.0.1",
      port: 0,
      token: "",
      service,
      resolveContext: () => ({
        ok: true,
        context: {
          cardId: "feat-checkout-v2",
          title: "Checkout V2",
          kind: "feature",
          lane: "Spec",
          parentCardId: null,
          branch: "main--feat-checkout-v2",
          baseBranch: "main",
          mergeTarget: "main",
          worktreePath: "/tmp/wt/main--feat-checkout-v2",
          session: null,
        },
      }),
      applyBoardPatch: () => ({ ok: true, summary: "board updated" }),
      readBoard: () => ({
        path: "workitems/features.kanban.md",
        lanes: [{ name: "Spec", cards: [] }],
        cards: [],
        errors: [],
      }),
    });

    await server.start();

    const board = await fetch(`${server.baseUrl}/kanban/board`);
    expect(board.status).toBe(200);

    const execute = await fetch(`${server.baseUrl}/kanban/actions/execute`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        action: "apply",
        cardId: "feat-checkout-v2",
        worktreeKey: "main--feat-checkout-v2",
      }),
    });
    expect(execute.status).toBe(202);

    await server.stop();
  });

  it("serves SSE stream endpoint", async () => {
    const dir = createTempDir();
    const service = new KanbanOrchestratorService({
      auditLogPath: path.join(dir, "execution.log.jsonl"),
      actionExecutors: {},
    });

    const server = createKanbanRuntimeServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      service,
      resolveContext: () => ({
        ok: false,
        error: "unused",
      }),
      applyBoardPatch: () => ({ ok: false, error: "unused" }),
      readBoard: () => ({
        path: "workitems/features.kanban.md",
        lanes: [],
        cards: [],
        errors: [],
      }),
    });

    await server.start();

    const response = await fetch(`${server.baseUrl}/kanban/stream`, {
      headers: {
        authorization: "Bearer test-token",
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const chunk = await reader?.read();
    const text = new TextDecoder().decode(chunk?.value ?? new Uint8Array());
    expect(text).toContain("event: ready");

    await reader?.cancel();
    await server.stop();
  });
});
