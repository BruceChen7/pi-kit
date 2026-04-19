import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import path from "node:path";

import { createLogger } from "../shared/logger.ts";
import type {
  DiffxReviewSession,
  DiffxRuntimeSession,
  StartDiffxReviewSessionInput,
} from "./types.ts";

const log = createLogger("diffx-review", {
  stderr: null,
});

const sessions = new Map<string, DiffxRuntimeSession>();
const DIFFX_URL_PATTERN = /diffx server running at (http:\/\/\S+)/i;
const OUTPUT_TAIL_MAX = 4000;

const appendTail = (current: string, chunk: string): string => {
  const next = `${current}${chunk}`;
  return next.length > OUTPUT_TAIL_MAX
    ? next.slice(next.length - OUTPUT_TAIL_MAX)
    : next;
};

const cleanupSession = (
  repoRoot: string,
  child?: ChildProcessWithoutNullStreams,
) => {
  const session = sessions.get(repoRoot);
  if (!session) {
    return;
  }
  if (child && session.child !== child) {
    return;
  }
  sessions.delete(repoRoot);
};

const toPublicSession = (session: DiffxRuntimeSession): DiffxReviewSession => ({
  repoRoot: session.repoRoot,
  host: session.host,
  port: session.port,
  url: session.url,
  pid: session.pid,
  startedAt: session.startedAt,
  diffArgs: [...session.diffArgs],
  openInBrowser: session.openInBrowser,
  cwdAtStart: session.cwdAtStart,
  startCommand: session.startCommand,
  lastHealthcheckAt: session.lastHealthcheckAt,
  lastHealthcheckOk: session.lastHealthcheckOk,
});

export const getDiffxReviewSession = (
  repoRoot: string,
): DiffxRuntimeSession | null => {
  const session = sessions.get(repoRoot) ?? null;
  if (!session) {
    return null;
  }
  if (session.child.exitCode !== null || session.child.killed) {
    cleanupSession(repoRoot, session.child);
    return null;
  }
  return session;
};

export const clearDiffxReviewSession = (repoRoot: string): void => {
  cleanupSession(repoRoot);
};

export const markSessionHealth = (
  repoRoot: string,
  healthy: boolean,
): DiffxReviewSession | null => {
  const session = getDiffxReviewSession(repoRoot);
  if (!session) {
    return null;
  }
  session.lastHealthcheckAt = Date.now();
  session.lastHealthcheckOk = healthy;
  return toPublicSession(session);
};

