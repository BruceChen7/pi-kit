import { describe, expect, it, vi } from "vitest";
import {
  SessionConnectionManager,
  type SessionTransport,
  type SessionTransportFactory,
} from "./session-connection-manager.js";

class FakeTransport implements SessionTransport {
  connected = false;
  disconnected = false;
  handlers: {
    onOutput?: (data: string) => void;
    onSnapshot?: (data: string) => void;
    onStatus?: (status: { connected: boolean; session: string }) => void;
  } = {};

  connect(): void {
    this.connected = true;
  }

  disconnect(): void {
    this.disconnected = true;
  }

  sendInput(_data: string): void {}

  sendResize(_cols: number, _rows: number): void {}

  emitOutput(data: string): void {
    this.handlers.onOutput?.(data);
  }
}

describe("SessionConnectionManager", () => {
  it("ignores stale output from the previous session after a switch", () => {
    const transports: FakeTransport[] = [];
    const createTransport: SessionTransportFactory = (handlers) => {
      const transport = new FakeTransport();
      transport.handlers = handlers;
      transports.push(transport);
      return transport;
    };

    const onOutput = vi.fn();
    const manager = new SessionConnectionManager({
      createTransport,
      onOutput,
    });

    manager.switchSession({
      url: "ws://localhost/ws",
      token: "token-a",
      sessionId: "session-a",
    });
    manager.switchSession({
      url: "ws://localhost/ws",
      token: "token-b",
      sessionId: "session-b",
    });

    transports[0].emitOutput("old");
    transports[1].emitOutput("new");

    expect(transports[0].disconnected).toBe(true);
    expect(onOutput).toHaveBeenCalledTimes(1);
    expect(onOutput).toHaveBeenCalledWith("new");
  });
});
