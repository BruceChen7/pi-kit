import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WsClient } from "./ws.js";

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  binaryType = "blob";
  readyState = MockWebSocket.CONNECTING;
  sent: ArrayBuffer[] = [];
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer | string }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: ArrayBuffer): void {
    this.sent.push(data);
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  close(code: number = 1000, reason: string = ""): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }
}

describe("WsClient", () => {
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.WebSocket = originalWebSocket;
  });

  it("does not reconnect after an intentional disconnect", () => {
    const client = new WsClient({
      url: "ws://localhost/ws",
      token: "session-token",
    });

    client.connect();
    expect(MockWebSocket.instances).toHaveLength(1);

    MockWebSocket.instances[0].open();
    client.disconnect();

    vi.runAllTimers();

    expect(MockWebSocket.instances).toHaveLength(1);
  });
});
