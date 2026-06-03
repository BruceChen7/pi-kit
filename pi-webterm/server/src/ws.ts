import type { IPty } from "node-pty";

// ─── Frame Types ────────────────────────────────────────────────

export const FRAME_TYPE_BINARY = 0x00;
export const FRAME_TYPE_JSON = 0x01;

// ─── Frame Encoding ────────────────────────────────────────────

/**
 * Build a frame: [type(1), sessionId\0, payload...]
 */
function buildFrame(type: number, sessionId: string, payload: Buffer): Buffer {
  const sessionIdBuf = Buffer.from(sessionId, "utf-8");
  return Buffer.concat([
    Buffer.from([type]),
    sessionIdBuf,
    Buffer.from([0x00]),
    payload,
  ]);
}

/**
 * Encode a binary frame: [0x00, sessionId\0, rawData...]
 */
export function encodeBinaryFrame(sessionId: string, data: Buffer): Buffer {
  return buildFrame(FRAME_TYPE_BINARY, sessionId, data);
}

/**
 * Encode a JSON control frame: [0x01, sessionId\0, jsonString...]
 */
export function encodeJsonFrame(sessionId: string, json: unknown): Buffer {
  return buildFrame(
    FRAME_TYPE_JSON,
    sessionId,
    Buffer.from(JSON.stringify(json), "utf-8"),
  );
}

// ─── Frame Decoding ────────────────────────────────────────────

export interface BinaryFrame {
  type: 0x00;
  sessionId: string;
  data: Buffer;
}

export interface JsonFrame {
  type: 0x01;
  sessionId: string;
  json: Record<string, unknown>;
}

export type DecodedFrame = BinaryFrame | JsonFrame | null;

/**
 * Decode a frame from raw Buffer.
 * Returns null for empty or invalid frames.
 */
export function decodeFrame(buf: Buffer): DecodedFrame {
  if (buf.length < 2) return null;

  const type = buf[0];
  if (type !== FRAME_TYPE_BINARY && type !== FRAME_TYPE_JSON) {
    return null;
  }

  // Find null terminator after sessionId
  const nullPos = buf.indexOf(0x00, 1);
  if (nullPos === -1) return null;

  const sessionId = buf.subarray(1, nullPos).toString("utf-8");
  const dataStart = nullPos + 1;

  if (type === FRAME_TYPE_BINARY) {
    return {
      type: 0x00,
      sessionId,
      data: buf.subarray(dataStart),
    };
  }

  // JSON frame
  try {
    const jsonStr = buf.subarray(dataStart).toString("utf-8");
    const json = JSON.parse(jsonStr) as Record<string, unknown>;
    return { type: 0x01, sessionId, json };
  } catch {
    return null;
  }
}

// ─── Connection Handler ─────────────────────────────────────────

export interface WsConnection {
  sessionName: string;
  pty: IPty | null;
  send: (data: Buffer) => void;
  terminate: () => void;
}

/**
 * Handle an incoming WebSocket message for a connection.
 * Dispatches based on frame type:
 * - 0x00 binary: forward to pty.write (keyboard input)
 * - 0x01 JSON: parse and handle control messages
 */
export function handleConnection(conn: WsConnection, message: Buffer): void {
  const frame = decodeFrame(message);
  if (!frame) {
    conn.terminate();
    return;
  }

  if (frame.type === FRAME_TYPE_BINARY) {
    // Keyboard input → forward to PTY
    if (conn.pty) {
      conn.pty.write(frame.data.toString("utf-8"));
    }
    return;
  }

  // JSON control frame
  const msg = frame.json;
  switch (msg.type) {
    case "ping":
      conn.send(encodeJsonFrame(conn.sessionName, { type: "pong" }));
      break;

    case "resize":
      if (typeof msg.cols === "number" && typeof msg.rows === "number") {
        conn.pty?.resize(msg.cols, msg.rows);
      }
      break;

    default:
      // Unknown message type → terminate
      conn.terminate();
      break;
  }
}

/**
 * Send terminal output to a WebSocket connection as a binary frame.
 */
export function sendOutput(conn: WsConnection, data: string | Buffer): void {
  const buf = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
  conn.send(encodeBinaryFrame(conn.sessionName, buf));
}

/**
 * Send a status update as a JSON frame.
 */
export function sendStatus(
  conn: WsConnection,
  status: { connected: boolean; session: string },
): void {
  conn.send(
    encodeJsonFrame(conn.sessionName, {
      type: "status",
      ...status,
    }),
  );
}
