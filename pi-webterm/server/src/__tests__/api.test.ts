import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { registerRoutes } from "../api.js";
import { loadConfig, resetConfig } from "../config.js";
import { hasSession, listSessions } from "../tmux.js";

vi.mock("../tmux.js", () => ({
  hasSession: vi.fn(),
  listSessions: vi.fn(),
  killSession: vi.fn(),
  capturePane: vi.fn(() => "mock-output"),
  ensureSession: vi.fn(),
  attachToSession: vi.fn(),
  detachPty: vi.fn(),
}));

describe("API routes", () => {
  const fastify = Fastify();
  let authToken: string;

  beforeAll(async () => {
    resetConfig();
    const cfg = loadConfig({ token: "test-api-token" });
    authToken = cfg.token;

    await fastify.register(import("@fastify/cors"));
    registerRoutes(fastify, {} as any);
    await fastify.ready();
  });

  afterAll(async () => {
    await fastify.close();
  });

  it("GET /api/health returns ok", async () => {
    const res = await fastify.inject({
      method: "GET",
      url: "/api/health",
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe("ok");
  });

  it("GET /api/setup returns public key and token hint", async () => {
    const res = await fastify.inject({
      method: "GET",
      url: "/api/setup",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty("publicKey");
    expect(body.tokenHint).toContain("...");
  });

  it("GET /api/sessions returns 401 without auth", async () => {
    const res = await fastify.inject({
      method: "GET",
      url: "/api/sessions",
    });
    expect(res.statusCode).toBe(401);
  });

  it("GET /api/sessions returns session list", async () => {
    vi.mocked(listSessions).mockReturnValue(["pi-agent", "test-sess"]);
    vi.mocked(hasSession).mockReturnValue(true);

    const res = await fastify.inject({
      method: "GET",
      url: "/api/sessions",
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).sessions).toHaveLength(2);
  });

  it("POST /api/sessions creates a new session", async () => {
    vi.mocked(hasSession).mockReturnValue(false);

    const res = await fastify.inject({
      method: "POST",
      url: "/api/sessions",
      headers: {
        authorization: `Bearer ${authToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "new-session" }),
    });
    expect(res.statusCode).toBe(201);
  });

  it("DELETE /api/sessions/:name kills a session", async () => {
    const res = await fastify.inject({
      method: "DELETE",
      url: "/api/sessions/test-sess",
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(res.statusCode).toBe(200);
  });
});
