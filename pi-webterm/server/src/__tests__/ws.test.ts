import { describe, expect, it, vi } from "vitest";
import {
  decodeFrame,
  encodeBinaryFrame,
  encodeJsonFrame,
  handleConnection,
} from "../ws.js";

describe("encodeBinaryFrame", () => {
  it("encodes type + sessionId + data into a Buffer", () => {
    const buf = encodeBinaryFrame("pi-agent", Buffer.from("hello\r\n"));
    // type byte (0x00)
    expect(buf[0]).toBe(0x00);
    // sessionId "pi-agent\0"
    const sessionIdEnd = buf.indexOf(0x00, 1);
    expect(buf.subarray(1, sessionIdEnd).toString()).toBe("pi-agent");
    // data after null terminator
    expect(buf.subarray(sessionIdEnd + 1).toString()).toBe("hello\r\n");
  });

  it("handles empty data", () => {
    const buf = encodeBinaryFrame("sess", Buffer.from(""));
    expect(buf[0]).toBe(0x00);
    expect(buf.toString()).toContain("sess");
  });

  it("handles single-character session name", () => {
    const buf = encodeBinaryFrame("a", Buffer.from("test"));
    expect(buf[0]).toBe(0x00);
    const sessionIdEnd = buf.indexOf(0x00, 1);
    expect(buf.subarray(1, sessionIdEnd).toString()).toBe("a");
  });

  it("includes raw bytes including ANSI escape codes", () => {
    const ansiData = Buffer.from("\x1b[32mOK\x1b[0m");
    const buf = encodeBinaryFrame("s", ansiData);
    expect(buf.subarray(buf.indexOf(0x00, 1) + 1)).toEqual(ansiData);
  });
});

describe("encodeJsonFrame", () => {
  it("encodes type + sessionId + JSON string into a Buffer", () => {
    const buf = encodeJsonFrame("pi-agent", { type: "pong" });
    expect(buf[0]).toBe(0x01);
    const sessionIdEnd = buf.indexOf(0x00, 1);
    expect(buf.subarray(1, sessionIdEnd).toString()).toBe("pi-agent");
    const jsonPart = buf.subarray(sessionIdEnd + 1).toString();
    expect(JSON.parse(jsonPart)).toEqual({ type: "pong" });
  });

  it("encodes complex JSON objects", () => {
    const buf = encodeJsonFrame("s", {
      type: "status",
      connected: true,
      session: "pi-agent",
    });
    const jsonPart = buf.subarray(buf.indexOf(0x00, 1) + 1).toString();
    const parsed = JSON.parse(jsonPart);
    expect(parsed.type).toBe("status");
    expect(parsed.connected).toBe(true);
    expect(parsed.session).toBe("pi-agent");
  });
});

describe("decodeFrame", () => {
  it("decodes a binary frame", () => {
    const frame = encodeBinaryFrame("pi-agent", Buffer.from("input data"));
    const decoded = decodeFrame(frame);
    expect(decoded).not.toBeNull();
    expect(decoded?.type).toBe(0x00);
    expect(decoded?.sessionId).toBe("pi-agent");
    expect(
      decoded && decoded.type === 0x00 ? decoded.data.toString() : null,
    ).toBe("input data");
  });

  it("decodes a JSON frame", () => {
    const frame = encodeJsonFrame("sess", { type: "ping" });
    const decoded = decodeFrame(frame);
    expect(decoded).not.toBeNull();
    expect(decoded?.type).toBe(0x01);
    expect(decoded?.sessionId).toBe("sess");
    expect(decoded && decoded.type === 0x01 ? decoded.json : null).toEqual({
      type: "ping",
    });
  });

  it("returns null for empty buffer", () => {
    expect(decodeFrame(Buffer.alloc(0))).toBeNull();
  });

  it("returns null for invalid type byte", () => {
    expect(decodeFrame(Buffer.from([0xff, 0x00]))).toBeNull();
  });
});

describe("handleConnection", () => {
  it("terminates on unknown message type", () => {
    const send = vi.fn();
    const terminate = vi.fn();
    const conn = {
      sessionName: "pi-agent",
      send,
      terminate,
      pty: null,
    } as any;

    handleConnection(conn, encodeJsonFrame("pi-agent", { type: "unknown" }));
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it("sends pong on ping", () => {
    const frames: Buffer[] = [];
    const conn = {
      sessionName: "pi-agent",
      send: (data: any) => frames.push(Buffer.from(data)),
      terminate: vi.fn(),
      pty: null,
    } as any;

    handleConnection(conn, encodeJsonFrame("pi-agent", { type: "ping" }));

    // Should send back a pong
    expect(frames.length).toBe(1);
    const decoded = decodeFrame(frames[0]);
    expect(decoded?.type).toBe(0x01);
    expect(decoded && decoded.type === 0x01 ? decoded.json : null).toEqual({
      type: "pong",
    });
  });
});
