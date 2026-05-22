import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  FILE_WATCHER_CONTROL_CHANNEL,
  type PiKitFileWatcherControlEvent,
} from "../shared/internal-events.ts";
import { createLogger } from "../shared/logger.ts";

const DEFAULT_MARKER = "#pi!";
const FILE_SIZE_LIMIT_BYTES = 1_048_576;
const WATCH_DEBOUNCE_MS = 300;
const WATCH_USAGE =
  "Usage: /watch start [path] | stop [path] | status | marker <marker> | cancel [path]";
const WATCH_MARKER_USAGE = "Usage: /watch marker <marker>";

const DEFAULT_IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "coverage",
  "__pycache__",
  ".cache",
  ".turbo",
  ".svelte-kit",
  "out",
  ".output",
  ".vercel",
  ".netlify",
]);

export interface ParsedPrompt {
  text: string;
  delayMs: number;
  lineNumber: number;
}

type DeferredJob = {
  filePath: string;
  timer: ReturnType<typeof setTimeout>;
  prompts: ParsedPrompt[];
  fireAt: number;
};

type WatcherState = {
  watchedPaths: Map<string, fs.FSWatcher>;
  pendingRestart: Set<string>;
  activeMarker: string;
  debounceTimers: Map<string, ReturnType<typeof setTimeout>>;
  ignoredDirs: Set<string>;
  deferredJobs: Map<string, DeferredJob>;
};

export type FileChangePlan = {
  immediate: ParsedPrompt[];
  deferred: ParsedPrompt[];
};

export type DeferredPromptPlan = {
  prompts: ParsedPrompt[];
  delayMs: number;
  fireAt: number;
};

export type WatchCommand =
  | { kind: "start"; path: string }
  | { kind: "stop"; path?: string }
  | { kind: "status" }
  | { kind: "cancel"; path?: string }
  | { kind: "marker"; marker?: string }
  | { kind: "help" };

type NotifyLevel = "info" | "warning" | "error";

type EventBus = {
  on?: (channel: string, handler: (event: unknown) => void) => void;
};

let log: ReturnType<typeof createLogger> | null = null;

const SPECIAL_REGEX_CHARS = /[.*+?^${}()|[\]\\]/g;
// Matches relative delay specs such as 30s, 5m, 2h, or 1h30m.
const RELATIVE_DELAY = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i;
// Matches absolute local clock specs such as 09:30 or 18:00.
const ABSOLUTE_DELAY = /^(\d{1,2}):(\d{2})$/;
// Matches block-comment continuation lines like ` * foo`.
const JSDOC_CONTINUATION = /^\s*\*\s/;

function isIgnored(filePath: string, ignoredDirs: Set<string>): boolean {
  return filePath.split(path.sep).some((part) => ignoredDirs.has(part));
}

function escapeRegExp(value: string): string {
  return value.replace(SPECIAL_REGEX_CHARS, "\\$&");
}

export function buildMarkerRegex(marker: string): RegExp {
  const escaped = escapeRegExp(marker);
  // Captures optional comment prefix, prompt text, marker, and optional @delay suffix.
  return new RegExp(
    `^\\s*(?:\\/\\/|#|--|;+|\\*|\\/\\*|<!--)?\\s*(.*?)\\s*${escaped}` +
      `(?:\\s+@([\\w:]+))?\\s*$`,
    "i",
  );
}

export function parseDelay(
  spec: string,
  now = (): number => Date.now(),
): number | null {
  const relative = spec.match(RELATIVE_DELAY);
  if (relative && (relative[1] || relative[2] || relative[3])) {
    const hours = Number.parseInt(relative[1] ?? "0", 10);
    const minutes = Number.parseInt(relative[2] ?? "0", 10);
    const seconds = Number.parseInt(relative[3] ?? "0", 10);
    return (hours * 3600 + minutes * 60 + seconds) * 1000;
  }

  const absolute = spec.match(ABSOLUTE_DELAY);
  if (!absolute) {
    return null;
  }

  const hours = Number.parseInt(absolute[1], 10);
  const minutes = Number.parseInt(absolute[2], 10);
  if (hours > 23 || minutes > 59) {
    return null;
  }

  const currentMs = now();
  const target = new Date(currentMs);
  target.setHours(hours, minutes, 0, 0);
  if (target.getTime() <= currentMs) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime() - currentMs;
}

