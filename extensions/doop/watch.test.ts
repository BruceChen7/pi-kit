import { describe, expect, it } from "vitest";
import type { Pending } from "./messages.js";
import {
  backoffDelay,
  connectWatch,
  type Schedule,
  type SocketEvent,
  type SocketLike,
  type Timer,
  type WatchState,
  watchUrl,
} from "./watch.js";

class FakeSocket implements SocketLike {
  readonly sent: string[] = [];
  closed = false;
  private listeners = new Map<string, ((event: SocketEvent) => void)[]>();

  addEventListener(type: string, listener: (event: SocketEvent) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, event: SocketEvent = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

type Harness = {
  sockets: {
    url: string;
    headers: Record<string, string>;
    socket: FakeSocket;
  }[];
  timers: { fn: () => void; ms: number; cancelled: boolean }[];
  pending: Pending[];
  states: WatchState[];
  factory: (url: string, headers: Record<string, string>) => SocketLike;
  schedule: Schedule;
};

function harness(): Harness {
  const sockets: Harness["sockets"] = [];
  const timers: Harness["timers"] = [];
  const pending: Pending[] = [];
  const states: WatchState[] = [];
  return {
    sockets,
    timers,
    pending,
    states,
    factory: (url, headers) => {
      const socket = new FakeSocket();
      sockets.push({ url, headers, socket });
      return socket;
    },
    schedule: (fn, ms) => {
      const entry = { fn, ms, cancelled: false };
      timers.push(entry);
      const timer: Timer = {
        cancel: () => {
          entry.cancelled = true;
        },
      };
      return timer;
    },
    // assigned by the caller through connectWatch
    get pendingItems() {
      return pending;
    },
  } as Harness;
}

function start(
  h: Harness,
  overrides: Partial<Parameters<typeof connectWatch>[0]> = {},
) {
  return connectWatch({
    baseUrl: "http://127.0.0.1:4300",
    canvasId: "U43rjP-JxT",
    cookie: "better-auth.session_token=abc",
    agentName: "pi",
    clientId: "client-1",
    socketFactory: h.factory,
    schedule: h.schedule,
    onPending: (item) => h.pending.push(item),
    onState: (state) => h.states.push(state),
    ...overrides,
  });
}

describe("watchUrl", () => {
  it("maps http to ws and keeps one /ws path", () => {
    expect(watchUrl("http://localhost:4300")).toBe("ws://localhost:4300/ws");
    expect(watchUrl("https://doop.example.com")).toBe(
      "wss://doop.example.com/ws",
    );
  });
});

describe("backoffDelay", () => {
  it("doubles and caps at 30s", () => {
    expect([0, 1, 2, 3].map(backoffDelay)).toEqual([1000, 2000, 4000, 8000]);
    expect(backoffDelay(12)).toBe(30_000);
  });
});

describe("connectWatch", () => {
  it("sends the cookie header and joins the room on open", () => {
    const h = harness();
    start(h);
    expect(h.sockets).toHaveLength(1);
    expect(h.sockets[0]?.headers).toEqual({
      Cookie: "better-auth.session_token=abc",
    });
    expect(h.sockets[0]?.url).toBe("ws://127.0.0.1:4300/ws");

    h.sockets[0]?.socket.emit("open");
    expect(h.states).toEqual(["connecting", "live"]);
    expect(JSON.parse(String(h.sockets[0]?.socket.sent[0]))).toEqual({
      type: "join",
      canvasId: "U43rjP-JxT",
      clientId: "client-1",
    });
  });

  it("hands a comment frame to onPending", () => {
    const h = harness();
    start(h);
    h.sockets[0]?.socket.emit("open");
    h.sockets[0]?.socket.emit("message", {
      data: JSON.stringify({
        type: "comment",
        comment: {
          id: "c1",
          text: "solid CTA",
          from: "rich",
          at: 1,
          frameId: "f1",
        },
      }),
    });
    expect(h.pending).toEqual([
      {
        kind: "comment",
        id: "c1",
        from: "rich",
        text: "solid CTA",
        frameId: "f1",
      },
    ]);
  });

  it("ignores a frame that is not valid JSON", () => {
    const h = harness();
    start(h);
    h.sockets[0]?.socket.emit("open");
    h.sockets[0]?.socket.emit("message", { data: "not json" });
    expect(h.pending).toEqual([]);
  });

  it("stops on 4401 and asks for a new login instead of retrying", () => {
    const h = harness();
    start(h);
    h.sockets[0]?.socket.emit("open");
    h.sockets[0]?.socket.emit("close", { code: 4401 });
    expect(h.states.at(-1)).toBe("auth-required");
    expect(h.timers).toHaveLength(0);
  });

  it("stops on 4403 and 4404 as a permission problem", () => {
    for (const code of [4403, 4404]) {
      const h = harness();
      start(h);
      h.sockets[0]?.socket.emit("open");
      h.sockets[0]?.socket.emit("close", { code });
      expect(h.states.at(-1)).toBe("denied");
      expect(h.timers).toHaveLength(0);
    }
  });

  it("backs off and re-joins after a dropped connection", () => {
    const h = harness();
    start(h);
    h.sockets[0]?.socket.emit("open");
    h.sockets[0]?.socket.emit("close", { code: 1006 });
    expect(h.states.at(-1)).toBe("reconnecting");
    expect(h.timers[0]?.ms).toBe(1000);

    h.timers[0]?.fn();
    expect(h.sockets).toHaveLength(2);
    h.sockets[1]?.socket.emit("open");
    expect(h.states.at(-1)).toBe("live");

    /* a successful open resets the ramp, so the next drop waits 1s again */
    h.sockets[1]?.socket.emit("close", { code: 1006 });
    expect(h.timers[1]?.ms).toBe(1000);
  });

  it("stops reconnecting after stop(), and closes the socket", () => {
    const h = harness();
    const watch = start(h);
    h.sockets[0]?.socket.emit("open");
    h.sockets[0]?.socket.emit("close", { code: 1006 });
    watch.stop();
    expect(h.timers[0]?.cancelled).toBe(true);
    expect(h.states.at(-1)).toBe("off");
    watch.stop();
    expect(h.states.filter((s) => s === "off")).toHaveLength(1);
  });

  it("closes the live socket on stop", () => {
    const h = harness();
    const watch = start(h);
    h.sockets[0]?.socket.emit("open");
    watch.stop();
    expect(h.sockets[0]?.socket.closed).toBe(true);
  });
});
