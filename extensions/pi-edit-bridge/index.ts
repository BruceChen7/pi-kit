/**
 * pi-edit-bridge — pi extension that bridges pi's autocomplete engine to an
 * external $EDITOR (Neovim) via a Unix-domain-socket JSON-RPC 2.0 server.
 *
 * Protocol: JSONL over Unix socket (one JSON object per line, \n delimited).
 * Discovery: process.env.PI_NVIM_BRIDGE = JSON { transport, path, token }.
 *
 * Usage: pi install npm:pi-nvim-bridge  (or local path)
 *  → or place this file in ~/pi-kit/extensions/pi-edit-bridge/index.ts
 *
 * Then set EDITOR=nvim, press Ctrl+G in pi, and the Neovim plugin
 * (lua/pi/edit-bridge/) connects automatically.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, unlinkSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type {
  AutocompleteItem,
  AutocompleteProvider,
} from "@earendil-works/pi-tui";
import { uiHostProfile } from "../shared/rich-ui.ts";

// ─────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────

let liveProvider: AutocompleteProvider | undefined;
/**
 * 宿主没有自动补全钩子时的宿主类型（pi-web 这类自带编辑器的宿主）：
 * RPC 调用要回一条明确的 JSON-RPC 错误，而不是让 `getProvider()` 抛未捕获异常。
 */
let unsupportedHostKind: string | undefined;
let server: ReturnType<typeof createServer> | undefined;
let socketPath: string | undefined;
let token: string | undefined;
let sessionCwd: string | undefined;

// ─────────────────────────────────────────────────────────────────────
// Provider capture
// ─────────────────────────────────────────────────────────────────────

function captureProvider(ctx: ExtensionContext): void {
  // 只有“拥有输入框”的宿主才有自动补全钩子：pi-web 这类 Web 宿主自带编辑器，
  // `addAutocompleteProvider` 是 no-op（没有编辑器可挂钩），於是桥接无法工作。
  // 这里必须留下一条明确日志，而不是让后面的 getProvider() 抛未捕获错误。
  if (!uiHostProfile(ctx).autocomplete) {
    unsupportedHostKind = uiHostProfile(ctx).kind;
    return;
  }
  ctx.ui.addAutocompleteProvider((current) => {
    liveProvider = current;
    return current; // pass-through — zero behaviour change
  });
}

function getProvider(): AutocompleteProvider | undefined {
  return liveProvider;
}

/** 拿不到补全引擎时的统一错误文案（宿主不支持 / 还没捕获到）。 */
function providerUnavailableMessage(): string {
  return unsupportedHostKind
    ? `autocomplete is not available on this host (${unsupportedHostKind})`
    : "provider not captured yet";
}

// ─────────────────────────────────────────────────────────────────────
// JSON-RPC 2.0 over JSONL
// ─────────────────────────────────────────────────────────────────────

interface RpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
}

interface RpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

interface RpcSuccessResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
}

interface RpcErrorResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

type RpcMessage = RpcRequest | RpcNotification;

/** Per-connection state machine */
interface ConnectionState {
  handshakeComplete: boolean;
  buffer: string; // partial JSONL data
}

const connections = new Map<Socket, ConnectionState>();

function onConnection(sock: Socket): void {
  const state: ConnectionState = { handshakeComplete: false, buffer: "" };
  connections.set(sock, state);

  sock.on("data", (chunk: Buffer) => onData(sock, state, chunk));
  sock.on("close", () => {
    connections.delete(sock);
  });
  sock.on("error", () => {
    sock.destroy();
    connections.delete(sock);
  });
}

function onData(sock: Socket, state: ConnectionState, chunk: Buffer): void {
  state.buffer += chunk.toString("utf-8");

  while (true) {
    const nl = state.buffer.indexOf("\n");
    if (nl === -1) break;

    const line = state.buffer.slice(0, nl);
    state.buffer = state.buffer.slice(nl + 1);
    if (!line) continue;

    let msg: RpcMessage;
    try {
      msg = JSON.parse(line) as RpcMessage;
    } catch {
      sendError(sock, null, -32700, "Parse error");
      continue;
    }

    handleMessage(sock, state, msg);
  }
}