function isJsDocContinuationLine(line: string): boolean {
  return JSDOC_CONTINUATION.test(line);
}

export function parsePrompts(content: string, marker: string): ParsedPrompt[] {
  const regex = buildMarkerRegex(marker);
  const results: ParsedPrompt[] = [];

  for (const [index, line] of content.split("\n").entries()) {
    if (isJsDocContinuationLine(line)) {
      continue;
    }

    const match = regex.exec(line.trimEnd());
    if (!match) {
      continue;
    }

    const text = match[1].trim();
    if (!text) {
      continue;
    }

    const delayMs = match[2] ? (parseDelay(match[2]) ?? 0) : 0;
    results.push({ text, delayMs, lineNumber: index + 1 });
  }

  return results;
}

export function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 512).includes(0);
}

function groupPromptsBySchedule(prompts: ParsedPrompt[]): FileChangePlan {
  const immediate: ParsedPrompt[] = [];
  const deferred: ParsedPrompt[] = [];

  for (const prompt of prompts) {
    if (prompt.delayMs === 0) {
      immediate.push(prompt);
    } else {
      deferred.push(prompt);
    }
  }

  return { immediate, deferred };
}

export function planFileChange(
  content: string,
  marker: string,
): FileChangePlan {
  return groupPromptsBySchedule(parsePrompts(content, marker));
}

export function planDeferredPrompts(
  deferred: ParsedPrompt[],
  nowMs = Date.now(),
): DeferredPromptPlan {
  const delayMs = Math.max(...deferred.map((prompt) => prompt.delayMs));
  return {
    prompts: deferred,
    delayMs,
    fireAt: nowMs + delayMs,
  };
}

export function parseWatchCommand(args: string | undefined): WatchCommand {
  const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);

  switch (parts[0]) {
    case "start":
      return { kind: "start", path: parts[1] ?? "." };
    case "stop":
      return { kind: "stop", path: parts[1] };
    case "status":
      return { kind: "status" };
    case "cancel":
      return { kind: "cancel", path: parts[1] };
    case "marker":
      return { kind: "marker", marker: parts[1] };
    default:
      return { kind: "help" };
  }
}

function notify(
  ctx: ExtensionContext | null,
  message: string,
  level: NotifyLevel,
): void {
  if (ctx?.hasUI) {
    ctx.ui.notify(message, level);
    return;
  }

  log?.info(message, { level });
}

function resolveWatchPath(rawPath: string, cwd?: string): string {
  return path.resolve(cwd ?? process.cwd(), rawPath);
}

