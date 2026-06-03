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
  handleTerminalQueries,
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
  it("removes primary DA responses: \\x1b[?1;2c", () => {
    expect(stripTerminalResponses("before\u001b[?1;2cafter")).toBe(
      "beforeafter",
    );
  });

  it("removes secondary DA responses: \\x1b[>0;0;0c", () => {
    expect(stripTerminalResponses("before\u001b[>0;0;0cafter")).toBe(
      "beforeafter",
    );
  });

  it("removes CPR responses: \\x1b[1;1R", () => {
    expect(stripTerminalResponses("before\u001b[1;1Rafter")).toBe(
      "beforeafter",
    );
  });

  it("preserves normal terminal output", () => {
    expect(stripTerminalResponses("hello\r\nworld")).toBe("hello\r\nworld");
  });

  it("preserves DECSET commands like \\x1b[?1049h", () => {
    expect(stripTerminalResponses("\u001b[?1049h")).toBe("\u001b[?1049h");
  });

  it("preserves SGR commands like \\x1b[32m", () => {
    expect(stripTerminalResponses("\u001b[32m")).toBe("\u001b[32m");
  });

  it("preserves cursor movement like \\x1b[H", () => {
    expect(stripTerminalResponses("\u001b[H")).toBe("\u001b[H");
  });

  it("preserves CUU like \\x1b[1A", () => {
    expect(stripTerminalResponses("\u001b[1A")).toBe("\u001b[1A");
  });

  it("handles multiple consecutive DA responses", () => {
    expect(
      stripTerminalResponses("\u001b[?1;2c\u001b[>0;0;0c\u001b[1;1R"),
    ).toBe("");
  });
});

describe("handleTerminalQueries", () => {
  it("intercepts primary DA request (\\x1b[c) and responds", () => {
    const result = handleTerminalQueries("before\u001b[cafter");
    expect(result.filtered).toBe("beforeafter");
    expect(result.responses).toEqual(["\u001b[?1;2c"]);
  });

  it("intercepts primary DA request (\\x1b[?c) variant", () => {
    const result = handleTerminalQueries("\u001b[?c");
    expect(result.filtered).toBe("");
    expect(result.responses).toEqual(["\u001b[?1;2c"]);
  });

  it("intercepts secondary DA request (\\x1b[>c) and responds", () => {
    const result = handleTerminalQueries("\u001b[>c");
    expect(result.filtered).toBe("");
    expect(result.responses).toEqual(["\u001b[>0;0;0c"]);
  });

  it("swallows tertiary-looking query (\\x1b[>q) without synthesizing >0;0;0q", () => {
    const result = handleTerminalQueries("\u001b[>q");
    expect(result.filtered).toBe("");
    expect(result.responses).toEqual([]);
  });

  it("intercepts CPR request (\\x1b[6n) and responds", () => {
    const result = handleTerminalQueries("\u001b[6n");
    expect(result.filtered).toBe("");
    expect(result.responses).toEqual(["\u001b[1;1R"]);
  });

  it("intercepts DSR request (\\x1b[5n) and responds", () => {
    const result = handleTerminalQueries("\u001b[5n");
    expect(result.filtered).toBe("");
    expect(result.responses).toEqual(["\u001b[0n"]);
  });

  it("handles multiple queries in a single data chunk", () => {
    const result = handleTerminalQueries("\u001b[c\u001b[>c\u001b[>q\u001b[6n");
    expect(result.filtered).toBe("");
    expect(result.responses).toEqual([
      "\u001b[?1;2c",
      "\u001b[>0;0;0c",
      "\u001b[1;1R",
    ]);
  });

  it("preserves normal output that includes query-like text", () => {
    const result = handleTerminalQueries("hello world");
    expect(result.filtered).toBe("hello world");
    expect(result.responses).toEqual([]);
  });

  it("preserves output intermixed with queries", () => {
    const result = handleTerminalQueries("start\u001b[cend\u001b[>cmore");
    expect(result.filtered).toBe("startendmore");
    expect(result.responses).toHaveLength(2);
  });

  it("does not intercept terminal responses (only queries)", () => {
    const result = handleTerminalQueries("\u001b[?1;2c");
    expect(result.filtered).toBe("\u001b[?1;2c");
    expect(result.responses).toEqual([]);
  });

  it("does not intercept CPR responses", () => {
    const result = handleTerminalQueries("\u001b[1;1R");
    expect(result.filtered).toBe("\u001b[1;1R");
    expect(result.responses).toEqual([]);
  });

  it("does not intercept normal escape sequences like \\x1b[32m", () => {
    const result = handleTerminalQueries("\u001b[32mgreen");
    expect(result.filtered).toBe("\u001b[32mgreen");
    expect(result.responses).toEqual([]);
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
