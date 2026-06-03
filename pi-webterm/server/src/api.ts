import type { FastifyInstance } from "fastify";
import type { IPty } from "node-pty";
import { type AuthRequest, createAuthMiddleware } from "./auth.js";
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
  // Health (no auth)
  fastify.get("/api/health", async () => ({
    status: "ok",
    version: "0.1.0",
  }));

  // Setup info (no auth)
  fastify.get("/api/setup", async () => {
    const cfg = getConfig();
    return {
      publicKey: cfg.publicKey,
      tokenHint: `${cfg.token.slice(0, 8)}...`,
      host: cfg.host,
      port: cfg.port,
    };
  });

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

  fastify.get("/ws", { websocket: true }, (socket, request) => {
    auth({
      headers: { authorization: request.headers.authorization },
      query: request.query as any,
    })
      .then((ok) => {
        if (!ok) {
          fastify.log.warn({ query: request.query }, "WebSocket auth rejected");
          socket.close(4001, "Unauthorized");
          return;
        }
        handleWsConnection(socket, getConfig().tmuxSessionName);
      })
      .catch((err) => {
        fastify.log.error({ err }, "WebSocket auth error");
        socket.close(4001, "Unauthorized");
      });
  });
}

// ─── WebSocket Handler ─────────────────────────────────────────

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

  // Handle incoming WS messages
  socket.on("message", (raw: Buffer) => {
    if (raw.length === 0) return;

    const type = raw[0];

    if (type === 0x00) {
      // Binary frame: keyboard input → PTY
      const nullPos = raw.indexOf(0x00, 1);
      if (nullPos !== -1) {
        const input = raw.subarray(nullPos + 1).toString("utf-8");
        const normalizedInput = input.replace(/\r?\n/g, "\r");
        pty.write(normalizedInput);
      }
    } else if (type === 0x01) {
      // JSON control frame
      try {
        const nullPos = raw.indexOf(0x00, 1);
        if (nullPos === -1) return;
        const jsonStr = raw.subarray(nullPos + 1).toString("utf-8");
        const msg = JSON.parse(jsonStr);

        switch (msg.type) {
          case "ping":
            socket.send(JSON.stringify({ type: "pong" }));
            break;
          case "resize":
            if (typeof msg.cols === "number" && typeof msg.rows === "number") {
              pty.resize(msg.cols, msg.rows);
            }
            break;
          default:
            socket.close(4003, "Unknown message type");
            break;
        }
      } catch {
        // invalid JSON
      }
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
