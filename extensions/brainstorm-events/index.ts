import fs from "node:fs";
import path from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { createLogger } from "../shared/logger.ts";
import { loadSettings } from "../shared/settings.ts";

export interface BrainstormEventsConfig {
  enabled: boolean;
  debounceMs: number;
  deliverWhileBusy: "followUp" | "steer";
  maxEventsPerMessage: number;
}

export type BrowserEvent = Record<string, unknown>;

export type EventFileCursor = {
  filePath: string;
  offsetBytes: number;
};

type WatchState = EventFileCursor & {
  timer: ReturnType<typeof setTimeout> | null;
  watcher: fs.FSWatcher | null;
};

export const DEFAULT_CONFIG: BrainstormEventsConfig = {
  enabled: true,
  debounceMs: 500,
  deliverWhileBusy: "followUp",
  maxEventsPerMessage: 20,
};

type RuntimeState = {
  rootWatcher: fs.FSWatcher | null;
  discoverTimer: ReturnType<typeof setTimeout> | null;
  watches: Map<string, WatchState>;
  disposed: boolean;
};

type SendContext = Pick<ExtensionContext, "isIdle">;

const SETTINGS_KEY = "brainstormEvents";
const EVENTS_FILE_NAME = ".events";
const log = createLogger("brainstorm-events", { stderr: null });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const normalizePositiveInteger = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;

const normalizeBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

export function normalizeBrainstormEventsConfig(
  value: unknown,
): BrainstormEventsConfig {
  const settings = isRecord(value) ? value : {};
  const deliverWhileBusy =
    settings.deliverWhileBusy === "steer" ||
    settings.deliverWhileBusy === "followUp"
      ? settings.deliverWhileBusy
      : DEFAULT_CONFIG.deliverWhileBusy;

  return {
    enabled: normalizeBoolean(settings.enabled, DEFAULT_CONFIG.enabled),
    debounceMs: normalizePositiveInteger(
      settings.debounceMs,
      DEFAULT_CONFIG.debounceMs,
    ),
    deliverWhileBusy,
    maxEventsPerMessage: normalizePositiveInteger(
      settings.maxEventsPerMessage,
      DEFAULT_CONFIG.maxEventsPerMessage,
    ),
  };
}

export const loadBrainstormEventsConfig = (
  cwd: string,
): BrainstormEventsConfig => {
  const { merged } = loadSettings(cwd);
  return normalizeBrainstormEventsConfig(merged[SETTINGS_KEY]);
};

export const getBrainstormRoot = (cwd: string): string =>
  path.join(cwd, ".pi", "brainstorm");

export function parseEventsJsonl(content: string): BrowserEvent[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line);
        return isRecord(parsed) ? [parsed] : [];
      } catch {
        log.warn("invalid brainstorm event json ignored", { line });
        return [];
      }
    });
}

export function readNewEvents(state: EventFileCursor): BrowserEvent[] {
  if (!fs.existsSync(state.filePath)) {
    state.offsetBytes = 0;
    return [];
  }

  const stat = fs.statSync(state.filePath);
  if (stat.size < state.offsetBytes) {
    state.offsetBytes = 0;
  }

  if (stat.size === state.offsetBytes) {
    return [];
  }

  const fd = fs.openSync(state.filePath, "r");
  try {
    const length = stat.size - state.offsetBytes;
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, state.offsetBytes);
    state.offsetBytes = stat.size;
    return parseEventsJsonl(buffer.toString("utf-8"));
  } finally {
    fs.closeSync(fd);
  }
}

export function formatEventsMessage(events: BrowserEvent[]): string {
  return [
    "Visual Companion browser events were received.",
    "Read these as the user's latest selection/feedback and continue the brainstorming flow.",
    JSON.stringify(events, null, 2),
  ].join("\n\n");
}

export function dispatchEvents(
  pi: ExtensionAPI,
  ctx: SendContext,
  config: BrainstormEventsConfig,
  events: BrowserEvent[],
): void {
  if (events.length === 0) {
    return;
  }

  const cappedEvents = events.slice(-config.maxEventsPerMessage);
  const message = formatEventsMessage(cappedEvents);
  if (ctx.isIdle()) {
    pi.sendUserMessage(message);
    return;
  }

  pi.sendUserMessage(message, { deliverAs: config.deliverWhileBusy });
}

function currentFileSize(filePath: string): number {
  try {
    return fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  } catch {
    return 0;
  }
}

function closeWatch(state: WatchState): void {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  state.watcher?.close();
  state.watcher = null;
}

