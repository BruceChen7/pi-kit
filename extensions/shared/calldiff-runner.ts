/**
 * Imperative shell (shared): runs the `calldiff` CLI and returns its stdout.
 *
 * Pure, testable decision functions (arg building, command resolution) are
 * exported separately; the only IO here is spawning the CLI (and a git
 * probe) with timeouts and abort support. Failures are returned as typed
 * outcomes — callers decide how to surface them (the extensions treat
 * calldiff as best-effort and degrade silently).
 */

import { type ChildProcess, spawn } from "node:child_process";
import { getRepoRoot } from "./git.ts";

export type CalldiffMode = "diff" | "tree" | "reach";

export type CalldiffRunOptions = {
  cwd: string;
  mode?: CalldiffMode;
  /** diff: before-ref (default HEAD). tree/reach: the tree ref (default worktree). */
  from?: string;
  /** diff: after-ref (default worktree). Unused by tree/reach. */
  to?: string;
  /** Entrypoint(s): functionName or ClassName.method. Required for tree/reach. */
  entries?: string[];
  /** reach target symbol (--to). */
  target?: string;
  /** Limit to path prefixes (trailing positionals). */
  paths?: string[];
  maxDepth?: number;
  timeoutMs?: number;
  /** Explicit calldiff binary; when absent, `calldiff` on PATH wins over npx. */
  bin?: string | null;
  /** When true (default), fall back to `npx --yes calldiff@latest` if the binary is missing. */
  preferNpxFallback?: boolean;
  /** Abort the run (kills the child) when the signal fires. */
  signal?: AbortSignal;
};

export type CalldiffRunErrorCode =
  | "no-git-repo"
  | "binary-not-found"
  | "timeout"
  | "aborted"
  | "exit-error"
  | "spawn-error";

export type CalldiffRunOutcome =
  | { status: "ok"; stdout: string }
  | { status: "error"; code: CalldiffRunErrorCode; message: string };

/**
 * Default CLI timeout. 120s (was 60s): AST parsing of large repos alone can
 * take ~55s warm, and a cold grammar cache adds an on-demand npm install
 * (~5-30s) on top — 60s killed legitimate runs mid-parse.
 */
export const DEFAULT_CALLDIFF_TIMEOUT_MS = 120_000;

/* ------------------------------------------------------------------ */
/*  Pure decision helpers (unit-tested)                                */
/* ------------------------------------------------------------------ */

export const buildCalldiffArgs = (options: CalldiffRunOptions): string[] => {
  const mode = options.mode ?? "diff";
  const args: string[] = [mode];

  if (mode === "diff") {
    if (options.from) args.push(options.from);
    if (options.to) args.push(options.to);
  } else if (options.from) {
    // tree/reach take a single optional ref before the options.
    args.push(options.from);
  }

  args.push("--format", "json");
  if (options.maxDepth !== undefined && options.maxDepth > 0) {
    args.push("--max-depth", String(options.maxDepth));
  }
  for (const entry of options.entries ?? []) {
    args.push("--entry", entry);
  }
  if (mode === "reach" && options.target) {
    args.push("--to", options.target);
  }
  // Path filters are trailing positionals.
  for (const path of options.paths ?? []) {
    args.push(path);
  }
  return args;
};

/**
 * Resolve the command vector. An explicitly configured `bin` always wins;
 * otherwise prefer a `calldiff` on PATH, and only fall back to npx when
 * `preferNpxFallback` is set (used after an ENOENT on the first attempt).
 */
export const resolveCalldiffCommand = (
  options: Pick<CalldiffRunOptions, "bin" | "preferNpxFallback">,
): string[] => {
  if (options.bin) {
    return [options.bin];
  }
  if (options.preferNpxFallback === true) {
    return ["npx", "--yes", "calldiff@latest"];
  }
  return ["calldiff"];
};

/* ------------------------------------------------------------------ */
/*  Shell                                                              */
/* ------------------------------------------------------------------ */

/** True when `cwd` sits inside a git work tree (shell: spawns git via the shared git seam). */
export const isGitRepository = (cwd: string): boolean =>
  getRepoRoot(cwd) !== null;

const runOnce = (
  command: string[],
  args: string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CalldiffRunOutcome> =>
  new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({
        status: "error",
        code: "aborted",
        message: "calldiff run aborted before start.",
      });
      return;
    }

    const commandName = command[0];
    let child: ChildProcess | undefined;
    try {
      child = spawn(commandName ?? "", command.slice(1).concat(args), {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, CALLDIFF_FORMAT: "json" },
      });
    } catch (error) {
      resolve({
        status: "error",
        code: "spawn-error",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (!child) {
      resolve({
        status: "error",
        code: "spawn-error",
        message: "calldiff process could not be started.",
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    let settled = false;
    const settle = (outcome: CalldiffRunOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };

    const onAbort = (): void => {
      child.kill("SIGTERM");
      settle({
        status: "error",
        code: "aborted",
        message: "calldiff run aborted.",
      });
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      // Give the child a moment to die, then force-kill.
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 2_000).unref();
      settle({
        status: "error",
        code: "timeout",
        message: `calldiff timed out after ${timeoutMs}ms.`,
      });
    }, timeoutMs);

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        settle({
          status: "error",
          code: "binary-not-found",
          message: error.message,
        });
        return;
      }
      settle({ status: "error", code: "spawn-error", message: error.message });
    });

    child.on("close", (code) => {
      if (code === 0) {
        settle({ status: "ok", stdout });
        return;
      }
      // Include the stdout tail too: calldiff reports usage errors (e.g.
      // TREE_FAILED) as JSON on stdout with a nonzero exit.
      const tail = `${stderr}\n${stdout}`
        .trim()
        .split("\n")
        .slice(-5)
        .join("\n");
      settle({
        status: "error",
        code: "exit-error",
        message: `calldiff exited with code ${code ?? "null"}.${tail ? `\n${tail}` : ""}`,
      });
    });
  });

export const runCalldiffJson = async (
  options: CalldiffRunOptions,
): Promise<CalldiffRunOutcome> => {
  const cwd = options.cwd;
  if (!isGitRepository(cwd)) {
    return {
      status: "error",
      code: "no-git-repo",
      message: `${cwd} is not inside a git work tree; calldiff requires git.`,
    };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_CALLDIFF_TIMEOUT_MS;
  const args = buildCalldiffArgs(options);
  const firstCommand = resolveCalldiffCommand({
    bin: options.bin,
    preferNpxFallback: false,
  });

  const first = await runOnce(
    firstCommand,
    args,
    cwd,
    timeoutMs,
    options.signal,
  );
  if (first.status === "ok") {
    return first;
  }
  if (first.code !== "binary-not-found") {
    return first;
  }

  // Binary missing on PATH — retry through npx once (best effort).
  const npxCommand = resolveCalldiffCommand({
    bin: options.bin,
    preferNpxFallback: options.preferNpxFallback !== false,
  });
  if (npxCommand[0] === firstCommand[0]) {
    return first;
  }
  return runOnce(npxCommand, args, cwd, timeoutMs, options.signal);
};
