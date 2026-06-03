import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { registerRoutes } from "../api.js";
import { generateSessionToken } from "../auth.js";
import { loadConfig, resetConfig } from "../config.js";
import { hasSession, listSessions } from "../tmux.js";

vi.mock("../tmux.js", () => ({
  hasSession: vi.fn(),
  listSessions: vi.fn(),
  killSession: vi.fn(),
  capturePane: vi.fn(() => "mock-output"),
  ensureSession: vi.fn(),
  attachToSession: vi.fn((_name, _cols, _rows) =>
    Promise.resolve({
      pty: {
        onData: vi.fn(),
        onExit: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
      },
    }),
  ),
  detachPty: vi.fn(),
}));

describe("API routes", () => {
  const fastify = Fastify();
  let sessionToken: string;

  beforeAll(async () => {
    resetConfig();
    loadConfig({ username: "admin", password: "admin" });
    sessionToken = generateSessionToken("admin");

    await fastify.register(import("@fastify/cors"));
    registerRoutes(fastify, {} as any);
    await fastify.ready();
  });

  afterAll(async () => {
    await fastify.close();
  });

  it("GET /api/health returns ok with authRequired", async () => {
    const res = await fastify.inject({
      method: "GET",
      url: "/api/health",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("ok");
    expect(body.authRequired).toBe(true);
  });

  it("GET /api/setup returns public key", async () => {
    const res = await fastify.inject({
      method: "GET",
      url: "/api/setup",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty("publicKey");
    expect(body.authRequired).toBe(true);
  });

  // ── Login ──────────────────────────────────────────────────

  it("POST /api/login returns token for valid credentials", async () => {
    const res = await fastify.inject({
      method: "POST",
      url: "/api/login",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "admin" }),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty("token");
    expect(typeof body.token).toBe("string");
    expect(body.expiresIn).toBe(86400);
  });

  it("POST /api/login returns 401 for invalid credentials", async () => {
    const res = await fastify.inject({
      method: "POST",
      url: "/api/login",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "wrong" }),
    });
    expect(res.statusCode).toBe(401);
  });

  it("POST /api/login returns 400 for missing fields", async () => {
    const res = await fastify.inject({
      method: "POST",
      url: "/api/login",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(400);
  });

  // ── Logout ─────────────────────────────────────────────────

  it("POST /api/logout invalidates token", async () => {
    const token = generateSessionToken("admin");
    const res = await fastify.inject({
      method: "POST",
      url: "/api/logout",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);

    // Verify token is now invalid
    const sessionsRes = await fastify.inject({
      method: "GET",
      url: "/api/sessions",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(sessionsRes.statusCode).toBe(401);
  });

  // ── Sessions ───────────────────────────────────────────────

  it("GET /api/sessions returns 401 without auth", async () => {
    const res = await fastify.inject({
      method: "GET",
      url: "/api/sessions",
    });
    expect(res.statusCode).toBe(401);
  });

  it("GET /api/sessions returns session list with valid token", async () => {
    vi.mocked(listSessions).mockReturnValue(["pi-agent", "test-sess"]);
    vi.mocked(hasSession).mockReturnValue(true);

    const res = await fastify.inject({
      method: "GET",
      url: "/api/sessions",
      headers: { authorization: `Bearer ${sessionToken}` },
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
        authorization: `Bearer ${sessionToken}`,
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
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(res.statusCode).toBe(200);
  });
});