function sendResult(
  sock: Socket,
  id: string | number | null,
  result: unknown,
): void {
  const res: RpcSuccessResponse = {
    jsonrpc: "2.0",
    id,
    result,
  };
  sock.write(`${JSON.stringify(res)}\n`);
}

function sendError(
  sock: Socket,
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): void {
  const res: RpcErrorResponse = {
    jsonrpc: "2.0",
    id,
    error: { code, message, data },
  };
  sock.write(`${JSON.stringify(res)}\n`);
}

function sendNotification(
  sock: Socket,
  method: string,
  params?: unknown,
): void {
  const notif: RpcNotification = {
    jsonrpc: "2.0",
    method,
    params,
  };
  sock.write(`${JSON.stringify(notif)}\n`);
}

function _broadcastNotification(method: string, params?: unknown): void {
  for (const [sock, state] of connections) {
    if (state.handshakeComplete) {
      sendNotification(sock, method, params);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Message handlers
// ─────────────────────────────────────────────────────────────────────

function handleMessage(
  sock: Socket,
  state: ConnectionState,
  msg: RpcMessage,
): void {
  // Notifications (no id) — not supported yet beyond commandsChanged
  if (!("id" in msg) || msg.id === undefined || msg.id === null) {
    return;
  }

  const id = msg.id;
  const { method, params } = msg as RpcRequest;

  // hello is the only method allowed before handshake
  if (!state.handshakeComplete && method !== "hello") {
    sendError(sock, id, -32000, "Handshake required: send hello first");
    return;
  }

  try {
    switch (method) {
      case "hello":
        handleHello(sock, state, id, params);
        break;
      case "ping":
        handlePing(sock, id);
        break;
      case "getSuggestions":
        handleGetSuggestions(sock, id, params);
        break;
      case "applyCompletion":
        handleApplyCompletion(sock, id, params);
        break;
      case "shouldTriggerFileCompletion":
        handleShouldTriggerFileCompletion(sock, id, params);
        break;
      case "bye":
        handleBye(sock, state, id);
        break;
      default:
        sendError(sock, id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    sendError(
      sock,
      id,
      -32603,
      `Internal error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────
// RPC handlers
// ─────────────────────────────────────────────────────────────────────

function handleHello(
  sock: Socket,
  state: ConnectionState,
  id: string | number,
  params: unknown,
): void {
  const p = params as { token?: string } | undefined;

  if (!p?.token || p.token !== token) {
    sendError(sock, id, -32600, "bad token");
    sock.end();
    return;
  }

  state.handshakeComplete = true;
  sendResult(sock, id, {
    ok: true,
    serverVersion: "0.1.0",
    cwd: sessionCwd,
    fdAvailable: false,
  });
}

function handlePing(sock: Socket, id: string | number): void {
  sendResult(sock, id, {
    ok: true,
    pid: process.pid,
    cwd: sessionCwd,
    serverVersion: "0.1.0",
  });
}

async function handleGetSuggestions(
  sock: Socket,
  id: string | number,
  params: unknown,
): Promise<void> {
  const p = params as
    | {
        lines?: string[];
        cursorLine?: number;
        cursorCol?: number;
        force?: boolean;
      }
    | undefined;

  if (
    !p ||
    !Array.isArray(p.lines) ||
    typeof p.cursorLine !== "number" ||
    typeof p.cursorCol !== "number"
  ) {
    sendError(sock, id, -32602, "Invalid params");
    return;
  }

  const provider = getProvider();
  if (!provider) {
    sendError(sock, id, -32601, providerUnavailableMessage());
    return;
  }
  const signal = new AbortController().signal; // no timeout for now

  try {
    const result = await provider.getSuggestions(
      p.lines,
      p.cursorLine,
      p.cursorCol,
      { signal, force: p.force },
    );
    sendResult(sock, id, result ?? { items: [], prefix: "" });
  } catch (err) {
    sendError(
      sock,
      id,
      -32603,
      `getSuggestions failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function handleApplyCompletion(
  sock: Socket,
  id: string | number,
  params: unknown,
): void {
  const p = params as
    | {
        lines?: string[];
        cursorLine?: number;
        cursorCol?: number;
        item?: AutocompleteItem;
        prefix?: string;
      }
    | undefined;

  if (
    !p ||
    !Array.isArray(p.lines) ||
    typeof p.cursorLine !== "number" ||
    typeof p.cursorCol !== "number" ||
    !p.item ||
    typeof p.prefix !== "string"
  ) {
    sendError(sock, id, -32602, "Invalid params");
    return;
  }

  const provider = getProvider();
  if (!provider) {
    sendError(sock, id, -32601, providerUnavailableMessage());
    return;
  }
  try {
    const result = provider.applyCompletion(
      p.lines,
      p.cursorLine,
      p.cursorCol,
      p.item,
      p.prefix,
    );
    sendResult(sock, id, result);
  } catch (err) {
    sendError(
      sock,
      id,
      -32603,
      `applyCompletion failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function handleShouldTriggerFileCompletion(
  sock: Socket,
  id: string | number,
  params: unknown,
): void {
  const p = params as
    | {
        lines?: string[];
        cursorLine?: number;
        cursorCol?: number;
      }
    | undefined;

  if (
    !p ||
    !Array.isArray(p.lines) ||
    typeof p.cursorLine !== "number" ||
    typeof p.cursorCol !== "number"
  ) {
    sendError(sock, id, -32602, "Invalid params");
    return;
  }

  const provider = getProvider();
  if (!provider) {
    sendError(sock, id, -32601, providerUnavailableMessage());
    return;
  }
  try {
    const result =
      provider.shouldTriggerFileCompletion?.(
        p.lines,
        p.cursorLine,
        p.cursorCol,
      ) ?? false;
    sendResult(sock, id, result);
  } catch (err) {
    sendError(
      sock,
      id,
      -32603,
      `shouldTriggerFileCompletion failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function handleBye(
  sock: Socket,
  state: ConnectionState,
  id: string | number,
): void {
  sendResult(sock, id, { ok: true });
  state.handshakeComplete = false;
  sock.end();
}

// ─────────────────────────────────────────────────────────────────────
// Bridge lifecycle
// ─────────────────────────────────────────────────────────────────────

const BRIDGE_ENV = "PI_NVIM_BRIDGE";

function startBridge(ctx: ExtensionContext): void {
  stopBridge(); // idempotent

  token = randomBytes(16).toString("hex"); // 32 hex chars
  socketPath = join(
    tmpdir(),
    `pi-edit-bridge-${randomBytes(8).toString("hex")}.sock`,
  );

  server = createServer(onConnection);
  server.on("error", (err: Error) => {
    console.error(`pi-edit-bridge: server error: ${err.message}`);
    stopBridge();
  });
  server.listen(socketPath);

  // Restrictive permissions (token is the real auth boundary)
  try {
    chmodSync(socketPath, 0o600);
  } catch {
    /* best-effort */
  }

  // Advertise via process.env (inherited by spawned $EDITOR)
  process.env[BRIDGE_ENV] = JSON.stringify({
    transport: "unix",
    path: socketPath,
    token,
    pid: process.pid,
    cwd: ctx.cwd,
    fdAvailable: false,
    serverVersion: "0.1.0",
  });
}

function stopBridge(): void {
  // Close all connections
  for (const [sock] of connections) {
    sock.end();
    sock.destroy();
  }
  connections.clear();

  // Close server
  if (server) {
    server.close();
    server = undefined;
  }

  // Unlink socket
  if (socketPath) {
    try {
      unlinkSync(socketPath);
    } catch {
      /* best-effort */
    }
    socketPath = undefined;
  }

  token = undefined;
  delete process.env[BRIDGE_ENV];
}

// ─────────────────────────────────────────────────────────────────────
// Extension entry point
// ─────────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    sessionCwd = ctx.cwd;
    captureProvider(ctx);
    startBridge(ctx);
  });

  pi.on("session_shutdown", () => {
    stopBridge();
  });
}
