/**
 * Shell: the canvas WebSocket. One connection, one room, reconnects on its own.
 *
 * Auth is a session cookie, which the browser transport cannot set — Node's
 * WebSocket takes undici options, so the cookie rides the upgrade request the
 * same way the web client sends it.
 */

import { type Pending, pendingFromMessage } from "./messages.js";

export type WatchState =
  | "off"
  | "connecting"
  | "live"
  | "reconnecting"
  | "auth-required"
  | "denied";

export type SocketEvent = { data?: unknown; code?: number };

export type SocketLike = {
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: SocketEvent) => void): void;
};

/** `headers` is undici's extension to the WHATWG constructor. */
export type SocketFactory = (
  url: string,
  headers: Record<string, string>,
) => SocketLike;

export type Timer = { cancel(): void };
export type Schedule = (fn: () => void, ms: number) => Timer;

export const CLOSE_UNAUTHORIZED = 4401;
export const CLOSE_FORBIDDEN = 4403;
export const CLOSE_NOT_FOUND = 4404;

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;

export function watchUrl(baseUrl: string): string {
  return `${baseUrl.replace(/^http/, "ws")}/ws`;
}

/** 1s, 2s, 4s … capped: a doop restart should not need a manual /doop watch. */
export function backoffDelay(attempt: number): number {
  return Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
}

/**
 * Node's WebSocket accepts `{ headers }` (undici), which is the only way to
 * send the session cookie on the upgrade. TypeScript's DOM signature does not
 * know about it, so the cast happens here and nowhere else.
 */
const nodeSocket: SocketFactory = (url, headers) => {
  const Ctor = WebSocket as unknown as new (
    url: string,
    options: { headers: Record<string, string> },
  ) => SocketLike;
  return new Ctor(url, { headers });
};

const defaultSchedule: Schedule = (fn, ms) => {
  const handle = setTimeout(fn, ms);
  return { cancel: () => clearTimeout(handle) };
};

export type WatchOptions = {
  baseUrl: string;
  canvasId: string;
  cookie: string;
  agentName: string;
  onPending: (item: Pending) => void;
  onState: (state: WatchState) => void;
  socketFactory?: SocketFactory;
  schedule?: Schedule;
  clientId?: string;
};

export function connectWatch(options: WatchOptions): { stop: () => void } {
  const socketFactory = options.socketFactory ?? nodeSocket;
  const schedule = options.schedule ?? defaultSchedule;
  const clientId = options.clientId ?? Math.random().toString(36).slice(2, 10);
  const url = watchUrl(options.baseUrl);

  let stopped = false;
  let attempt = 0;
  let socket: SocketLike | undefined;
  let timer: Timer | undefined;

  const state = (next: WatchState): void => {
    if (!stopped) options.onState(next);
  };

  const join = (): void => {
    socket?.send(
      JSON.stringify({ type: "join", canvasId: options.canvasId, clientId }),
    );
  };

  const reopen = (): void => {
    timer = undefined;
    if (stopped) return;
    state(attempt === 0 ? "connecting" : "reconnecting");
    let current: SocketLike;
    try {
      current = socketFactory(url, { Cookie: options.cookie });
    } catch {
      retry("socket could not be created");
      return;
    }
    socket = current;
    current.addEventListener("open", () => {
      attempt = 0;
      state("live");
      join();
    });
    current.addEventListener("message", (event) => {
      if (stopped) return;
      const raw = typeof event.data === "string" ? event.data : undefined;
      if (!raw) return;
      let frame: unknown;
      try {
        frame = JSON.parse(raw);
      } catch {
        return;
      }
      const item = pendingFromMessage(frame, options.agentName);
      if (item) options.onPending(item);
    });
    current.addEventListener("close", (event) => {
      if (stopped) return;
      socket = undefined;
      /* 4401 means the cookie expired or was revoked: retrying cannot help, so
         say so instead of hammering the server with the same bad cookie. */
      if (event.code === CLOSE_UNAUTHORIZED) {
        state("auth-required");
        return;
      }
      if (event.code === CLOSE_FORBIDDEN || event.code === CLOSE_NOT_FOUND) {
        state("denied");
        return;
      }
      retry(`closed (${event.code ?? "?"})`);
    });
    current.addEventListener("error", () => {
      /* close follows error; reconnecting is decided there */
    });
  };

  const retry = (_reason: string): void => {
    if (stopped) return;
    const delay = backoffDelay(attempt);
    attempt += 1;
    state("reconnecting");
    timer = schedule(reopen, delay);
  };

  reopen();

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      timer?.cancel();
      timer = undefined;
      socket?.close();
      socket = undefined;
      options.onState("off");
    },
  };
}
