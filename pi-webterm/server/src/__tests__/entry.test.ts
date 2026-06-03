import { afterEach, describe, expect, it, vi } from "vitest";
import { resetConfig } from "../config.js";
import { createServer, startServer } from "../index.js";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

describe("createServer", () => {
  afterEach(() => {
    resetConfig();
  });

  it("creates a Fastify server with config", async () => {
    const server = await createServer({
      port: 0,
      token: "create-test",
    });
    expect(server).toBeDefined();
    expect(server.server).toBeDefined();
    await server.close();
  });

  it("registers health endpoint", async () => {
    const server = await createServer({
      port: 0,
      token: "health-test",
    });
    const res = await server.inject({
      method: "GET",
      url: "/api/health",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("ok");
    await server.close();
  });

  it("registers sessions endpoint with auth", async () => {
    const server = await createServer({
      port: 0,
      token: "sess-test",
    });
    const res = await server.inject({
      method: "GET",
      url: "/api/sessions",
      headers: { authorization: "Bearer sess-test" },
    });
    expect(res.statusCode).toBe(200);
    await server.close();
  });

  it("registers WebSocket upgrade path", async () => {
    const server = await createServer({
      port: 0,
      token: "ws-test",
    });
    // WebSocket routes are only reachable via actual WS upgrade,
    // not via HTTP inject. Verify the route is registered by
    // checking that the server has the WS route handler.
    const routes = server.printRoutes();
    expect(routes).toContain("ws");
    await server.close();
  });
});

describe("startServer", () => {
  afterEach(() => {
    resetConfig();
  });

  it("starts and stops the server", async () => {
    const server = await createServer({ port: 0, token: "start-test" });
    const url = await startServer(server);
    expect(url).toBeDefined();
    expect(url).toContain("http");
    await server.close();
  });
});