const splitCommandString = (value: string): string[] => {
  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }

  const tokens = trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return tokens.map((token) => token.replace(/^(["'])|(["'])$/g, ""));
};

export const buildDiffxStartCommand = (
  input: StartDiffxReviewSessionInput,
): { command: string; args: string[]; description: string } => {
  const commandParts = input.diffxCommand
    ? splitCommandString(input.diffxCommand)
    : [];

  const command = commandParts[0] || "node";
  const args =
    commandParts.length > 0
      ? commandParts.slice(1)
      : [path.join(input.diffxPath, "dist", "cli.mjs")];

  args.push("--host", input.host);
  if (input.port !== null) {
    args.push("--port", String(input.port));
  }
  if (!input.openInBrowser) {
    args.push("--no-open");
  }
  if (input.diffArgs.length > 0) {
    args.push("--", ...input.diffArgs);
  }
  return {
    command,
    args,
    description: [command, ...args].join(" "),
  };
};

export const startDiffxReviewSession = async (
  input: StartDiffxReviewSessionInput,
): Promise<DiffxReviewSession> => {
  const startCommand = buildDiffxStartCommand(input);
  const child = spawn(startCommand.command, startCommand.args, {
    cwd: input.repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    windowsHide: true,
  });

  let stdoutTail = "";
  let stderrTail = "";

  log.debug("starting diffx review session", {
    repoRoot: input.repoRoot,
    command: startCommand.description,
  });

  const readyUrl = await new Promise<string>((resolve, reject) => {
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExitBeforeReady);
      fn();
    };

    const onStdout = (chunk: Buffer | string) => {
      stdoutTail = appendTail(stdoutTail, chunk.toString());
      const lines = stdoutTail.split(/\r?\n/);
      for (const line of lines) {
        const match = DIFFX_URL_PATTERN.exec(line);
        if (match?.[1]) {
          finish(() => resolve(match[1]));
          return;
        }
      }
    };

    const onStderr = (chunk: Buffer | string) => {
      stderrTail = appendTail(stderrTail, chunk.toString());
    };

    const onError = (error: Error) => {
      finish(() => {
        reject(
          new Error(
            `Failed to start diffx: ${error.message}${stderrTail ? `\nstderr:\n${stderrTail}` : ""}`,
          ),
        );
      });
    };

    const onExitBeforeReady = (code: number | null, signal: string | null) => {
      finish(() => {
        reject(
          new Error(
            `diffx exited before startup completed (code=${code ?? "null"}, signal=${signal ?? "null"})${stderrTail ? `\nstderr:\n${stderrTail}` : ""}${stdoutTail ? `\nstdout:\n${stdoutTail}` : ""}`,
          ),
        );
      });
    };

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => {
        reject(
          new Error(
            `Timed out waiting for diffx to start after ${input.startupTimeoutMs}ms${stderrTail ? `\nstderr:\n${stderrTail}` : ""}${stdoutTail ? `\nstdout:\n${stdoutTail}` : ""}`,
          ),
        );
      });
    }, input.startupTimeoutMs);

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("exit", onExitBeforeReady);
  });

  const url = new URL(readyUrl);
  const session: DiffxRuntimeSession = {
    repoRoot: input.repoRoot,
    host: url.hostname || input.host,
    port: Number.parseInt(url.port, 10),
    url: url.toString().replace(/\/$/, ""),
    pid: child.pid ?? -1,
    startedAt: Date.now(),
    diffArgs: [...input.diffArgs],
    openInBrowser: input.openInBrowser,
    cwdAtStart: input.repoRoot,
    startCommand: startCommand.description,
    lastHealthcheckAt: null,
    lastHealthcheckOk: null,
    child,
  };

  child.once("exit", (code, signal) => {
    log.debug("diffx review session exited", {
      repoRoot: input.repoRoot,
      pid: session.pid,
      code,
      signal,
    });
    cleanupSession(input.repoRoot, child);
  });
  child.unref();

  sessions.set(input.repoRoot, session);
  log.info("diffx review session started", {
    repoRoot: input.repoRoot,
    url: session.url,
    pid: session.pid,
  });
  return toPublicSession(session);
};

export const stopDiffxReviewSession = async (
  repoRoot: string,
): Promise<{ stopped: boolean; reason: string }> => {
  const session = getDiffxReviewSession(repoRoot);
  if (!session) {
    return { stopped: false, reason: "not-found" };
  }

  if (session.child.exitCode !== null || session.child.killed) {
    cleanupSession(repoRoot, session.child);
    return { stopped: true, reason: "already-exited" };
  }

  const result = await new Promise<{ stopped: boolean; reason: string }>(
    (resolve) => {
      let settled = false;
      const finish = (reason: string) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        session.child.off("exit", onExit);
        cleanupSession(repoRoot, session.child);
        resolve({ stopped: true, reason });
      };

      const onExit = () => {
        finish("stopped");
      };

      const timeout = setTimeout(() => {
        try {
          session.child.kill("SIGTERM");
        } catch {
          // ignore kill escalation failures
        }
        finish("forced-stop");
      }, 2000);

      session.child.once("exit", onExit);
      try {
        session.child.kill("SIGINT");
      } catch {
        finish("kill-failed");
      }
    },
  );

  log.info("diffx review session stopped", {
    repoRoot,
    pid: session.pid,
    reason: result.reason,
  });
  return result;
};
