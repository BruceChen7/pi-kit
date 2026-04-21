import { describe, expect, it, vi } from "vitest";

import { KanbanRuntimeApi } from "./api";

describe("KanbanRuntimeApi", () => {
  it("bootstraps through same-origin kanban endpoint", async () => {
    const fetchMock = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: "ready",
          sessionId: "workspace:workspace-kanban-drive",
          capabilities: {
            stream: true,
            actions: true,
          },
        }),
      } as unknown as Response;
    });

    vi.stubGlobal("fetch", fetchMock);

    const api = new KanbanRuntimeApi();
    const result = await api.bootstrap();

    expect(result).toEqual({
      status: "ready",
      sessionId: "workspace:workspace-kanban-drive",
      capabilities: {
        stream: true,
        actions: true,
      },
    });
    const [input, init] = fetchMock.mock.calls[0] as unknown as [
      RequestInfo | URL,
      RequestInit,
    ];
    expect(String(input)).toBe("/kanban/bootstrap");
    expect(init.method).toBe("POST");
  });

  it("loads board through same-origin requests without auth headers", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            path: "workitems/features.kanban.md",
            lanes: [],
            cards: [],
            errors: [],
          }),
          requestInit: init,
        } as unknown as Response;
      },
    );

    vi.stubGlobal("fetch", fetchMock);

    const api = new KanbanRuntimeApi();
    await api.getBoard();

    const [input, init] = fetchMock.mock.calls[0] as unknown as [
      RequestInfo | URL,
      RequestInit,
    ];
    expect(String(input)).toBe("/kanban/board");
    expect(init.method).toBe("GET");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });

  it("executes actions without frontend-derived worktreeKey", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        return {
          ok: true,
          status: 202,
          json: async () => ({
            requestId: "req-123",
            status: "queued",
          }),
          requestInit: init,
        } as unknown as Response;
      },
    );

    vi.stubGlobal("fetch", fetchMock);

    const api = new KanbanRuntimeApi();
    await api.executeAction({
      action: "apply",
      cardId: "child-pricing-widget",
      payload: { prompt: "hello" },
    });

    const [input, init] = fetchMock.mock.calls[0] as unknown as [
      RequestInfo | URL,
      RequestInit,
    ];
    expect(String(input)).toBe("/kanban/actions/execute");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(
      JSON.stringify({
        action: "apply",
        cardId: "child-pricing-widget",
        payload: { prompt: "hello" },
      }),
    );
  });

  it("patches board markdown through same-origin runtime API", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            summary: "board updated",
          }),
          requestInit: init,
        } as unknown as Response;
      },
    );

    vi.stubGlobal("fetch", fetchMock);

    const api = new KanbanRuntimeApi();
    await api.patchBoard(
      "## Spec\n\n- [ ] X <!-- card-id: x; kind: feature -->",
    );

    const [input, init] = fetchMock.mock.calls[0] as unknown as [
      RequestInfo | URL,
      RequestInit,
    ];
    expect(String(input)).toBe("/kanban/board");
    expect(init.method).toBe("PATCH");
    expect(init.body).toBe(
      JSON.stringify({
        nextBoardText: "## Spec\n\n- [ ] X <!-- card-id: x; kind: feature -->",
      }),
    );
  });

  it("sends terminal line input through same-origin runtime API", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            accepted: true,
            mode: "line",
          }),
          requestInit: init,
        } as unknown as Response;
      },
    );

    vi.stubGlobal("fetch", fetchMock);

    const api = new KanbanRuntimeApi();
    await api.sendTerminalInput("child-pricing-widget", "continue");

    const [input, init] = fetchMock.mock.calls[0] as unknown as [
      RequestInfo | URL,
      RequestInit,
    ];
    expect(String(input)).toBe(
      "/kanban/cards/child-pricing-widget/terminal/input",
    );
    expect(init.method).toBe("POST");
    expect(init.body).toBe(
      JSON.stringify({
        input: "continue",
      }),
    );
  });

  it("loads card runtime detail", async () => {
    const fetchMock = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          cardId: "child-pricing-widget",
          lane: "In Progress",
          session: {
            chatJid: "chat:child-pricing-widget",
            worktreePath: "/tmp/wt/child-pricing-widget",
          },
          execution: {
            status: "running",
            summary: "agent started",
            requestId: null,
          },
          completion: {
            readyForReview: false,
            completedAt: null,
          },
          terminal: {
            available: true,
            protocol: "sse-text-stream",
            streamUrl: "/kanban/cards/child-pricing-widget/terminal/stream",
          },
        }),
      } as unknown as Response;
    });

    vi.stubGlobal("fetch", fetchMock);

    const api = new KanbanRuntimeApi();
    const runtime = await api.getCardRuntime("child-pricing-widget");

    expect(runtime.terminal.streamUrl).toBe(
      "/kanban/cards/child-pricing-widget/terminal/stream",
    );
  });

  it("surfaces HTTP status when error responses have an empty body", async () => {
    const fetchMock = vi.fn(async () => {
      return {
        ok: false,
        status: 404,
        json: async () => {
          throw new SyntaxError("Unexpected end of JSON input");
        },
      } as unknown as Response;
    });

    vi.stubGlobal("fetch", fetchMock);

    const api = new KanbanRuntimeApi();

    await expect(api.getCardRuntime("child-pricing-widget")).rejects.toThrow(
      "HTTP 404",
    );
  });

  it("creates same-origin event sources", () => {
    class MockEventSource {
      constructor(public readonly url: string) {}
    }

    vi.stubGlobal("EventSource", MockEventSource);

    const api = new KanbanRuntimeApi();
    const stream = api.createEventSource() as unknown as MockEventSource;

    expect(stream.url).toBe("/kanban/stream");
  });

  it("creates terminal event sources from relative stream urls", () => {
    class MockEventSource {
      constructor(public readonly url: string) {}
    }

    vi.stubGlobal("EventSource", MockEventSource);

    const api = new KanbanRuntimeApi();
    const stream = api.createTerminalEventSource(
      "/kanban/cards/child-pricing-widget/terminal/stream",
    ) as unknown as MockEventSource;

    expect(stream.url).toBe(
      "/kanban/cards/child-pricing-widget/terminal/stream",
    );
  });
});
