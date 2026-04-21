import { spawn } from "node-pty";

import type { KanbanTerminalEvent } from "../extensions/kanban-orchestrator/runtime-state.js";

export type ManagedPtyExitEvent = {
  exitCode: number | null;
  signal: number | null;
};

export type ManagedPty = {
  pid: number;
  write(data: string): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): DisposableLike;
  onExit(listener: (event: ManagedPtyExitEvent) => void): DisposableLike;
};

export type DisposableLike =
  | undefined
  | (() => void)
  | {
      dispose(): void;
    };

export type PtyShellFactory = (input: {
  cwd: string;
  shell: string;
  env: NodeJS.ProcessEnv;
}) => ManagedPty | Promise<ManagedPty>;

export type PtySessionStartResult = {
  shellPid: number | null;
};

export type PtySessionExitInfo = {
  requirementId: string;
  sessionId: string;
  exitCode: number | null;
  signal: number | null;
  reason: "shell-exit" | "restart" | "daemon-shutdown" | "error";
  finishedAt: string;
};

export type RequirementTerminalSnapshot = {
  status: "idle" | "live" | "exited" | "error";
  writable: boolean;
  shellAlive: boolean;
  summary: string | null;
  lastExitCode: number | null;
};

type PtyRuntime = {
  requirementId: string;
  sessionId: string;
  shell: ManagedPty;
  status: "live" | "exited" | "error";
  writable: boolean;
  shellAlive: boolean;
  summary: string | null;
  lastExitCode: number | null;
  startedAt: string;
  finishedAt: string | null;
  chunks: string[];
  pendingExitReason: PtySessionExitInfo["reason"] | null;
  exitPromise: Promise<void>;
  resolveExit: () => void;
  disposers: Array<() => void>;
};

function disposeListener(listener: DisposableLike): () => void {
  if (typeof listener === "function") {
    return listener;
  }
  if (listener && typeof listener.dispose === "function") {
    return () => {
      listener.dispose();
    };
  }
  return () => {};
}

function resolveShellBinary(): string {
  return (
    process.env.SHELL?.trim() ||
    (process.platform === "win32" ? "powershell.exe" : "/bin/bash")
  );
}

export function createNodePtyShellFactory(): PtyShellFactory {
  return ({ cwd, shell, env }) =>
    spawn(shell, process.platform === "win32" ? [] : ["-i"], {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      cwd,
      env,
    });
}

export class PtySessionManager {
  private readonly sessions = new Map<string, PtyRuntime>();

  private readonly listeners = new Map<
    string,
    Set<(event: KanbanTerminalEvent) => void>
  >();

  private readonly createShell: PtyShellFactory;

  private readonly now: () => string;

  private readonly onSessionExit: (info: PtySessionExitInfo) => void;

  constructor(input?: {
    createShell?: PtyShellFactory;
    now?: () => string;
    onSessionExit?: (info: PtySessionExitInfo) => void;
  }) {
    this.createShell = input?.createShell ?? createNodePtyShellFactory();
    this.now = input?.now ?? (() => new Date().toISOString());
    this.onSessionExit = input?.onSessionExit ?? (() => {});
  }

  hasLiveSession(requirementId: string): boolean {
    return this.sessions.get(requirementId)?.status === "live";
  }

  getSnapshot(requirementId: string): RequirementTerminalSnapshot {
    const runtime = this.sessions.get(requirementId);
    if (!runtime) {
      return {
        status: "idle",
        writable: false,
        shellAlive: false,
        summary: null,
        lastExitCode: null,
      };
    }

    return {
      status: runtime.status,
      writable: runtime.writable,
      shellAlive: runtime.shellAlive,
      summary: runtime.summary,
      lastExitCode: runtime.lastExitCode,
    };
  }

  subscribe(
    requirementId: string,
    listener: (event: KanbanTerminalEvent) => void,
  ): () => void {
    const runtime = this.sessions.get(requirementId);
    if (runtime) {
      listener({
        type: "ready",
        cardId: requirementId,
        ts: runtime.startedAt,
        protocol: "sse-text-stream",
      });
      for (const chunk of runtime.chunks) {
        listener({
          type: "chunk",
          cardId: requirementId,
          ts: runtime.startedAt,
          chunk,
        });
      }
      if (runtime.status === "exited") {
        listener({
          type: "exit",
          cardId: requirementId,
          ts: runtime.finishedAt ?? runtime.startedAt,
          summary: runtime.summary ?? "Shell exited",
          exitCode: runtime.lastExitCode,
        });
      }
      if (runtime.status === "error") {
        listener({
          type: "error",
          cardId: requirementId,
          ts: runtime.finishedAt ?? runtime.startedAt,
          error: runtime.summary ?? "Shell exited with error",
        });
      }
    }

    let listeners = this.listeners.get(requirementId);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(requirementId, listeners);
    }
    listeners.add(listener);

