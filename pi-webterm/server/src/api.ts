import { resolve, basename } from "node:path";
import type { FastifyInstance } from "fastify";
import type { IPty } from "node-pty";
import {
  type AuthRequest,
  authenticateWsMessage,
  createAuthMiddleware,
  destroySession,
  generateSessionToken,
  getBearerToken,
  getSessionIdFromToken,
  validateCredentials,
  verifyWsToken,
} from "./auth.js";
import { getConfig } from "./config.js";
import { attachToSession, capturePane, detachPty, hasSession } from "./tmux.js";
import {
  createPwSession,
  deletePwSession,
  detectSessionStatus,
  listPwSessions,
  getGitBranch,
  getTmuxSessionName,
} from "./sessions.js";
import { decodeFrame, encodeBinaryFrame, encodeJsonFrame } from "./ws.js";

// ─── Active PTY sessions ───────────────────────────────────────

const activePtySessions = new Map<string, IPty>();

// Maps WebSocket connection → tmux session name (for multi-session routing)
const socketSessionMap = new Map<any, string>();

// ─── Terminal Response Filter ──────────────────────────────────

// Regex to match terminal query/response sequences that should NOT
// be forwarded to the WebSocket client as terminal output.
//
// These are responses that the terminal emulator (tmux) sends to the
// program running inside it. Examples:
//   - DA response:  \x1b[?1;2c          (Device Attributes)
//   - CPR response: \x1b[?n;mR          (Cursor Position Report)
//   - DECRPM:       \x1b[?n;m$y         (Report Mode)
//   - DECRQM:       \x1b[?n;m$y         (Request Mode Response)
//   - DECSCA:       \x1b[?n;m"p         (Select Character Attribute)
//   - DECSCUSR:     \x1b[?n;m$} etc.
//
// In pi-webterm, these responses go through pty.onData and would
// appear as visible "weird characters" (e.g., "?1;2c") in the
// terminal if forwarded. The pi agent reads them from stdin, so
// they are expected in the pty data but must be filtered out.
//
// Pattern: ESC [ ?digits;digits finalbyte
// Final bytes identifying RESPONSE (not command) sequences:
//   c  — DA response     (Device Attributes)
//   R  — CPR response    (Cursor Position Report)
//   y  — DECRPM/DECRQM   (Report/Request Mode response)
//   n  — DSR response    (Device Status Report — rarely used)
const TERMINAL_RESPONSE_RE = /(?:\x1b|\x9b)\[\?\d+(?:;\d+)*[cRy]/g;

export function stripTerminalResponses(data: string): string {
  return data.replace(TERMINAL_RESPONSE_RE, "");
}

// ─── Cleanup (for graceful shutdown) ───────────────────────────

/**
 * Kill all active PTY sessions. Called during graceful shutdown.
 */
export function cleanupPtySessions(): void {
  for (const [_name, pty] of activePtySessions.entries()) {
    detachPty(pty);
  }
  activePtySessions.clear();
}

export function registerActivePtySession(sessionName: string, pty: IPty): void {
  const existing = activePtySessions.get(sessionName);
  if (existing && existing !== pty) {
    detachPty(existing);
  }
  activePtySessions.set(sessionName, pty);
}

export function cleanupActivePtySession(
  sessionName: string,
  pty: IPty,
  socket?: unknown,
): void {
  detachPty(pty);
  if (activePtySessions.get(sessionName) === pty) {
    activePtySessions.delete(sessionName);
  }
  if (socket) {
    socketSessionMap.delete(socket);
  }
}

export function getActivePtySessionForTests(
  sessionName: string,
): IPty | undefined {
  return activePtySessions.get(sessionName);
}

export function resetRuntimeStateForTests(): void {
  activePtySessions.clear();
  socketSessionMap.clear();
}

// ─── Route Registration ────────────────────────────────────────

export function registerRoutes(
  fastify: FastifyInstance,
  _options: unknown,
): void {
  const auth = createAuthMiddleware();
  const authPreHandler = async (request: any, reply: any) => {
    if (await auth(request as AuthRequest)) {
      return;
    }
    reply.status(401).send({ error: "Unauthorized" });
  };

  // ── Public routes (no auth) ─────────────────────────────────

  // Health
  fastify.get("/api/health", async () => ({
    status: "ok",
    version: "0.1.0",
    authRequired: true,
  }));

  // Setup info
  fastify.get("/api/setup", async () => {
    const cfg = getConfig();
    return {
      publicKey: cfg.publicKey,
      host: cfg.host,
      port: cfg.port,
      authRequired: true,
    };
  });

  // Login — returns master token + list of existing pw__ sessions
  fastify.post("/api/login", async (request: any, reply: any) => {
    const { username, password } = request.body || {};
    if (!username || !password) {
      return reply
        .status(400)
        .send({ error: "Username and password are required" });
    }
    const cfg = getConfig();
    if (validateCredentials(cfg.username, cfg.password, username, password)) {
      const token = generateSessionToken(username); // master token (no sessionId)
      const sessions = listPwSessions().map((s) => ({
        ...s,
        attached: activePtySessions.has(s.name),
      }));
      return { token, expiresIn: 86400, sessions };
    }
    return reply.status(401).send({ error: "Invalid credentials" });
  });

  // Logout
  fastify.post("/api/logout", async (request: any, _reply: any) => {
    const bearerToken = getBearerToken(request.headers.authorization);
    if (bearerToken) {
      destroySession(bearerToken);
    }
    return { ok: true };
  });

  // ── Protected routes ────────────────────────────────────────

  // List pw__ sessions (pi-webterm managed)
  fastify.get("/api/sessions", { preHandler: authPreHandler }, async () => {
    const sessions = listPwSessions().map((s) => ({
      ...s,
      attached: activePtySessions.has(s.name),
    }));
    return { sessions };
  });

  // Create new pw__ session — returns session-specific token
  fastify.post(
    "/api/sessions",
    { preHandler: authPreHandler },
    async (request: any, reply: any) => {
      const cfg = getConfig();
      const body = request.body || {};

      // Determine dirname, branch, cwd, agentCommand
      const sessionCwd = body.cwd ? resolve(body.cwd) : resolve(cfg.cwd);
      const dirname = body.dirname || basename(sessionCwd);
      const branch = body.branch || getGitBranch(sessionCwd);
      const agentCommand = body.agentCommand || cfg.agentCommand;

      const name = getTmuxSessionName(dirname, branch);

      // Check for duplicates
      if (hasSession(name)) {
        return reply
          .status(409)
          .send({ error: "Session already exists", name });
      }

      // Create tmux session
      createPwSession(dirname, branch, sessionCwd, agentCommand);

      // Generate session-specific token for WS auto-attach
      const sessionToken = generateSessionToken(cfg.username, name);

      return reply.status(201).send({
        name,
        dirname,
        branch,
        cwd: sessionCwd,
        status: detectSessionStatus(name),
        attached: false,
        sessionToken,
      });
    },
  );

  // Session detail
  fastify.get(
    "/api/sessions/:name",
    { preHandler: authPreHandler },
    async (request: any, reply: any) => {
      const { name } = request.params;
      if (!hasSession(name)) {
        return reply.status(404).send({ error: "Session not found" });
      }
      return {
        name,
        status: detectSessionStatus(name),
        attached: activePtySessions.has(name),
        recentOutput: capturePane(name, 50),
      };
    },
  );

  // Attach to session — returns session-specific token for WS
  fastify.post(
    "/api/sessions/:name/attach",
    { preHandler: authPreHandler },
    async (request: any, reply: any) => {
      const { name } = request.params;
      if (!hasSession(name)) {
        return reply.status(404).send({ error: "Session not found" });
      }
      const sessionToken = generateSessionToken(getConfig().username, name);
      return { sessionToken, name };
    },
  );

  // Kill session
  fastify.delete(
    "/api/sessions/:name",
    { preHandler: authPreHandler },
    async (request: any, reply: any) => {
      const { name } = request.params;
      if (!hasSession(name)) {
        return reply.status(404).send({ error: "Session not found" });
      }

      const pty = activePtySessions.get(name);
      if (pty) {
        detachPty(pty);
        activePtySessions.delete(name);
      }

      try {
        deletePwSession(name);
      } catch {
        return reply.status(500).send({ error: "Failed to delete session" });
      }

      return { deleted: true, name };
    },
  );

  // ── WebSocket ────────────────────────────────────────────────

  fastify.get("/ws", { websocket: true }, (socket, _request) => {
    // Do NOT send any data until authenticated
    handleWsAuth(socket);
  });
}

// ─── WebSocket Auth ────────────────────────────────────────────

function handleWsAuth(socket: any): void {
  let authenticated = false;

  // Set 5-second auth timeout
  const authTimeout = setTimeout(() => {
    if (!authenticated) {
      socket.close(4001, "Unauthorized");
    }
  }, 5000);

  socket.on("message", (raw: Buffer) => {
    if (raw.length === 0) return;

    if (!authenticated) {
      // Only accept JSON control frames for auth
      if (raw[0] !== 0x01) return;

      try {
        const nullPos = raw.indexOf(0x00, 1);
        if (nullPos === -1) return;
        const jsonStr = raw.subarray(nullPos + 1).toString("utf-8");
        const msg = JSON.parse(jsonStr);

        if (authenticateWsMessage(msg) && verifyWsToken(msg.token)) {
          // Extract sessionId from the session-specific token
          const sessionId = getSessionIdFromToken(msg.token);
          if (!sessionId) {
            socket.close(4001, "Unauthorized - no session in token");
            return;
          }

          authenticated = true;
          clearTimeout(authTimeout);

          // Track socket → session mapping for multi-session routing
          socketSessionMap.set(socket, sessionId);

          // Start normal communication with the requested session
          handleWsConnection(socket, sessionId);
        } else {
          socket.close(4001, "Unauthorized");
        }
      } catch {
        // ignore invalid messages before auth
      }
      return;
    }

    // ── Authenticated message handling ──
    handleWsMessage(socket, raw);
  });

  socket.on("close", () => {
    clearTimeout(authTimeout);
    socketSessionMap.delete(socket);
  });

  socket.on("error", () => {
    clearTimeout(authTimeout);
    socketSessionMap.delete(socket);
  });
}

// ─── WebSocket Handler (after auth) ────────────────────────────

async function handleWsConnection(socket: any, sessionName: string) {
  // Session must already exist (created via POST /api/sessions or previous run)
  if (!hasSession(sessionName)) {
    socket.send(
      encodeJsonFrame(sessionName, {
        type: "error",
        message: "Session not found",
      }),
    );
    socket.close(4002, "Session not found");
    return;
  }

  // Attach to session via node-pty
  let pty: IPty;
  try {
    const session = await attachToSession(sessionName, 80, 24);
    pty = session.pty;
    registerActivePtySession(sessionName, pty);
  } catch (_err) {
    socket.send(
      encodeJsonFrame(sessionName, {
        type: "error",
        message: "Failed to attach to session",
      }),
    );
    socket.close(4002, "Attach failed");
    return;
  }

  // Send status
  socket.send(
    encodeJsonFrame(sessionName, {
      type: "status",
      connected: true,
      session: sessionName,
    }),
  );

  // Send recent history
  const history = stripTerminalResponses(capturePane(sessionName, 200));
  if (history) {
    socket.send(
      encodeJsonFrame(sessionName, {
        type: "snapshot",
        data: Buffer.from(history).toString("base64"),
      }),
    );
  }

  // Forward PTY output → WebSocket
  pty.onData((data: string) => {
    try {
      // Filter out terminal query/response sequences (e.g., DA response
      // "\x1b[?1;2c") that leak through the pty and would appear as
      // "weird characters" ("?1;2c") when written to xterm.js.
      const filtered = stripTerminalResponses(data);

      // Use binary frames (not raw text frames) for consistent
      // protocol framing. The client decodes via TextDecoder.
      if (filtered) {
        socket.send(encodeBinaryFrame(sessionName, Buffer.from(filtered)));
      }
    } catch {
      // socket closed
    }
  });

  // Cleanup on disconnect
  function cleanupPtySession() {
    cleanupActivePtySession(sessionName, pty, socket);
  }
  socket.on("close", cleanupPtySession);
  socket.on("error", cleanupPtySession);
}

// ─── WebSocket Message Handler ─────────────────────────────────

function handleWsMessage(socket: any, raw: Buffer): void {
  const frame = decodeFrame(raw);
  if (!frame) return;

  // Route input/resize to the correct PTY for this socket's session
  const sessionName = socketSessionMap.get(socket);

  if (frame.type === 0x00) {
    // Binary frame: keyboard input → write to PTY
    const input = frame.data.toString("utf-8");
    const normalizedInput = input.replace(/\r?\n/g, "\r");
    const pty = sessionName ? activePtySessions.get(sessionName) : undefined;
    if (pty) {
      pty.write(normalizedInput);
    }
  } else if (frame.type === 0x01) {
    // JSON control frame
    switch (frame.json.type) {
      case "ping":
        socket.send(encodeJsonFrame(sessionName ?? "pw", { type: "pong" }));
        break;
      case "resize":
        if (
          typeof frame.json.cols === "number" &&
          typeof frame.json.rows === "number"
        ) {
          const pty = sessionName
            ? activePtySessions.get(sessionName)
            : undefined;
          if (pty) {
            console.log(
              `[pi-webterm] resize PTY: session=${sessionName} cols=${frame.json.cols} rows=${frame.json.rows}`,
            );
            pty.resize(frame.json.cols, frame.json.rows);
          }
        }
        break;
      default:
        socket.close(4003, "Unknown message type");
        break;
    }
  }
}
