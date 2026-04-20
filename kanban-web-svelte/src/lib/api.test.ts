import { describe, expect, it, vi } from "vitest";

import { KanbanRuntimeApi } from "./api";

describe("KanbanRuntimeApi", () => {
  it("accepts token input with optional Bearer prefix for HTTP calls", async () => {
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

    const api = new KanbanRuntimeApi(
      "http://127.0.0.1:17888",
      "Bearer test-token",
    );
    await api.getBoard();

    const [, init] = fetchMock.mock.calls[0] as [
      RequestInfo | URL,
      RequestInit,
    ];
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer test-token");
  });

  it("accepts token input with optional Bearer prefix for SSE", () => {
    class MockEventSource {
      constructor(public readonly url: string) {}
    }

    vi.stubGlobal("EventSource", MockEventSource);

    const api = new KanbanRuntimeApi(
      "http://127.0.0.1:17888",
      "Bearer test-token",
    );
    const stream = api.createEventSource() as unknown as MockEventSource;

    expect(stream.url).toContain("token=test-token");
  });

  it("omits authorization header when token is empty", async () => {
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

    const api = new KanbanRuntimeApi("http://127.0.0.1:17888", "");
    await api.getBoard();

    const [, init] = fetchMock.mock.calls[0] as [
      RequestInfo | URL,
      RequestInit,
    ];
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });

  it("omits token query parameter for SSE when token is empty", () => {
    class MockEventSource {
      constructor(public readonly url: string) {}
    }

    vi.stubGlobal("EventSource", MockEventSource);

    const api = new KanbanRuntimeApi("http://127.0.0.1:17888", "");
    const stream = api.createEventSource() as unknown as MockEventSource;

    expect(stream.url).toBe("http://127.0.0.1:17888/kanban/stream");
  });
});