    return () => {
      const current = this.listeners.get(requirementId);
      current?.delete(listener);
      if (current && current.size === 0) {
        this.listeners.delete(requirementId);
      }
    };
  }

  async startSession(input: {
    requirementId: string;
    sessionId: string;
    cwd: string;
    command: string;
  }): Promise<PtySessionStartResult> {
    const shell = await this.createShell({
      cwd: input.cwd,
      shell: resolveShellBinary(),
      env: {
        ...process.env,
        TERM: process.env.TERM || "xterm-256color",
      },
    });
    const startedAt = this.now();

    let resolveExit!: () => void;
    const exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });

    const runtime: PtyRuntime = {
      requirementId: input.requirementId,
      sessionId: input.sessionId,
      shell,
      status: "live",
      writable: true,
      shellAlive: true,
      summary: `Shell running in ${input.cwd}`,
      lastExitCode: null,
      startedAt,
      finishedAt: null,
      chunks: [],
      pendingExitReason: null,
      exitPromise,
      resolveExit,
      disposers: [],
    };

    const readiness = this.waitForShellReady(shell);
    runtime.disposers.push(
      disposeListener(
        shell.onData((chunk) => {
          runtime.chunks = [...runtime.chunks, chunk].slice(-500);
          this.emit(input.requirementId, {
            type: "chunk",
            cardId: input.requirementId,
            ts: this.now(),
            chunk,
          });
        }),
      ),
    );
    runtime.disposers.push(
      disposeListener(
        shell.onExit((event) => {
          void this.handleExit(runtime, event);
        }),
      ),
    );

    this.sessions.set(input.requirementId, runtime);
    this.emit(input.requirementId, {
      type: "ready",
      cardId: input.requirementId,
      ts: startedAt,
      protocol: "sse-text-stream",
    });

    await readiness;
    shell.write(`${input.command}\r`);

    return {
      shellPid: Number.isFinite(shell.pid) ? shell.pid : null,
    };
  }

  async sendInput(requirementId: string, input: string): Promise<void> {
    const runtime = this.sessions.get(requirementId);
    if (!runtime || runtime.status !== "live" || !runtime.writable) {
      throw new Error("no active terminal session");
    }

    runtime.shell.write(input);
  }

  async terminateSession(
    requirementId: string,
    reason: PtySessionExitInfo["reason"] = "restart",
  ): Promise<boolean> {
    const runtime = this.sessions.get(requirementId);
    if (!runtime || runtime.status !== "live") {
      return false;
    }

    runtime.pendingExitReason = reason;
    runtime.writable = false;

    try {
      runtime.shell.kill();
    } catch {
      // best effort cleanup
    }

    await runtime.exitPromise;
    this.sessions.delete(requirementId);
    return true;
  }

  async stopAll(
    reason: PtySessionExitInfo["reason"] = "daemon-shutdown",
  ): Promise<void> {
    await Promise.all(
      [...this.sessions.keys()].map(async (requirementId) => {
        await this.terminateSession(requirementId, reason);
      }),
    );
  }

  private emit(requirementId: string, event: KanbanTerminalEvent): void {
    const listeners = this.listeners.get(requirementId);
    if (!listeners) {
      return;
    }

    for (const listener of listeners) {
      listener(event);
    }
  }

  private async handleExit(
    runtime: PtyRuntime,
    event: ManagedPtyExitEvent,
  ): Promise<void> {
    if (runtime.status !== "live") {
      runtime.resolveExit();
      return;
    }

    const finishedAt = this.now();
    const exitCode = typeof event.exitCode === "number" ? event.exitCode : null;
    const reason =
      runtime.pendingExitReason ??
      (exitCode === null || exitCode === 0 ? "shell-exit" : "error");
    const errored =
      reason === "error" ||
      (reason === "shell-exit" && exitCode !== null && exitCode !== 0);

    runtime.status = errored ? "error" : "exited";
    runtime.writable = false;
    runtime.shellAlive = false;
    runtime.lastExitCode = exitCode;
    runtime.finishedAt = finishedAt;
    runtime.summary = errored
      ? `Shell exited with code ${exitCode ?? "unknown"}`
      : "Shell exited";

    for (const dispose of runtime.disposers) {
      dispose();
    }
    runtime.disposers = [];

    if (errored) {
      this.emit(runtime.requirementId, {
        type: "error",
        cardId: runtime.requirementId,
        ts: finishedAt,
        error: runtime.summary,
      });
    } else {
      this.emit(runtime.requirementId, {
        type: "exit",
        cardId: runtime.requirementId,
        ts: finishedAt,
        summary: runtime.summary,
        exitCode,
      });
    }

    this.onSessionExit({
      requirementId: runtime.requirementId,
      sessionId: runtime.sessionId,
      exitCode,
      signal: event.signal,
      reason,
      finishedAt,
    });
    runtime.resolveExit();
  }

  private async waitForShellReady(shell: ManagedPty): Promise<void> {
    await new Promise<void>((resolve) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        dispose();
        resolve();
      }, 120);

      const dispose = disposeListener(
        shell.onData(() => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeout);
          dispose();
          resolve();
        }),
      );
    });
  }
}
