import { type ChildProcess, spawn } from "node:child_process";
import type { ReviewHostMode } from "./terminal-browser.ts";

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
  /**
   * Caller-level policy: how should a Markdown review be hosted?
   * `"browser"` (default) lets the plannotator CLI open the regular browser;
   * `"herdr-panel"` arms the Herdr terminal-browser panel flow. HTML
   * artifact call sites always pass `"browser"` — their review opens in the
   * regular browser instead of splitting a Herdr pane.
   */
  hostMode?: ReviewHostMode;
};

type RunCliResult<T> =
  | { status: "handled"; result: T }
  | { status: "error"; error: string }
  | { status: "aborted" };

const runCli = async <T extends CliReviewDecision>(
  ctx: CliCtx,
  command: string,
  args: string[],
  options: RunCliOptions<T>,
): Promise<RunCliResult<T>> => {
  // Functional Core decision: should we use terminal-browser?
  // Sync fast-path: in tests or non-Herdr, avoid async import entirely (keeps mocks hermetic).
  // Markdown reviews opt in via hostMode "herdr-panel"; HTML artifact call
  // sites always pass hostMode "browser" (the default), so nothing arms.
  let useTerminalBrowser = false;
  // Lazily resolved ONCE per run: every terminal-browser touchpoint below
  // (panel open, panel close, ready-file cleanup) shares this single module
  // instance. Callers never wire close themselves — runCli owns the whole
  // panel lifecycle.
  let tb: typeof import("./terminal-browser.ts") | null = null;
  let openedHerdrPanel = false;
  let readyFile: string | null = null;
  let effectiveEnv: NodeJS.ProcessEnv | undefined = options.env;
  const isTestEnv = !!process.env.VITEST || process.env.NODE_ENV === "test";
  const isHerdrEnv =
    process.env.HERDR_ENV === "1" && !!process.env.HERDR_PANE_ID;
  const hostMode = options.hostMode ?? "browser";
  // Probe the panel path only when the caller opted into herdr-panel AND the
  // runtime looks like Herdr — browser mode never spawns terminal-browser.
  if (!isTestEnv && hostMode === "herdr-panel" && isHerdrEnv) {
    try {
      tb = await import("./terminal-browser.ts");
      useTerminalBrowser = await tb.shouldUseTerminalBrowser(ctx, hostMode);
      if (useTerminalBrowser) {
        try {
          readyFile = await tb.createTempReadyFile();
          effectiveEnv = {
            ...process.env,
            ...options.env,
            PLANNOTATOR_CWD: ctx.cwd,
            PLANNOTATOR_READY_FILE: readyFile,
            PLANNOTATOR_SKIP_BROWSER_OPEN: "1",
          };
        } catch {
          readyFile = null;
          effectiveEnv = options.env;
        }
      }
    } catch {
      useTerminalBrowser = false;
    }
  }

  return new Promise<RunCliResult<T>>((resolve) => {
    const detached = options.detached === true;
    const child = spawn(command, args, {
      cwd: ctx.cwd,
      env: effectiveEnv ?? { ...process.env, PLANNOTATOR_CWD: ctx.cwd },
      stdio: ["pipe", "pipe", "pipe"],
      ...(detached ? { detached: true } : {}),
    });

    // Shell: parallel open of terminal-browser via READY_FILE (fire-and-forget)
    if (tb && useTerminalBrowser && readyFile) {
      openedHerdrPanel = true;
      const capturedReadyFile = readyFile;
      const capturedSignal = options.signal;
      const tbMod = tb;
      tbMod
        .waitForReadyFile(capturedReadyFile, capturedSignal, 8000)
        .then((url) => {
          if (url) {
            return tbMod
              .openUrlInHerdrTerminalBrowser(url, ctx)
              .catch(() => {});
          }
        })
        .catch(() => {});
    }
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
      const result = options.parseStdout(stdout);
      // Shell: terminal verdict on a run that armed the panel flow → close
      // the Herdr review panel this run opened (fire-and-forget, mirrors the
      // fire-and-forget open). Errors/aborts return above and keep the panel
      // for a retry; browser-hosted flows (hostMode "browser") never arm the
      // panel, so nothing is closed for them.
      if (tb && openedHerdrPanel) {
        tb.closeReviewPanelOnTerminalDecision(result, ctx);
      }
      finish({
        status: "handled",
        result,
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

    // Shell: cleanup READY_FILE on close (best-effort, no await)
    if (readyFile && tb) {
      const fileToClean = readyFile;
      const tbMod = tb;
      child.on("close", () => {
        try {
          tbMod.removeTempReadyFile(fileToClean);
        } catch {}
      });
    }
  });
};

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
  options: {
    signal?: AbortSignal;
    timeoutMs: number;
    /** How to host the review UI: "browser" (default) or "herdr-panel". */
    hostMode?: ReviewHostMode;
  },
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
    hostMode: options.hostMode,
  });
};

export const runPlannotatorAnnotateCli = async (
  ctx: CliCtx,
  filePath: string,
  options: {
    gate?: boolean;
    signal?: AbortSignal;
    timeoutMs: number;
    /** HTML artifacts always host in the regular browser. */
    hostMode?: ReviewHostMode;
  },
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
    hostMode: options.hostMode,
  });
};
