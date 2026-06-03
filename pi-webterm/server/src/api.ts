import type { FastifyInstance } from "fastify";
import type { IPty } from "node-pty";
import {
  type AuthRequest,
  authenticateWsMessage,
  createAuthMiddleware,
  destroySession,
  generateSessionToken,
  getBearerToken,
  validateCredentials,
  verifyWsToken,
} from "./auth.js";
import { getConfig } from "./config.js";
import {
  attachToSession,
  capturePane,
  detachPty,
  ensureSession,
  hasSession,
  killSession,
  listSessions,
} from "./tmux.js";
import { decodeFrame } from "./ws.js";

// ─── Active PTY sessions ───────────────────────────────────────

const activePtySessions = new Map<string, IPty>();

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

  // Login
  fastify.post("/api/login", async (request: any, reply: any) => {
    const { username, password } = request.body || {};
    if (!username || !password) {
      return reply
        .status(400)
        .send({ error: "Username and password are required" });
    }
    const cfg = getConfig();
    if (validateCredentials(cfg.username, cfg.password, username, password)) {
      const token = generateSessionToken(username);
      return { token, expiresIn: 86400 };
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

  // List sessions
  fastify.get("/api/sessions", { preHandler: authPreHandler }, async () => {
    const names = listSessions();
    const sessions = names.map((name) => ({
      name,
      attached: activePtySessions.has(name),
    }));
    return { sessions };
  });

  // Create session
  fastify.post(
    "/api/sessions",
    { preHandler: authPreHandler },
    async (request: any, reply: any) => {
      const { name, agentCommand } = request.body || {};
      if (!name) {
        return reply.status(400).send({ error: "name is required" });
      }
      if (hasSession(name)) {
        return reply
          .status(409)
          .send({ error: "Session already exists", name });
      }
      const cfg = getConfig();
      ensureSession(name, cfg.cwd, agentCommand || cfg.agentCommand);
      return reply.status(201).send({ name, status: "created" });
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
        attached: activePtySessions.has(name),
        recentOutput: capturePane(name, 50),
      };
    },
  );

  // Kill session
  fastify.delete(
    "/api/sessions/:name",
    { preHandler: authPreHandler },
    async (request: any, _reply: any) => {
      const { name } = request.params;
      const pty = activePtySessions.get(name);
      if (pty) {
        detachPty(pty);
        activePtySessions.delete(name);
      }
      killSession(name);
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
  const cfg = getConfig();
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
          authenticated = true;
          clearTimeout(authTimeout);
          // Start normal communication
          handleWsConnection(socket, cfg.tmuxSessionName);
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
  });

  socket.on("error", () => {
    clearTimeout(authTimeout);
  });
}

// ─── WebSocket Handler (after auth) ────────────────────────────

async function handleWsConnection(socket: any, sessionName: string) {
  const cfg = getConfig();

  // Ensure tmux session exists
  if (!hasSession(sessionName)) {
    ensureSession(sessionName, cfg.cwd, cfg.agentCommand);
  }

  // Attach to session via node-pty
  let pty: IPty;
  try {
    const session = await attachToSession(sessionName, 80, 24);
    pty = session.pty;
    activePtySessions.set(sessionName, pty);
  } catch (_err) {
    socket.send(
      JSON.stringify({ type: "error", message: "Failed to attach to session" }),
    );
    socket.close(4002, "Attach failed");
    return;
  }

  // Send status
  socket.send(
    JSON.stringify({
      type: "status",
      connected: true,
      session: sessionName,
    }),
  );

  // Send recent history
  const history = capturePane(sessionName, 200);
  if (history) {
    socket.send(
      JSON.stringify({
        type: "snapshot",
        data: Buffer.from(history).toString("base64"),
      }),
    );
  }

  // Forward PTY output → WebSocket
  pty.onData((data: string) => {
    try {
      socket.send(data);
    } catch {
      // socket closed
    }
  });

  // Cleanup on disconnect
  function cleanupPtySession() {
    detachPty(pty);
    activePtySessions.delete(sessionName);
  }
  socket.on("close", cleanupPtySession);
  socket.on("error", cleanupPtySession);
}

// ─── WebSocket Message Handler ─────────────────────────────────

function handleWsMessage(socket: any, raw: Buffer): void {
  const frame = decodeFrame(raw);
  if (!frame) return;

  if (frame.type === 0x00) {
    // Binary frame: keyboard input → write to PTY
    const input = frame.data.toString("utf-8");
    const normalizedInput = input.replace(/\r?\n/g, "\r");
    // Find the active PTY for this socket
    for (const [, pty] of activePtySessions) {
      pty.write(normalizedInput);
      break;
    }
  } else if (frame.type === 0x01) {
    // JSON control frame
    switch (frame.json.type) {
      case "ping":
        socket.send(JSON.stringify({ type: "pong" }));
        break;
      case "resize":
        if (
          typeof frame.json.cols === "number" &&
          typeof frame.json.rows === "number"
        ) {
          for (const [, pty] of activePtySessions) {
            pty.resize(frame.json.cols, frame.json.rows);
            break;
          }
        }
        break;
      default:
        socket.close(4003, "Unknown message type");
        break;
    }
  }
}
