import { type ChildProcess, spawn, spawnSync } from "node:child_process";

export type CliReviewDecision = {
  approved: boolean;
  feedback?: string;
  exit?: boolean;
  /** User closed the review without a decision (dismissed, not denied). */
  dismissed?: boolean;
};

export type CliReviewResult =
  | { status: "handled"; result: CliReviewDecision }
  | { status: "error"; error: string }
  | { status: "aborted" };

export type LavishDecision =
  | { kind: "opened" }
  | { kind: "user-ended" }
  | {
      kind: "feedback";
      prompts: string[];
      sessionEnded: boolean;
      endedBy?: string;
      nextStep?: string;
    }
  | { kind: "ended"; endedBy?: string; nextStep?: string };

export type LavishCliResult =
  | { status: "handled"; result: LavishDecision }
  | { status: "error"; error: string }
  | { status: "aborted" };

// --- Session child tracking ---
//
// Track spawned review CLI children per session key so they can be killed on
// session_shutdown when the user closes the browser tab without completing
// the review (the CLIs hang on an unresolved Promise).
//
// Keyed by sessionKey (not cwd) to correctly isolate sessions that share the
// same working directory. Children spawned through `npx` run detached in
// their own process group, so group-kill is used for them (Windows falls
// back to a plain child kill).

import { getSessionKey } from "./session.ts";

/** Minimal ctx shape required to derive a session key. */
type CliCtx = {
  cwd: string;
  sessionManager: { getSessionFile: () => string | null | undefined };
};

type TrackedChild = {
  child: ChildProcess;
  killGroup: boolean;
};

const childrenBySessionKey = new Map<string, Set<TrackedChild>>();

const killTracked = (tracked: TrackedChild): void => {
  const { child, killGroup } = tracked;
  if (killGroup && child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGTERM");
      return;
    } catch {
      // Process group unavailable — fall through to a plain child kill.
    }
  }
  if (!child.killed) {
    child.kill(); // SIGTERM (default)
  }
};

