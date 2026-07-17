import { type ChildProcess, spawn } from "node:child_process";

export type CliReviewDecision = {
  approved: boolean;
  feedback?: string;
  exit?: boolean;
};

export type CliReviewResult =
  | { status: "handled"; result: CliReviewDecision }
  | { status: "error"; error: string }
  | { status: "aborted" };

// --- Session child tracking ---
//
// Track spawned plannotator children per session key so they can be killed on
// session_shutdown when the user closes the browser tab without completing
// the review (the plannotator CLI hangs on an unresolved Promise).
//
// Keyed by sessionKey (not cwd) to correctly isolate sessions that share the
// same working directory.

import { getSessionKey } from "./session.ts";

/** Minimal ctx shape required to derive a session key. */
type CliCtx = {
  cwd: string;
  sessionManager: { getSessionFile: () => string | null | undefined };
};

const childrenBySessionKey = new Map<string, Set<ChildProcess>>();

const trackChild = (sessionKey: string, child: ChildProcess): void => {
  let children = childrenBySessionKey.get(sessionKey);
  if (!children) {
    children = new Set();
    childrenBySessionKey.set(sessionKey, children);
  }
  children.add(child);
  child.on("close", () => {
    children.delete(child);
    if (children.size === 0) {
      childrenBySessionKey.delete(sessionKey);
    }
  });
};

/**
 * Count tracked children for the given session key (pure — no side effect).
 */
export const countTrackedChildren = (sessionKey: string): number =>
  childrenBySessionKey.get(sessionKey)?.size ?? 0;

/**
 * Kill all tracked plannotator children for the given session key.
 * Uses SIGTERM to match the existing timeout/abort pattern in this file.
 */
export const killTrackedChildren = (sessionKey: string): void => {
  const children = childrenBySessionKey.get(sessionKey);
  if (!children || children.size === 0) {
    return;
  }

  for (const child of children) {
    if (!child.killed) {
      child.kill(); // SIGTERM (default)
    }
  }
  childrenBySessionKey.delete(sessionKey);
};

type RunPlannotatorCliOptions = {
  input?: string;
  parseStdout: (stdout: string) => CliReviewDecision;
  signal?: AbortSignal;
  timeoutMs: number;
};

const runPlannotatorCli = async (
  ctx: CliCtx,
  args: string[],
  options: RunPlannotatorCliOptions,
): Promise<CliReviewResult> =>
  new Promise((resolve) => {
    const child = spawn("plannotator", args, {
      cwd: ctx.cwd,
      env: { ...process.env, PLANNOTATOR_CWD: ctx.cwd },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let aborted = Boolean(options.signal?.aborted);

    const cleanup = () => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
    };
    const finish = (result: CliReviewResult) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };
    const abort = () => {
      aborted = true;
      child.kill();
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish({ status: "error", error: "plannotator timed out" });
    }, options.timeoutMs);

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish({ status: "error", error: error.message });
    });
    child.on("close", (code) => {
      if (aborted) {
        finish({ status: "aborted" });
        return;
      }
      if (code !== 0) {
        finish({
          status: "error",
          error: stderr || `plannotator exited with ${code}`,
        });
        return;
      }
      finish({
        status: "handled",
        result: options.parseStdout(stdout),
      });
    });

    if (options.signal) {
      options.signal.addEventListener("abort", abort, { once: true });
    }
    if (aborted) {
      abort();
    }

    // Track child so it can be killed on session_shutdown if the user closes
    // the browser tab without completing the review.
    const sessionKey = getSessionKey(ctx);
    trackChild(sessionKey, child);

    child.stdin.end(options.input ?? "");
  });

const parseCliReviewResult = (stdout: string): CliReviewDecision => {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return { approved: false, exit: true };
  }

  try {
    const parsed = JSON.parse(trimmed) as {
      decision?: string;
      feedback?: string;
    };
    if (parsed.decision === "approved") {
      return { approved: true };
    }
    if (parsed.decision === "dismissed") {
      return { approved: false, exit: true };
    }
    return { approved: false, feedback: parsed.feedback ?? "" };
  } catch {
    if (/The user approved\./i.test(trimmed)) {
      return { approved: true };
    }
    return { approved: false, feedback: trimmed };
  }
};

const parseCliPlanReviewResult = (stdout: string): CliReviewDecision => {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return { approved: false, exit: true };
  }

  try {
    const parsed = JSON.parse(trimmed) as {
      hookSpecificOutput?: {
        decision?: {
          behavior?: string;
          message?: string;
        };
      };
      decision?: string;
      feedback?: string;
    };
    const hookDecision = parsed.hookSpecificOutput?.decision;
    if (hookDecision?.behavior === "allow") {
      return { approved: true };
    }
    if (hookDecision?.behavior === "deny") {
      return { approved: false, feedback: hookDecision.message ?? "" };
    }
    if (parsed.decision === "approved") {
      return { approved: true };
    }
    if (parsed.decision === "dismissed") {
      return { approved: false, exit: true };
    }
    if (parsed.decision === "annotated") {
      return { approved: false, feedback: parsed.feedback ?? "" };
    }
  } catch {
    // Fall through to plaintext handling.
  }

  return { approved: false, feedback: trimmed };
};

export const runPlannotatorPlanReviewCli = async (
  ctx: CliCtx,
  planContent: string,
  options: { signal?: AbortSignal; timeoutMs: number },
): Promise<CliReviewResult> => {
  const hookEvent = {
    hook_event_name: "PermissionRequest",
    tool_input: { plan: planContent },
    permission_mode: "default",
  };

  return runPlannotatorCli(ctx, [], {
    input: `${JSON.stringify(hookEvent)}\n`,
    parseStdout: parseCliPlanReviewResult,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
};

export const runPlannotatorAnnotateCli = async (
  ctx: CliCtx,
  filePath: string,
  options: {
    gate?: boolean;
    renderHtml?: boolean;
    signal?: AbortSignal;
    timeoutMs: number;
  },
): Promise<CliReviewResult> => {
  const args = ["annotate", filePath];
  if (options.renderHtml) {
    args.push("--render-html");
  }
  if (options.gate) {
    args.push("--gate");
  }
  args.push("--json");

  return runPlannotatorCli(ctx, args, {
    parseStdout: parseCliReviewResult,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
};
