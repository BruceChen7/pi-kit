import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createKanbanRuntimeServer } from "./runtime-server.js";
import type {
  KanbanChildLifecycleEvent,
  KanbanTerminalEvent,
} from "./runtime-state.js";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-runtime-server-"));
  tempDirs.push(dir);
  return dir;
}

function createBackend(overrides?: {
  executeAction?: (body: Record<string, unknown>) => {
    status: number;
    body: Record<string, unknown>;
  };
  getActionStatus?: (requestId: string) => {
    status: number;
    body: Record<string, unknown>;
  };
  cancelAction?: (requestId: string) =>
    | Promise<{
        status: number;
        body: Record<string, unknown>;
      }>
    | {
        status: number;
        body: Record<string, unknown>;
      };
  getCardContext?: (cardQuery: string) => {
    status: number;
    body: Record<string, unknown>;
  };
  getCardRuntime?: (cardQuery: string) => {
    status: number;
    body: Record<string, unknown>;
  };
  readBoard?: () => {
    status: number;
    body: Record<string, unknown>;
  };
  patchBoard?: (nextBoardText: string) => {
    status: number;
    body: Record<string, unknown>;
  };
  subscribeActionStream?: (onEvent: (state: unknown) => void) => () => void;
  subscribeLifecycleStream?: (
    onEvent: (event: KanbanChildLifecycleEvent) => void,
  ) => () => void;
  subscribeTerminalStream?: (
    cardId: string,
    onEvent: (event: KanbanTerminalEvent) => void,
  ) => () => void;
}) {
  return {
    executeAction: vi.fn(
      overrides?.executeAction ??
        (() => ({
          status: 202,
          body: {
            requestId: "req-backend-1",
            status: "queued",
          },
        })),
    ),
    getActionStatus: vi.fn(
      overrides?.getActionStatus ??
        (() => ({
          status: 200,
          body: {
            requestId: "req-backend-1",
            status: "success",
          },
        })),
    ),
    cancelAction: vi.fn(
      overrides?.cancelAction ??
        (() => ({
          status: 200,
          body: {
            requestId: "req-backend-1",
            status: "cancelled",
          },
        })),
    ),
    getCardContext: vi.fn(
      overrides?.getCardContext ??
        ((cardQuery) => ({
          status: 200,
          body: {
            cardId: cardQuery,
          },
        })),
    ),
    getCardRuntime: vi.fn(
      overrides?.getCardRuntime ??
        ((cardQuery) => ({
          status: 200,
          body: {
            cardId: cardQuery,
            terminal: {
              streamUrl: `/kanban/cards/${cardQuery}/terminal/stream`,
            },
            completion: {
              readyForReview: false,
            },
          },
        })),
    ),
    readBoard: vi.fn(
      overrides?.readBoard ??
        (() => ({
          status: 200,
          body: {
            path: "workitems/features.kanban.md",
            lanes: [],
            cards: [],
            errors: [],
          },
        })),
    ),
    patchBoard: vi.fn(
      overrides?.patchBoard ??
        (() => ({
          status: 200,
          body: {
            summary: "board updated",
          },
        })),
    ),
    subscribeActionStream: vi.fn(
      overrides?.subscribeActionStream ??
        ((onEvent: (state: unknown) => void) => {
          onEvent({
            requestId: "req-backend-1",
            status: "running",
          });
          return vi.fn();
        }),
    ),
    subscribeLifecycleStream: vi.fn(
      overrides?.subscribeLifecycleStream ??
        ((onEvent: (event: KanbanChildLifecycleEvent) => void) => {
          onEvent({
            type: "child-running",
            cardId: "feat-checkout-v2",
            summary: "running",
            ts: "2026-04-21T00:00:00.000Z",
          });
          return vi.fn();
        }),
    ),
    subscribeTerminalStream: vi.fn(
      overrides?.subscribeTerminalStream ??
        ((cardId: string, onEvent: (event: KanbanTerminalEvent) => void) => {
          onEvent({
            type: "ready",
            cardId,
            ts: "2026-04-21T00:00:00.000Z",
            protocol: "sse-text-stream",
          });
          onEvent({
            type: "chunk",
            cardId,
            ts: "2026-04-21T00:00:01.000Z",
            chunk: "backend terminal",
          });
          return vi.fn();
        }),
    ),
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("createKanbanRuntimeServer", () => {
  it("requires a daemon backend", () => {
    expect(() =>
      createKanbanRuntimeServer({
        host: "127.0.0.1",
        port: 0,
        token: "",
        workspaceId: "workspace-kanban-drive",
      } as never),
    ).toThrow("backend is required");
  });

  it("requires backend stream subscriptions", () => {
    const backend = createBackend();
    delete (backend as Record<string, unknown>).subscribeActionStream;

    expect(() =>
      createKanbanRuntimeServer({
        host: "127.0.0.1",
        port: 0,
        token: "",
        workspaceId: "workspace-kanban-drive",
        backend: backend as never,
      }),
    ).toThrow("backend stream subscriptions are required");
  });

  it("serves bootstrap endpoint with workspace-scoped session metadata", async () => {
    createTempDir();
    const backend = createBackend();
    const server = createKanbanRuntimeServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      workspaceId: "workspace-kanban-drive",
      backend,
    });

    await server.start();

    const response = await fetch(`${server.baseUrl}/kanban/bootstrap`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
      },
    });
    const payload = (await response.json()) as {
      status: string;
      workspaceId: string;
      sessionId: string;
      capabilities: { stream: boolean; actions: boolean };
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

    await server.stop();
  });

  it("delegates product routes to the injected control-plane backend", async () => {
    createTempDir();
    const backend = createBackend();

    const server = createKanbanRuntimeServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      workspaceId: "workspace-kanban-drive",
      backend,
    });

    await server.start();

    const execute = await fetch(`${server.baseUrl}/kanban/actions/execute`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-token",
      },
      body: JSON.stringify({
        action: "apply",
        cardId: "feat-checkout-v2",
      }),
    });
    expect(execute.status).toBe(202);
    expect(backend.executeAction).toHaveBeenCalledWith({
      action: "apply",
      cardId: "feat-checkout-v2",
    });

    const status = await fetch(
      `${server.baseUrl}/kanban/actions/req-backend-1`,
      {
        headers: {
          authorization: "Bearer test-token",
        },
      },
    );
    expect(status.status).toBe(200);
    expect(backend.getActionStatus).toHaveBeenCalledWith("req-backend-1");

    const cancel = await fetch(
      `${server.baseUrl}/kanban/actions/req-backend-1/cancel`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
        },
      },
    );
    expect(cancel.status).toBe(200);
    expect(backend.cancelAction).toHaveBeenCalledWith("req-backend-1");

    const context = await fetch(
      `${server.baseUrl}/kanban/cards/feat-checkout-v2/context`,
      {
        headers: {
          authorization: "Bearer test-token",
        },
      },
    );
    expect(context.status).toBe(200);
    expect(backend.getCardContext).toHaveBeenCalledWith("feat-checkout-v2");

    const runtime = await fetch(
      `${server.baseUrl}/kanban/cards/feat-checkout-v2/runtime`,
      {
        headers: {
          authorization: "Bearer test-token",
        },
      },
    );
    expect(runtime.status).toBe(200);
    expect(backend.getCardRuntime).toHaveBeenCalledWith("feat-checkout-v2");

    const board = await fetch(`${server.baseUrl}/kanban/board`, {
      headers: {
        authorization: "Bearer test-token",
      },
    });
    expect(board.status).toBe(200);
    expect(backend.readBoard).toHaveBeenCalledTimes(1);

    const patch = await fetch(`${server.baseUrl}/kanban/board`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-token",
      },
      body: JSON.stringify({
        nextBoardText: "next board text",
      }),
    });
    expect(patch.status).toBe(200);
    expect(backend.patchBoard).toHaveBeenCalledWith("next board text");

    const stream = await fetch(`${server.baseUrl}/kanban/stream`, {
      headers: {
        authorization: "Bearer test-token",
      },
    });
    expect(stream.status).toBe(200);
    const streamReader = stream.body?.getReader();
    const streamChunk = await streamReader?.read();
    const streamText = new TextDecoder().decode(
      streamChunk?.value ?? new Uint8Array(),
    );
    expect(backend.subscribeActionStream).toHaveBeenCalledTimes(1);
    expect(backend.subscribeLifecycleStream).toHaveBeenCalledTimes(1);
    expect(streamText).toContain("event: ready");
    expect(streamText).toContain("event: state");
    expect(streamText).toContain("event: child-running");
    await streamReader?.cancel();

    const terminal = await fetch(
      `${server.baseUrl}/kanban/cards/feat-checkout-v2/terminal/stream`,
      {
        headers: {
          authorization: "Bearer test-token",
        },
      },
    );
    expect(terminal.status).toBe(200);
    const terminalReader = terminal.body?.getReader();
    const terminalChunk = await terminalReader?.read();
    const terminalText = new TextDecoder().decode(
      terminalChunk?.value ?? new Uint8Array(),
    );
    expect(backend.subscribeTerminalStream).toHaveBeenCalledWith(
      "feat-checkout-v2",
      expect.any(Function),
    );
    expect(terminalText).toContain("event: ready");
    expect(terminalText).toContain("event: chunk");
    expect(terminalText).toContain("backend terminal");
    await terminalReader?.cancel();

    await server.stop();
  });

  it("allows requests without auth when token is disabled", async () => {
    createTempDir();
    const backend = createBackend();

    const server = createKanbanRuntimeServer({
      host: "127.0.0.1",
      port: 0,
      token: "",
      workspaceId: "workspace-kanban-drive",
      backend,
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
      }),
    });
    expect(execute.status).toBe(202);

    await server.stop();
  });

  it("serves SSE stream endpoint from the backend subscriptions", async () => {
    createTempDir();
    const backend = createBackend();

    const server = createKanbanRuntimeServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      workspaceId: "workspace-kanban-drive",
      backend,
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
    expect(text).toContain("event: state");
    expect(text).toContain("event: child-running");

    await reader?.cancel();
    await server.stop();
  });

  it("serves card runtime detail and terminal stream endpoints from the backend", async () => {
    createTempDir();
    const backend = createBackend({
      getCardRuntime: (cardQuery) => ({
        status: 200,
        body: {
          cardId: cardQuery,
          terminal: {
            streamUrl: `/kanban/cards/${cardQuery}/terminal/stream`,
          },
          completion: {
            readyForReview: false,
          },
        },
      }),
      subscribeTerminalStream: (
        cardId: string,
        onEvent: (event: KanbanTerminalEvent) => void,
      ) => {
        onEvent({
          type: "ready",
          cardId,
          ts: "2026-04-20T00:00:00.000Z",
          protocol: "sse-text-stream",
        });
        onEvent({
          type: "chunk",
          cardId,
          ts: "2026-04-20T00:00:01.000Z",
          chunk: "hello world",
        });
        return vi.fn();
      },
    });

    const server = createKanbanRuntimeServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      workspaceId: "workspace-kanban-drive",
      backend,
    });

    await server.start();

    const runtimeResponse = await fetch(
      `${server.baseUrl}/kanban/cards/child-pricing-widget/runtime`,
      {
        headers: {
          authorization: "Bearer test-token",
        },
      },
    );
    expect(runtimeResponse.status).toBe(200);
    const runtimeJson = (await runtimeResponse.json()) as {
      terminal: { streamUrl: string };
      completion: { readyForReview: boolean };
    };
    expect(runtimeJson.terminal.streamUrl).toBe(
      "/kanban/cards/child-pricing-widget/terminal/stream",
    );
    expect(runtimeJson.completion.readyForReview).toBe(false);

    const terminalResponse = await fetch(
      `${server.baseUrl}/kanban/cards/child-pricing-widget/terminal/stream`,
      {
        headers: {
          authorization: "Bearer test-token",
        },
      },
    );
    expect(terminalResponse.status).toBe(200);
    expect(terminalResponse.headers.get("content-type")).toContain(
      "text/event-stream",
    );

    const reader = terminalResponse.body?.getReader();
    const chunk = await reader?.read();
    const text = new TextDecoder().decode(chunk?.value ?? new Uint8Array());
    expect(text).toContain("event: ready");
    expect(text).toContain("event: chunk");
    expect(text).toContain("hello world");

    await reader?.cancel();
    await server.stop();
  });
});