function isSameOrChildPath(filePath: string, parentPath: string): boolean {
  const relative = path.relative(parentPath, filePath);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function cancelDeferredJob(filePath: string, state: WatcherState): void {
  const job = state.deferredJobs.get(filePath);
  if (!job) {
    return;
  }

  clearTimeout(job.timer);
  state.deferredJobs.delete(filePath);
}

function closeWatchers(watchers: Iterable<fs.FSWatcher>): void {
  for (const watcher of watchers) {
    try {
      watcher.close();
    } catch (error) {
      log?.debug("failed to close watcher", { error: String(error) });
    }
  }
}

function clearTimers(timers: Iterable<ReturnType<typeof setTimeout>>): void {
  for (const timer of timers) {
    clearTimeout(timer);
  }
}

function clearDeferredJobs(jobs: Iterable<DeferredJob>): void {
  for (const job of jobs) {
    clearTimeout(job.timer);
  }
}

function closeAllWatchers(state: WatcherState): void {
  for (const watchedPath of state.watchedPaths.keys()) {
    state.pendingRestart.add(watchedPath);
  }

  closeWatchers(state.watchedPaths.values());

  state.watchedPaths.clear();
  clearTimers(state.debounceTimers.values());
  state.debounceTimers.clear();
}

export function formatPromptMessage(
  prompts: ParsedPrompt[],
  filePath: string,
  marker: string,
): string {
  const instruction = prompts.map(formatPromptInstruction).join("\n");
  return (
    `File: ${filePath}\n\n${instruction}\n\n` +
    `After completing the above, remove the \`${marker}\` comment(s) from the file.`
  );
}

function formatPromptInstruction(prompt: ParsedPrompt): string {
  return `Line ${prompt.lineNumber}: ${prompt.text}`;
}

function formatPromptPreview(prompt: ParsedPrompt): string {
  return prompt.text.slice(0, 60) + (prompt.text.length > 60 ? "…" : "");
}

function submitPrompts(
  prompts: ParsedPrompt[],
  filePath: string,
  state: WatcherState,
  ctx: ExtensionContext | null,
  pi: ExtensionAPI,
): void {
  closeAllWatchers(state);

  const message = formatPromptMessage(prompts, filePath, state.activeMarker);
  const preview = formatPromptPreview(prompts[0]);
  const basename = path.basename(filePath);

  if (!ctx || ctx.isIdle()) {
    notify(ctx, `Prompt detected in ${basename}: ${preview}`, "info");
    pi.sendUserMessage(message);
    return;
  }

  notify(ctx, `Prompt queued (agent is busy): ${preview}`, "info");
  pi.sendUserMessage(message, { deliverAs: "followUp" });
}

function formatDelay(delayMs: number): string {
  if (delayMs < 60_000) {
    return `${Math.round(delayMs / 1000)}s`;
  }

  const minutes = Math.round(delayMs / 60_000);
  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function handleFileChange(
  filePath: string,
  state: WatcherState,
  ctx: ExtensionContext | null,
  pi: ExtensionAPI,
): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return;
  }

  if (!stat.isFile() || stat.size > FILE_SIZE_LIMIT_BYTES) {
    return;
  }

  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch {
    return;
  }

  if (isBinary(buffer)) {
    return;
  }

  const plan = planFileChange(buffer.toString("utf-8"), state.activeMarker);
  cancelDeferredJob(filePath, state);

  if (plan.immediate.length === 0 && plan.deferred.length === 0) {
    return;
  }

  if (plan.immediate.length > 0) {
    submitPrompts(plan.immediate, filePath, state, ctx, pi);
  }

  if (plan.deferred.length === 0) {
    return;
  }

  const deferredPlan = planDeferredPrompts(plan.deferred);
  const timer = setTimeout(() => {
    state.deferredJobs.delete(filePath);
    submitPrompts(deferredPlan.prompts, filePath, state, null, pi);
  }, deferredPlan.delayMs);

  state.deferredJobs.set(filePath, {
    filePath,
    timer,
    prompts: plan.deferred,
    fireAt: deferredPlan.fireAt,
  });

  notify(
    ctx,
    `${plan.deferred.length} prompt(s) in ${path.basename(filePath)} scheduled in ${formatDelay(deferredPlan.delayMs)}`,
    "info",
  );
}

function openWatcher(
  absPath: string,
  state: WatcherState,
  ctx: ExtensionContext | null,
  pi: ExtensionAPI,
): void {
  const eventHandler = (_eventType: string, filename: string | null) => {
    if (!filename) {
      return;
    }

    const filePath = path.join(absPath, filename);
    if (isIgnored(filePath, state.ignoredDirs)) {
      return;
    }

    const existing = state.debounceTimers.get(filePath);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      state.debounceTimers.delete(filePath);
      handleFileChange(filePath, state, ctx, pi);
    }, WATCH_DEBOUNCE_MS);

    state.debounceTimers.set(filePath, timer);
  };

  try {
    state.watchedPaths.set(
      absPath,
      fs.watch(absPath, { recursive: true }, eventHandler),
    );
  } catch {
    try {
      state.watchedPaths.set(
        absPath,
        fs.watch(absPath, { recursive: false }, eventHandler),
      );
      notify(
        ctx,
        "Recursive watch unavailable; watching top-level only",
        "warning",
      );
    } catch (error) {
      notify(ctx, `Failed to watch ${absPath}: ${String(error)}`, "error");
    }
  }
}

function reopenAllWatchers(
  state: WatcherState,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): void {
  for (const absPath of state.pendingRestart) {
    openWatcher(absPath, state, ctx, pi);
  }
  state.pendingRestart.clear();
}

function formatControlSourceSuffix(source: string | undefined): string {
  return source ? ` (source: ${source})` : "";
}

