import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
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
import {
  createPwSession,
  deletePwSession,
  detectSessionStatus,
  getGitBranch,
  getTmuxSessionName,
  listPwSessions,
} from "./sessions.js";
import {
  handleTerminalQueries,
  processBinaryFrameInput,
  stripTerminalResponses,
  TerminalProtocolAdapter,
} from "./terminal-protocol-adapter.js";
import { attachToSession, capturePane, detachPty, hasSession } from "./tmux.js";
import {
  getLocalBranches,
  getWorkspaceCache,
  refreshWorkspace,
  type WorkspaceCache,
} from "./workspace.js";
import { decodeFrame, encodeBinaryFrame, encodeJsonFrame } from "./ws.js";

export { handleTerminalQueries, stripTerminalResponses };

// ─── Active PTY sessions ───────────────────────────────────────

const activePtySessions = new Map<string, IPty>();

// Maps WebSocket connection → tmux session name (for multi-session routing)
const socketSessionMap = new Map<any, string>();
const socketProtocolAdapterMap = new Map<any, TerminalProtocolAdapter>();

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
  socketProtocolAdapterMap.clear();
}

// ─── Shell escaping helper ─────────────────────────────────────

/**
 * Shell-safe single-quote escaping for tmux / git commands.
 * A single quote is replaced by the sequence `'\''` which ends the
 * current single-quoted string, inserts an escaped literal quote,
 * and resumes single-quoting.  This is the POSIX-shell way to embed
 * a single quote inside a single-quoted string.
 */
