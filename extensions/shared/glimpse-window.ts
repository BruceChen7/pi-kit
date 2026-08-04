import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

import { getNativeHostInfo } from "glimpseui";

type JsonRecord = Record<string, unknown>;

export type GlimpseWindow = {
  on(
    event: "message",
    handler: (message: unknown) => void | Promise<void>,
  ): void;
  send?(js: string): void;
  close?(): void;
};

export type GlimpseWindowOptions = {
  width: number;
  height: number;
  title: string;
  /**
   * Size the window grows toward once the native host reports screen
   * geometry in its `ready` message. Clamped to the visible screen area.
   * Falls back to `width`/`height` when unset or geometry is unavailable.
   */
  preferredWidth?: number;
  preferredHeight?: number;
};

type NativeHostInfo = {
  path: string;
  extraArgs?: string[];
};

type StderrWriteCallback = (error?: Error | null) => void;

type StderrWriteArgs = [
  chunk: string | Uint8Array,
  encodingOrCallback?: BufferEncoding | StderrWriteCallback,
  callback?: StderrWriteCallback,
];

const GLIMPSE_STDERR_LOG_PATH = path.join(
  process.env.HOME || process.env.USERPROFILE || "/tmp",
  ".pi",
  "agent",
  "visual-artifact",
  "glimpse-stderr.log",
);

export function openGlimpseWindow(
  html: string,
  options: GlimpseWindowOptions,
): GlimpseWindow {
  const host = getNativeHostInfo() as NativeHostInfo;
  const args = [...(host.extraArgs ?? []), ...glimpseWindowArgs(options)];
  const proc = spawn(host.path, args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: process.platform === "win32",
  });

  // Collect child process stderr for diagnostics
  const stderrChunks: Buffer[] = [];
  proc.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
  proc.on("close", () => {
    if (stderrChunks.length > 0) {
      try {
        mkdirSync(path.dirname(GLIMPSE_STDERR_LOG_PATH), { recursive: true });
        const msg = Buffer.concat(stderrChunks).toString("utf8");
        appendFileSync(
          GLIMPSE_STDERR_LOG_PATH,
          `--- ${new Date().toISOString()} ---\n${msg}\n`,
        );
      } catch {
        // Best-effort diagnostic logging
      }
    }
  });

  return new PiKitGlimpseWindow(proc, html, options);
}

export function withRedirectedOpenWindowStderr<T>(
  logPath: string,
  run: () => T,
): T {
  const originalWrite = process.stderr.write;
  process.stderr.write = ((...args: StderrWriteArgs) => {
    appendGlimpseStderr(logPath, args);
    readStderrWriteCallback(args)?.();
    return true;
  }) as typeof process.stderr.write;

  try {
    return run();
  } finally {
    process.stderr.write = originalWrite;
  }
}

function glimpseWindowArgs(options: GlimpseWindowOptions): string[] {
  return [
    "--width",
    String(options.width),
    "--height",
    String(options.height),
    "--title",
    options.title,
  ];
}

class PiKitGlimpseWindow extends EventEmitter implements GlimpseWindow {
  #pendingHtmlBase64: string | null;
  #closed = false;

  constructor(
    private readonly proc: ReturnType<typeof spawn>,
    initialHtml: string,
    private readonly options: GlimpseWindowOptions,
  ) {
    super();
    this.#pendingHtmlBase64 = Buffer.from(initialHtml).toString("base64");
    proc.stdin.on("error", () => {});
    const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => this.#handleLine(line));
    proc.on("error", (error) => this.emit("error", error));
    proc.on("exit", () => this.#markClosed());
  }

  send(js: string): void {
    this.#write({ type: "eval", js });
  }

  close(): void {
    this.#write({ type: "close" });
  }

  #handleLine(line: string): void {
    const message = parseHostMessage(line);
    if (!message) return;

    switch (message.type) {
      case "ready":
        this.#sendPendingHtml();
        this.#resizeToPreferredSize(message);
        return;
      case "message":
        this.emit("message", message.data);
        return;
      case "closed":
        this.#markClosed();
    }
  }

  #sendPendingHtml(): void {
    if (!this.#pendingHtmlBase64) return;
    this.#write({ type: "html", html: this.#pendingHtmlBase64 });
    this.#pendingHtmlBase64 = null;
  }

  #resizeToPreferredSize(message: JsonRecord): void {
    const screen = readScreenGeometry(message);
    if (!screen) return;
    const size = preferredWindowSize(this.options, screen);
    if (!size) return;
    this.#write({ type: "resize", width: size.width, height: size.height });
  }

  #write(message: JsonRecord): void {
    if (this.#closed) return;
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #markClosed(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.emit("closed");
  }
}

function parseHostMessage(line: string): JsonRecord | null {
  try {
    const message = JSON.parse(line);
    return isRecord(message) ? message : null;
  } catch {
    return null;
  }
}

function appendGlimpseStderr(logPath: string, args: StderrWriteArgs): void {
  const [chunk, encodingOrCallback] = args;
  try {
    mkdirSync(path.dirname(logPath), { recursive: true });
    if (typeof chunk === "string") {
      const encoding =
        typeof encodingOrCallback === "string" ? encodingOrCallback : "utf8";
      appendFileSync(logPath, chunk, { encoding });
      return;
    }
    appendFileSync(logPath, chunk);
  } catch {
    // Do not block opening Glimpse if diagnostic logging fails.
  }
}

function readStderrWriteCallback(
  args: StderrWriteArgs,
): StderrWriteCallback | undefined {
  const callback = args[2] ?? args[1];
  return typeof callback === "function" ? callback : undefined;
}

const MIN_WINDOW_WIDTH = 480;
const MIN_WINDOW_HEIGHT = 360;

export type ScreenGeometry = {
  visibleWidth: number;
  visibleHeight: number;
};

/**
 * Compute the resize target for a window with preferred size, clamped to
 * the visible screen area. Returns null when no resize is needed.
 */
export function preferredWindowSize(
  options: GlimpseWindowOptions,
  screen: ScreenGeometry,
): { width: number; height: number } | null {
  const { preferredWidth, preferredHeight } = options;
  if (!preferredWidth && !preferredHeight) return null;

  const width = preferredWidth
    ? Math.max(MIN_WINDOW_WIDTH, Math.min(preferredWidth, screen.visibleWidth))
    : options.width;
  const height = preferredHeight
    ? Math.max(
        MIN_WINDOW_HEIGHT,
        Math.min(preferredHeight, screen.visibleHeight),
      )
    : options.height;

  if (width === options.width && height === options.height) return null;
  return { width, height };
}

function readScreenGeometry(message: JsonRecord): ScreenGeometry | null {
  const screen = message.screen;
  if (!isRecord(screen)) return null;
  const visibleWidth = Number(screen.visibleWidth);
  const visibleHeight = Number(screen.visibleHeight);
  if (
    !Number.isFinite(visibleWidth) ||
    !Number.isFinite(visibleHeight) ||
    visibleWidth <= 0 ||
    visibleHeight <= 0
  ) {
    return null;
  }
  return { visibleWidth, visibleHeight };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}
