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

  it("loads the new home endpoint", async () => {
    const fetchMock = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          mode: "empty-create",
          hasUnfinishedRequirements: false,
          lastViewedProjectId: null,
          recentProjects: [],
          projectGroups: [],
        }),
      } as unknown as Response;
    });

    vi.stubGlobal("fetch", fetchMock);

    const api = new KanbanRuntimeApi();
    await api.getHome();

    const [input, init] = fetchMock.mock.calls[0] as unknown as [
      RequestInfo | URL,
      RequestInit,
    ];
    expect(String(input)).toBe("/kanban/home");
    expect(init.method).toBe("GET");
  });

  it("creates requirements through same-origin requests", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            requirement: { id: "req-1" },
            project: { id: "project-1" },
            activeSession: null,
            runtime: {
              summary: null,
              status: "idle",
              terminalAvailable: false,
              streamUrl: "/kanban/requirements/req-1/terminal/stream",
            },
          }),
          requestInit: init,
        } as unknown as Response;
      },
    );

    vi.stubGlobal("fetch", fetchMock);

    const api = new KanbanRuntimeApi();
    await api.createRequirement({
      title: "Build inbox flow",
      prompt: "Create the new kanban experience",
      projectPath: "/tmp/demo",
      projectName: "demo",
    });

    const [input, init] = fetchMock.mock.calls[0] as unknown as [
      RequestInfo | URL,
      RequestInit,
    ];
    expect(String(input)).toBe("/kanban/requirements");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(
      JSON.stringify({
        title: "Build inbox flow",
        prompt: "Create the new kanban experience",
        projectPath: "/tmp/demo",
        projectName: "demo",
      }),
    );
  });

  it("starts a requirement with a command", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            requirement: { id: "req-1" },
            project: { id: "project-1" },
            activeSession: { id: "session-1" },
            runtime: {
              summary: "Running pi hello",
              status: "running",
              terminalAvailable: true,
              streamUrl: "/kanban/requirements/req-1/terminal/stream",
            },
          }),
          requestInit: init,
        } as unknown as Response;
      },
    );

    vi.stubGlobal("fetch", fetchMock);

    const api = new KanbanRuntimeApi();
    await api.startRequirement("req-1", "pi hello");

    const [input, init] = fetchMock.mock.calls[0] as unknown as [
      RequestInfo | URL,
      RequestInit,
    ];
    expect(String(input)).toBe("/kanban/requirements/req-1/start");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ command: "pi hello" }));
  });

  it("sends terminal line input to requirement sessions", async () => {
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
    await api.sendRequirementTerminalInput("req-1", "continue");

    const [input, init] = fetchMock.mock.calls[0] as unknown as [
      RequestInfo | URL,
      RequestInit,
    ];
    expect(String(input)).toBe("/kanban/requirements/req-1/terminal/input");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ input: "continue" }));
  });

  it("creates terminal event sources from relative stream urls", () => {
    class MockEventSource {
      constructor(public readonly url: string) {}
    }

    vi.stubGlobal("EventSource", MockEventSource);

    const api = new KanbanRuntimeApi();
    const stream = api.createTerminalEventSource(
      "/kanban/requirements/req-1/terminal/stream",
    ) as unknown as MockEventSource;

    expect(stream.url).toBe("/kanban/requirements/req-1/terminal/stream");
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

    await expect(api.getRequirement("req-404")).rejects.toThrow("HTTP 404");
  });
});