function startWatching(
  rawPath: string,
  state: WatcherState,
  ctx: ExtensionContext | null,
  pi: ExtensionAPI,
  source?: string,
): void {
  const absPath = resolveWatchPath(rawPath, ctx?.cwd);

  if (!fs.existsSync(absPath)) {
    notify(ctx, `Path not found: ${absPath}`, "error");
    return;
  }

  if (state.watchedPaths.has(absPath)) {
    notify(ctx, `Already watching ${absPath}`, "warning");
    return;
  }

  openWatcher(absPath, state, ctx, pi);
  notify(
    ctx,
    `Watching ${absPath} (marker: ${state.activeMarker})${formatControlSourceSuffix(source)}`,
    "info",
  );
}

function stopWatching(
  rawPath: string | undefined,
  state: WatcherState,
  ctx: ExtensionContext | null,
  source?: string,
): void {
  if (!rawPath) {
    closeWatchers(state.watchedPaths.values());
    state.watchedPaths.clear();
    clearTimers(state.debounceTimers.values());
    state.debounceTimers.clear();
    clearDeferredJobs(state.deferredJobs.values());
    state.deferredJobs.clear();
    notify(
      ctx,
      `Stopped watching all paths${formatControlSourceSuffix(source)}`,
      "info",
    );
    return;
  }

  const absPath = resolveWatchPath(rawPath, ctx?.cwd);
  const watcher = state.watchedPaths.get(absPath);
  if (!watcher) {
    notify(ctx, `Not currently watching ${absPath}`, "warning");
    return;
  }

  try {
    watcher.close();
  } catch (error) {
    log?.debug("failed to close watcher", { error: String(error) });
  }

  state.watchedPaths.delete(absPath);
  for (const [filePath, timer] of state.debounceTimers) {
    if (isSameOrChildPath(filePath, absPath)) {
      clearTimeout(timer);
      state.debounceTimers.delete(filePath);
    }
  }
  for (const [filePath, job] of state.deferredJobs) {
    if (isSameOrChildPath(filePath, absPath)) {
      clearTimeout(job.timer);
      state.deferredJobs.delete(filePath);
    }
  }

  notify(
    ctx,
    `Stopped watching ${absPath}${formatControlSourceSuffix(source)}`,
    "info",
  );
}

function createWatcherState(
  marker: string,
  extraIgnore: string | undefined,
): WatcherState {
  const ignoredDirs = new Set(DEFAULT_IGNORED_DIRS);
  for (const dir of (extraIgnore ?? "").split(",")) {
    const trimmed = dir.trim();
    if (trimmed) {
      ignoredDirs.add(trimmed);
    }
  }

  return {
    watchedPaths: new Map(),
    pendingRestart: new Set(),
    activeMarker: marker,
    debounceTimers: new Map(),
    ignoredDirs,
    deferredJobs: new Map(),
  };
}

function getAutoWatchPath(): string | null {
  const watchArgIndex = process.argv.indexOf("--watch");
  if (watchArgIndex === -1) {
    return null;
  }

  const next = process.argv[watchArgIndex + 1];
  return next && !next.startsWith("-") ? next : ".";
}

function formatDeferredJob(job: DeferredJob): string {
  const remainingSeconds = Math.max(
    0,
    Math.round((job.fireAt - Date.now()) / 1000),
  );
  const hours = Math.floor(remainingSeconds / 3600);
  const minutes = Math.floor((remainingSeconds % 3600) / 60);
  const seconds = remainingSeconds % 60;
  const remaining =
    hours > 0
      ? `${hours}h ${minutes}m`
      : minutes > 0
        ? `${minutes}m ${seconds}s`
        : `${seconds}s`;
  return `  ${path.basename(job.filePath)} — fires in ${remaining}`;
}

function notifyStatus(state: WatcherState, ctx: ExtensionContext): void {
  const lines: string[] = [];
  if (state.watchedPaths.size > 0) {
    const paths = [...state.watchedPaths.keys()].join("\n  ");
    lines.push(
      `Watching ${state.watchedPaths.size} path(s) (marker: ${state.activeMarker}):\n  ${paths}`,
    );
  }

  if (state.deferredJobs.size > 0) {
    const jobs = [...state.deferredJobs.values()].map(formatDeferredJob);
    lines.push(
      `Pending deferred jobs (${state.deferredJobs.size}):\n${jobs.join("\n")}`,
    );
  }

  if (lines.length === 0) {
    ctx.ui.notify("Not watching any paths. Use /watch start to begin.", "info");
    return;
  }

  ctx.ui.notify(lines.join("\n\n"), "info");
}

