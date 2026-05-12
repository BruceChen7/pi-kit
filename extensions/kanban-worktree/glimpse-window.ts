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

export function openGlimpseWindow(
  html: string,
  options: GlimpseWindowOptions,
): GlimpseWindow {
  const host = getNativeHostInfo() as NativeHostInfo;
  const args = [...(host.extraArgs ?? []), ...glimpseWindowArgs(options)];
  const proc = spawn(host.path, args, {
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: process.platform === "win32",
  });
  return new PiKitGlimpseWindow(proc, html);
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

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}