function shellEscape(value: string): string {
  return value.replace(/'/g, "'\\''");
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

      // cwd is required from the UI directory picker
      const sessionCwd = body.cwd ? resolve(body.cwd) : resolve(cfg.cwd);
      const dirname = body.dirname || basename(sessionCwd);
      const branch = body.branch || getGitBranch(sessionCwd);
      const agentCommand = body.agentCommand || cfg.agentCommand;

      // Create branch from baseBranch if it doesn't exist locally
      if (body.branch && body.baseBranch) {
        const { execSync } = await import("node:child_process");
        try {
          execSync(
            `git show-ref --verify --quiet refs/heads/${shellEscape(body.branch)} 2>/dev/null`,
            { cwd: sessionCwd, stdio: "pipe", timeout: 5000 },
          );
        } catch {
          // Branch doesn't exist — create it from baseBranch
          try {
            const safeBranch = shellEscape(body.branch);
            const safeBase = shellEscape(body.baseBranch);
            execSync(`git checkout -b ${safeBranch} ${safeBase} 2>/dev/null`, {
              cwd: sessionCwd,
              stdio: "pipe",
              timeout: 10_000,
            });
          } catch {
            // If branch creation fails, continue anyway — the agent can handle it
            console.warn(
              `[pi-webterm] Failed to create branch ${body.branch} from ${body.baseBranch} in ${sessionCwd}`,
            );
          }
        }
      }

      // Session name includes a short hash of cwd for disambiguation
      const name = getTmuxSessionName(dirname, branch, sessionCwd);

      // Check for duplicates (same dirname + branch + cwd → same hash → same tmux name)
      if (hasSession(name)) {
        // Auto-attach: return session-specific token for the existing session
        const sessionToken = generateSessionToken(cfg.username, name);
        const status = detectSessionStatus(name);
        return reply.status(200).send({
          name,
          dirname,
          branch,
          cwd: sessionCwd,
          status,
          attached: activePtySessions.has(name),
          sessionToken,
        });
      }

      // Create tmux session
      createPwSession(dirname, branch, sessionCwd, agentCommand);

      // Generate session-specific token for WS auto-attach
      const sessionToken = generateSessionToken(cfg.username, name);

      // Session was just created — always "starting".
      // The shell wrapper is still sourcing rc files before exec'ing
      // the agent; detectSessionStatus would see a shell foreground and
      // (correctly) return "starting" too, but we bypass it entirely
      // to avoid any edge cases.
      return reply.status(201).send({
        name,
        dirname,
        branch,
        cwd: sessionCwd,
        status: "starting" as const,
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

  // ── Workspace (git repo directory discovery) ─────────────────

  function toWorkspaceResponse(cache: WorkspaceCache) {
    return {
      basePath: cache.basePath,
      scannedAt: cache.scannedAt,
      directories: cache.repos.map((r) => ({
        path: r.path,
        name: r.name,
        branches: r.branches,
      })),
    };
  }

  // List discovered git repos (scan from config cwd)
  fastify.get(
    "/api/workspace/directories",
    { preHandler: authPreHandler },
    async () => {
      const cfg = getConfig();
      return toWorkspaceResponse(getWorkspaceCache(cfg.cwd));
    },
  );

  // Force-refresh workspace cache
  fastify.post(
    "/api/workspace/refresh",
    { preHandler: authPreHandler },
    async () => {
      const cfg = getConfig();
      return toWorkspaceResponse(refreshWorkspace(cfg.cwd));
    },
  );

  // Lazy-load branches for a specific repo (avoids fetching all branches upfront)
  fastify.get(
    "/api/workspace/repo/branches",
    { preHandler: authPreHandler },
    async (request: any, reply: any) => {
      const { path } = request.query as { path?: string };
      if (!path) return reply.status(400).send({ error: "path required" });

      const decodedPath = decodeURIComponent(path);
      if (!decodedPath || !existsSync(decodedPath)) {
        return reply.status(404).send({ error: "directory not found" });
      }

      const branches = getLocalBranches(decodedPath);
      return {
        path: decodedPath,
        name: decodedPath.split("/").pop() ?? decodedPath,
        branches,
      };
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

  const cleanup = () => {
    clearTimeout(authTimeout);
    socketSessionMap.delete(socket);
  };
  socket.on("close", cleanup);
  socket.on("error", cleanup);
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

  const protocolAdapter = new TerminalProtocolAdapter();
  socketProtocolAdapterMap.set(socket, protocolAdapter);

  // Forward PTY output → WebSocket
  pty.onData((data: string) => {
    try {
      const { forward, responses } = protocolAdapter.processPtyOutput(data);
      for (const response of responses) {
        try {
          pty.write(response);
        } catch {
          // PTY dead — will be cleaned up on close
        }
      }

      if (forward) {
        socket.send(encodeBinaryFrame(sessionName, Buffer.from(forward)));
      }
    } catch {
      // socket closed
    }
  });

  // When the tmux process exits (session killed, tmux crash, etc.),
  // clean up the maps and close the socket so the client doesn't
  // hang in a zombie "connected but no data" state.
  pty.onExit(() => {
    socketProtocolAdapterMap.delete(socket);
    cleanupActivePtySession(sessionName, pty, socket);
    // 4002 is a fatal close code on the client — no reconnect loop
    socket.close(4002, "Session terminated");
  });

  // Cleanup on disconnect
  function cleanupPtySession() {
    socketProtocolAdapterMap.delete(socket);
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
  const protocolAdapter = socketProtocolAdapterMap.get(socket);

  if (frame.type === 0x00) {
    // Binary frame: keyboard input → write to PTY
    const input = frame.data.toString("utf-8");
    const { cleanInput, normalizedInput, shouldDebugCtrlL } =
      processBinaryFrameInput(input, protocolAdapter);
    const pty = sessionName ? activePtySessions.get(sessionName) : undefined;
    if (shouldDebugCtrlL) {
      console.log("[pi-webterm-server] ws input ctrl+l", {
        sessionName,
        input,
        inputCodePoints: Array.from(input).map((char) => char.charCodeAt(0)),
        cleanInput,
        cleanCodePoints: Array.from(cleanInput).map((char) =>
          char.charCodeAt(0),
        ),
        normalizedInput,
        normalizedCodePoints: Array.from(normalizedInput).map((char) =>
          char.charCodeAt(0),
        ),
        hasPty: Boolean(pty),
      });
    }
    if (pty) {
      try {
        if (shouldDebugCtrlL) {
          console.log("[pi-webterm-server] pty.write ctrl+l", {
            sessionName,
            normalizedInput,
            normalizedCodePoints: Array.from(normalizedInput).map((char) =>
              char.charCodeAt(0),
            ),
          });
        }
        pty.write(normalizedInput);
      } catch (err) {
        // PTY process died (EIO) — clean up the session and close the
        // socket so the client doesn't hang in a zombie "connected
        // but no data" state.
        console.error(
          `[pi-webterm] PTY write error for session "${sessionName}":`,
          err,
        );
        if (sessionName) {
          cleanupActivePtySession(sessionName, pty, socket);
        }
        socket.close(4002, "Session terminated");
      }
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