function cancelDeferredJobs(
  rawPath: string | undefined,
  state: WatcherState,
  ctx: ExtensionContext,
): void {
  if (!rawPath) {
    if (state.deferredJobs.size === 0) {
      ctx.ui.notify("No pending deferred jobs.", "info");
      return;
    }

    const count = state.deferredJobs.size;
    for (const job of state.deferredJobs.values()) {
      clearTimeout(job.timer);
    }
    state.deferredJobs.clear();
    ctx.ui.notify(`Cancelled ${count} deferred job(s).`, "info");
    return;
  }

  const absPath = resolveWatchPath(rawPath, ctx.cwd);
  const job = state.deferredJobs.get(absPath);
  if (!job) {
    ctx.ui.notify(`No pending deferred job for ${absPath}`, "warning");
    return;
  }

  clearTimeout(job.timer);
  state.deferredJobs.delete(absPath);
  ctx.ui.notify(`Cancelled deferred job for ${path.basename(absPath)}`, "info");
}

function cleanupState(state: WatcherState): void {
  closeWatchers(state.watchedPaths.values());
  clearTimers(state.debounceTimers.values());
  clearDeferredJobs(state.deferredJobs.values());

  state.watchedPaths.clear();
  state.debounceTimers.clear();
  state.deferredJobs.clear();
  state.pendingRestart.clear();
}

function isFileWatcherControlEvent(
  value: unknown,
): value is PiKitFileWatcherControlEvent {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    "type" in value &&
    ((value as { type?: unknown }).type === "file-watcher.start" ||
      (value as { type?: unknown }).type === "file-watcher.stop")
  );
}

function registerFileWatcherControlEvents(
  pi: ExtensionAPI,
  state: WatcherState,
): void {
  const eventBus = pi.events as EventBus | undefined;
  eventBus?.on?.(FILE_WATCHER_CONTROL_CHANNEL, (event) => {
    if (!isFileWatcherControlEvent(event)) {
      return;
    }

    const ctx = event.ctx as ExtensionContext | null;
    if (event.type === "file-watcher.start") {
      state.activeMarker = event.marker ?? state.activeMarker;
      startWatching(event.path, state, ctx, pi, event.source);
      return;
    }

    stopWatching(event.path, state, ctx, event.source);
  });
}

export default function (pi: ExtensionAPI) {
  log = createLogger("file-watcher", { stderr: null });

  pi.registerFlag("marker", {
    description: `Trigger marker for file-watcher (default: "${DEFAULT_MARKER}")`,
    type: "string",
    default: DEFAULT_MARKER,
  });
  pi.registerFlag("watch", {
    description: "Auto-start watching on launch. Optionally specify a path.",
    type: "string",
  });
  pi.registerFlag("ignore", {
    description:
      "Extra directories to ignore, comma-separated and merged with defaults.",
    type: "string",
  });

  const marker =
    (pi.getFlag("--marker") as string | undefined) ?? DEFAULT_MARKER;
  const extraIgnore = pi.getFlag("--ignore") as string | undefined;
  const state = createWatcherState(marker, extraIgnore);
  registerFileWatcherControlEvents(pi, state);

  const autoWatchPath = getAutoWatchPath();
  if (autoWatchPath) {
    startWatching(autoWatchPath, state, null, pi);
  }

  pi.on("agent_end", async (_event, ctx) => {
    if (state.pendingRestart.size > 0) {
      reopenAllWatchers(state, ctx, pi);
    }
  });

  pi.on("session_shutdown", async () => {
    cleanupState(state);
  });

  pi.registerCommand("watch", {
    description: `Control file watching. ${WATCH_USAGE}`,
    handler: async (args, ctx) => {
      const command = parseWatchCommand(args);

      switch (command.kind) {
        case "start":
          startWatching(command.path, state, ctx, pi);
          break;
        case "stop":
          stopWatching(command.path, state, ctx);
          break;
        case "status":
          notifyStatus(state, ctx);
          break;
        case "cancel":
          cancelDeferredJobs(command.path, state, ctx);
          break;
        case "marker":
          if (!command.marker) {
            ctx.ui.notify(WATCH_MARKER_USAGE, "warning");
            return;
          }
          state.activeMarker = command.marker;
          ctx.ui.notify(`Trigger marker set to: ${command.marker}`, "info");
          break;
        default:
          ctx.ui.notify(WATCH_USAGE, "info");
          break;
      }
    },
  });
}
