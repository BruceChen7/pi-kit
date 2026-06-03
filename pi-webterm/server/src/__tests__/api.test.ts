import Fastify from "fastify";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  cleanupActivePtySession,
  getActivePtySessionForTests,
  registerActivePtySession,
  registerRoutes,
  resetRuntimeStateForTests,
  stripTerminalResponses,
} from "../api.js";
import { generateSessionToken } from "../auth.js";
import { loadConfig, resetConfig } from "../config.js";
import { detachPty, hasSession } from "../tmux.js";

// Mock tmux module
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

// Mock sessions module
vi.mock("../sessions.js", () => ({
  listPwSessions: vi.fn(() => []),
  detectSessionStatus: vi.fn(() => "running"),
  createPwSession: vi.fn(),
  deletePwSession: vi.fn(),
  getGitBranch: vi.fn(() => "main"),
  getTmuxSessionName: vi.fn((dir, branch) => `pw__${dir}__${branch}`),
}));

describe("API routes", () => {
  const fastify = Fastify();
  let sessionToken: string;

  beforeEach(() => {
    vi.clearAllMocks();
    resetRuntimeStateForTests();
  });

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

  it("POST /api/login returns token + sessions for valid credentials", async () => {
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
    expect(body).toHaveProperty("sessions");
    expect(Array.isArray(body.sessions)).toBe(true);
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

  it("GET /api/sessions returns session list with rich info", async () => {
    const { listPwSessions } = await import("../sessions.js");
    vi.mocked(listPwSessions).mockReturnValue([
      {
        name: "pw__my-app__main",
        dirname: "my-app",
        branch: "main",
        status: "running",
        attached: false,
      },
      {
        name: "pw__other__dev",
        dirname: "other",
        branch: "dev",
        status: "crashed",
        attached: false,
      },
    ]);
    vi.mocked(hasSession).mockReturnValue(true);

    const res = await fastify.inject({
      method: "GET",
      url: "/api/sessions",
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.sessions).toHaveLength(2);
    expect(body.sessions[0]).toHaveProperty("dirname");
    expect(body.sessions[0]).toHaveProperty("branch");
    expect(body.sessions[0]).toHaveProperty("status");
  });

  it("POST /api/sessions creates a new session with sessionToken", async () => {
    vi.mocked(hasSession).mockReturnValue(false);

    const res = await fastify.inject({
      method: "POST",
      url: "/api/sessions",
      headers: {
        authorization: `Bearer ${sessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ dirname: "my-app", branch: "main" }),
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty("sessionToken");
    expect(typeof body.sessionToken).toBe("string");
    expect(body.name).toBe("pw__my-app__main");
  });

  it("POST /api/sessions/:name/attach returns sessionToken", async () => {
    vi.mocked(hasSession).mockReturnValue(true);

    const res = await fastify.inject({
      method: "POST",
      url: "/api/sessions/pw__my-app__main/attach",
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty("sessionToken");
    expect(body.name).toBe("pw__my-app__main");
  });

  it("POST /api/sessions/:name/attach returns 404 for unknown session", async () => {
    vi.mocked(hasSession).mockReturnValue(false);

    const res = await fastify.inject({
      method: "POST",
      url: "/api/sessions/pw__unknown/attach",
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("DELETE /api/sessions/:name kills a session", async () => {
    const { deletePwSession } = await import("../sessions.js");
    vi.mocked(hasSession).mockReturnValue(true);

    const res = await fastify.inject({
      method: "DELETE",
      url: "/api/sessions/pw__test__main",
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(deletePwSession).toHaveBeenCalledWith("pw__test__main");
  });

  it("DELETE /api/sessions/:name returns 404 for unknown session", async () => {
    vi.mocked(hasSession).mockReturnValue(false);

    const res = await fastify.inject({
      method: "DELETE",
      url: "/api/sessions/pw__missing__main",
      headers: { authorization: `Bearer ${sessionToken}` },
    });

    expect(res.statusCode).toBe(404);
  });

  it("DELETE /api/sessions/:name returns 500 when tmux deletion fails", async () => {
    const { deletePwSession } = await import("../sessions.js");
    vi.mocked(hasSession).mockReturnValue(true);
    vi.mocked(deletePwSession).mockImplementation(() => {
      throw new Error("tmux delete failed");
    });

    const res = await fastify.inject({
      method: "DELETE",
      url: "/api/sessions/pw__test__main",
      headers: { authorization: `Bearer ${sessionToken}` },
    });

    expect(res.statusCode).toBe(500);
  });
});

describe("stripTerminalResponses", () => {
  it("removes DA responses like '?1;2c' from tmux history", () => {
    expect(stripTerminalResponses("before\u001b[?1;2cafter")).toBe(
      "beforeafter",
    );
  });

  it("preserves normal terminal output", () => {
    expect(stripTerminalResponses("hello\r\nworld")).toBe("hello\r\nworld");
  });
});

describe("active PTY session lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRuntimeStateForTests();
  });

  it("detaches the previous PTY when re-registering the same session", () => {
    const firstPty = { kill: vi.fn() } as any;
    const secondPty = { kill: vi.fn() } as any;

    registerActivePtySession("pw__demo__main", firstPty);
    registerActivePtySession("pw__demo__main", secondPty);

    expect(detachPty).toHaveBeenCalledTimes(1);
    expect(detachPty).toHaveBeenCalledWith(firstPty);
    expect(getActivePtySessionForTests("pw__demo__main")).toBe(secondPty);
  });

  it("ignores stale cleanup from an older PTY after a newer one replaced it", () => {
    const firstPty = { kill: vi.fn() } as any;
    const secondPty = { kill: vi.fn() } as any;

    registerActivePtySession("pw__demo__main", firstPty);
    registerActivePtySession("pw__demo__main", secondPty);
    vi.mocked(detachPty).mockClear();

    cleanupActivePtySession("pw__demo__main", firstPty);

    expect(detachPty).toHaveBeenCalledTimes(1);
    expect(detachPty).toHaveBeenCalledWith(firstPty);
    expect(detachPty).not.toHaveBeenCalledWith(secondPty);
    expect(getActivePtySessionForTests("pw__demo__main")).toBe(secondPty);
  });
});