const trackChild = (
  sessionKey: string,
  child: ChildProcess,
  killGroup: boolean,
): void => {
  let children = childrenBySessionKey.get(sessionKey);
  if (!children) {
    children = new Set();
    childrenBySessionKey.set(sessionKey, children);
  }
  const tracked: TrackedChild = { child, killGroup };
  children.add(tracked);
  child.on("close", () => {
    for (const entry of children) {
      if (entry.child === child) {
        children.delete(entry);
        break;
      }
    }
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
 * Kill all tracked review CLI children for the given session key.
 */
export const killTrackedChildren = (sessionKey: string): void => {
  const children = childrenBySessionKey.get(sessionKey);
  if (!children || children.size === 0) {
    return;
  }

  for (const tracked of children) {
    killTracked(tracked);
  }
  childrenBySessionKey.delete(sessionKey);
};

type RunCliOptions<T> = {
  input?: string;
  parseStdout: (stdout: string) => T;
  signal?: AbortSignal;
  timeoutMs: number;
  detached?: boolean;
  env?: NodeJS.ProcessEnv;
};

type RunCliResult<T> =
  | { status: "handled"; result: T }
  | { status: "error"; error: string }
  | { status: "aborted" };

const runCli = async <T>(
  ctx: CliCtx,
  command: string,
  args: string[],
  options: RunCliOptions<T>,
): Promise<RunCliResult<T>> =>
  new Promise((resolve) => {
    const detached = options.detached === true;
    const child = spawn(command, args, {
      cwd: ctx.cwd,
      env: options.env ?? { ...process.env, PLANNOTATOR_CWD: ctx.cwd },
      stdio: ["pipe", "pipe", "pipe"],
      ...(detached ? { detached: true } : {}),
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let aborted = Boolean(options.signal?.aborted);

    const killChild = () => killTracked({ child, killGroup: detached });

    const cleanup = () => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
    };
    const finish = (result: RunCliResult<T>) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };
    const abort = () => {
      aborted = true;
      killChild();
    };
    const timeout = setTimeout(() => {
      killChild();
      finish({ status: "error", error: "review CLI timed out" });
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
          error: stderr || `${command} exited with ${code}`,
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
    trackChild(sessionKey, child, detached);

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
      return { approved: false, exit: true, dismissed: true };
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
      return { approved: false, exit: true, dismissed: true };
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

  return runCli(ctx, "plannotator", [], {
    input: `${JSON.stringify(hookEvent)}\n`,
    parseStdout: parseCliPlanReviewResult,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
};

export const runPlannotatorAnnotateCli = async (
  ctx: CliCtx,
  filePath: string,
  options: { gate?: boolean; signal?: AbortSignal; timeoutMs: number },
): Promise<CliReviewResult> => {
  const args = ["annotate", filePath];
  if (options.gate) {
    args.push("--gate");
  }
  args.push("--json");

  return runCli(ctx, "plannotator", args, {
    parseStdout: parseCliReviewResult,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
};

// --- Lavish (HTML artifact review) CLI ---

let lavishCommandProbe: { command: string; prefixArgs: string[] } | null = null;

/**
 * Resolve how to invoke lavish-axi: prefer a direct PATH binary, fall back to
 * `npx -y lavish-axi`. Probed once and cached for the extension lifetime.
 */
export const resolveLavishCommand = (): {
  command: string;
  prefixArgs: string[];
} => {
  if (lavishCommandProbe) {
    return lavishCommandProbe;
  }

  let hasLavishAxi = false;
  try {
    const probe = spawnSync("lavish-axi", ["--version"], {
      stdio: "ignore",
      timeout: 5_000,
    });
    hasLavishAxi = probe.status === 0;
  } catch {
    hasLavishAxi = false;
  }

  lavishCommandProbe = hasLavishAxi
    ? { command: "lavish-axi", prefixArgs: [] }
    : {
        command: process.platform === "win32" ? "npx.cmd" : "npx",
        prefixArgs: ["-y", "lavish-axi"],
      };
  return lavishCommandProbe;
};

const runLavishCli = async (
  ctx: CliCtx,
  args: string[],
  options: {
    parseStdout: (stdout: string) => LavishDecision;
    signal?: AbortSignal;
    timeoutMs: number;
  },
): Promise<LavishCliResult> => {
  const { command, prefixArgs } = resolveLavishCommand();
  const result = await runCli(ctx, command, [...prefixArgs, ...args], {
    parseStdout: options.parseStdout,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    detached: command !== "lavish-axi",
    env: { ...process.env },
  });
  return result;
};

const parseLavishOpenOutput = (stdout: string): LavishDecision => {
  const trimmed = stdout.trim();
  try {
    const parsed = JSON.parse(trimmed) as { session?: { status?: string } };
    if (parsed.session?.status === "user-ended") {
      return { kind: "user-ended" };
    }
  } catch {
    // Fall through — a non-JSON open output still means the open was
    // attempted; treat it as opened so the poll can run.
  }
  return { kind: "opened" };
};

const parseLavishPollOutput = (stdout: string): LavishDecision => {
  const trimmed = stdout.trim();
  try {
    const parsed = JSON.parse(trimmed) as {
      session?: {
        status?: string;
        session_ended?: boolean;
        ended_by?: string;
      };
      prompts?: Array<{ text?: string; tag?: string }>;
      next_step?: string;
    };
    const prompts = (parsed.prompts ?? [])
      .map((prompt) => prompt.text ?? "")
      .filter((text) => text.trim().length > 0);
    const sessionStatus = parsed.session?.status;
    if (sessionStatus === "ended") {
      return {
        kind: "ended",
        endedBy: parsed.session?.ended_by,
        nextStep: parsed.next_step,
      };
    }
    return {
      kind: "feedback",
      prompts,
      sessionEnded: Boolean(parsed.session?.session_ended),
      endedBy: parsed.session?.ended_by,
      nextStep: parsed.next_step,
    };
  } catch {
    // Non-JSON poll output (e.g. interrupted wait) — treat as empty feedback;
    // queued feedback is never lost, so a later poll re-run still delivers it.
    return { kind: "feedback", prompts: [], sessionEnded: false };
  }
};

export const runLavishOpenCli = async (
  ctx: CliCtx,
  filePath: string,
  options: { signal?: AbortSignal; timeoutMs: number },
): Promise<LavishCliResult> =>
  runLavishCli(ctx, ["open", filePath], {
    parseStdout: parseLavishOpenOutput,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });

export const runLavishPollCli = async (
  ctx: CliCtx,
  filePath: string,
  options: {
    agentReply?: string;
    signal?: AbortSignal;
    timeoutMs: number;
  },
): Promise<LavishCliResult> => {
  const args = ["poll", filePath];
  if (options.agentReply) {
    args.push("--agent-reply", options.agentReply);
  }
  return runLavishCli(ctx, args, {
    parseStdout: parseLavishPollOutput,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
};