function closeRuntime(runtime: RuntimeState): void {
  runtime.disposed = true;
  if (runtime.discoverTimer) {
    clearTimeout(runtime.discoverTimer);
    runtime.discoverTimer = null;
  }
  runtime.rootWatcher?.close();
  runtime.rootWatcher = null;
  for (const state of runtime.watches.values()) {
    closeWatch(state);
  }
  runtime.watches.clear();
}

function scheduleEventRead(
  pi: ExtensionAPI,
  ctx: SendContext,
  config: BrainstormEventsConfig,
  state: WatchState,
): void {
  if (state.timer) {
    clearTimeout(state.timer);
  }

  state.timer = setTimeout(() => {
    state.timer = null;
    try {
      const events = readNewEvents(state);
      dispatchEvents(pi, ctx, config, events);
    } catch (error) {
      log.warn("failed to read brainstorm events", {
        error: error instanceof Error ? error.message : String(error),
        filePath: state.filePath,
      });
    }
  }, config.debounceMs);
}

function watchSessionDir(
  runtime: RuntimeState,
  pi: ExtensionAPI,
  ctx: SendContext,
  config: BrainstormEventsConfig,
  dirPath: string,
  replayExistingEvents: boolean,
): void {
  if (runtime.disposed || runtime.watches.has(dirPath)) {
    return;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(dirPath);
  } catch {
    return;
  }
  if (!stat.isDirectory()) {
    return;
  }

  const filePath = path.join(dirPath, EVENTS_FILE_NAME);
  const state: WatchState = {
    filePath,
    offsetBytes: replayExistingEvents ? 0 : currentFileSize(filePath),
    timer: null,
    watcher: null,
  };

  try {
    state.watcher = fs.watch(dirPath, (_eventType, filename) => {
      if (runtime.disposed || filename !== EVENTS_FILE_NAME) {
        return;
      }
      scheduleEventRead(pi, ctx, config, state);
    });
  } catch (error) {
    log.warn("failed to watch brainstorm session dir", {
      dirPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  runtime.watches.set(dirPath, state);
  if (replayExistingEvents && fs.existsSync(filePath)) {
    scheduleEventRead(pi, ctx, config, state);
  }
  log.debug("watching brainstorm session dir", { dirPath });
}

function discoverSessionDirs(
  runtime: RuntimeState,
  pi: ExtensionAPI,
  ctx: SendContext,
  config: BrainstormEventsConfig,
  brainstormRoot: string,
  replayExistingEvents: boolean,
): void {
  if (runtime.disposed) {
    return;
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(brainstormRoot);
  } catch {
    return;
  }

  for (const entry of entries) {
    watchSessionDir(
      runtime,
      pi,
      ctx,
      config,
      path.join(brainstormRoot, entry),
      replayExistingEvents,
    );
  }
}

function scheduleDiscovery(
  runtime: RuntimeState,
  pi: ExtensionAPI,
  ctx: SendContext,
  config: BrainstormEventsConfig,
  brainstormRoot: string,
): void {
  if (runtime.discoverTimer) {
    clearTimeout(runtime.discoverTimer);
  }

  runtime.discoverTimer = setTimeout(() => {
    runtime.discoverTimer = null;
    discoverSessionDirs(runtime, pi, ctx, config, brainstormRoot, true);
  }, config.debounceMs);
}

function startRuntime(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: BrainstormEventsConfig,
): RuntimeState | null {
  if (!config.enabled) {
    return null;
  }

  const brainstormRoot = getBrainstormRoot(ctx.cwd);
  const runtime: RuntimeState = {
    rootWatcher: null,
    discoverTimer: null,
    watches: new Map(),
    disposed: false,
  };

  try {
    fs.mkdirSync(brainstormRoot, { recursive: true });
    runtime.rootWatcher = fs.watch(brainstormRoot, () => {
      scheduleDiscovery(runtime, pi, ctx, config, brainstormRoot);
    });
  } catch (error) {
    log.warn("failed to watch brainstorm root", {
      brainstormRoot,
      error: error instanceof Error ? error.message : String(error),
    });
    closeRuntime(runtime);
    return null;
  }

  discoverSessionDirs(runtime, pi, ctx, config, brainstormRoot, false);
  log.debug("brainstorm events watcher started", { brainstormRoot, config });
  return runtime;
}

export default function brainstormEvents(pi: ExtensionAPI): void {
  let runtime: RuntimeState | null = null;

  pi.on("session_start", async (_event, ctx) => {
    if (runtime) {
      closeRuntime(runtime);
    }
    const config = loadBrainstormEventsConfig(ctx.cwd);
    runtime = startRuntime(pi, ctx, config);
  });

  pi.on("session_shutdown", async () => {
    if (runtime) {
      closeRuntime(runtime);
      runtime = null;
    }
  });
}
