import { type ChildProcess, spawn } from "node:child_process";
import type { ReviewHostMode } from "./terminal-browser.ts";
import { wantsRemoteReviewUrl } from "./terminal-browser.ts";

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

/** Minimal ctx shape required to derive a session key, plus the one way out to the client. */
type CliCtx = {
  cwd: string;
  sessionManager: { getSessionFile: () => string | null | undefined };
  /**
   * pi's extension UI context — only `notify` is read, and only for the
   * remote/phone path (`deliverReadyUrl`). Typed `unknown` on purpose: pi's
   * `ExtensionUIContext` and the tests' mocks both have to fit, and the one
   * method used is narrowed at the call site.
   */
  ui?: unknown;
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
  /**
   * Shell hook for a caller that wants the review URL itself (tests, future
   * hosts). When omitted, a remote/phone run delivers the URL through
   * `ctx.ui.notify` — see `deliverReadyUrl`.
   */
  onReadyUrl?: (url: string) => void;
};

/**
 * Shell: hand a remote review URL to the reviewer's own screen.
 *
 * The agent runs on the server; when the review is hosted remotely the page is
 * only reachable from the device the reviewer is actually holding (a phone on
 * the same Wi-Fi, a laptop over SSH). `ctx.ui.notify` is the one channel pi
 * gives an extension for "say something the person must see": the client draws
 * a bubble, and a bubble carrying an `http(s)` link is tappable there (it opens
 * the review page) and does not expire on its own.
 *
 * No UI (headless / `hasUI === false`) means there is nobody to tell: the CLI
 * still printed the URL on stderr and wrote it to READY_FILE, so nothing is
 * lost — it just is not surfaced here.
 */
const deliverReadyUrl = (
  ctx: CliCtx,
  url: string,
  onReadyUrl?: (url: string) => void,
): void => {
  if (onReadyUrl) {
    try {
      onReadyUrl(url);
    } catch {
      // A throwing caller must not take the review run down with it.
    }
    return;
  }
  const ui = ctx.ui as
    | {
        notify?: (message: string, type?: "info" | "warning" | "error") => void;
      }
    | undefined;
  if (typeof ui?.notify !== "function") {
    return;
  }
  try {
    ui.notify(`评审已就绪，点击打开: ${url}`, "info");
  } catch {
    // Notifying is best effort; the review itself keeps waiting.
  }
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
  // Remote/phone runtime (a LAN name, a tailnet name, an SSH box): the review
  // page belongs on the reviewer's own screen, so the URL is delivered to the
  // client instead of opened on the server. READY_FILE is the only channel the
  // CLI offers for it, and it needs SKIP_BROWSER_OPEN so nothing pops up on
  // the server while the reviewer waits on their phone.
  const remoteUrl = !isTestEnv && wantsRemoteReviewUrl(process.env);
  // Probe the panel path only when the caller opted into herdr-panel AND the
  // runtime looks like Herdr — browser mode never spawns terminal-browser.
  const wantsReadyFile =
    (!isTestEnv && hostMode === "herdr-panel" && isHerdrEnv) || remoteUrl;
  if (wantsReadyFile) {
    try {
      tb = await import("./terminal-browser.ts");
      useTerminalBrowser =
        !isTestEnv && hostMode === "herdr-panel" && isHerdrEnv
          ? await tb.shouldUseTerminalBrowser(ctx, hostMode)
          : false;
      if (useTerminalBrowser || remoteUrl) {
        try {
          readyFile = await tb.createTempReadyFile();
          effectiveEnv = {
            ...process.env,
            ...options.env,
            PLANNOTATOR_CWD: ctx.cwd,
            PLANNOTATOR_READY_FILE: readyFile,
            PLANNOTATOR_SKIP_BROWSER_OPEN: "1",
            // A URL host alone does not switch the CLI into remote mode; ask
            // for it so the session binds 0.0.0.0 on the fixed port the URL
            // was built for. An explicit setting always wins.
            ...(remoteUrl &&
            !(options.env?.PLANNOTATOR_REMOTE ?? process.env.PLANNOTATOR_REMOTE)
              ? { PLANNOTATOR_REMOTE: "1" }
              : {}),
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

    // Shell: the review URL arrives on READY_FILE (fire-and-forget). Two
    // destinations, never both: the Herdr panel (same machine) or the
    // reviewer's own client (remote/phone).
    if (tb && readyFile) {
      openedHerdrPanel = useTerminalBrowser;
      const capturedReadyFile = readyFile;
      const capturedSignal = options.signal;
      const tbMod = tb;
      tbMod
        .waitForReadyFile(capturedReadyFile, capturedSignal, 8000)
        .then((url) => {
          if (!url) {
            return;
          }
          if (useTerminalBrowser) {
            return tbMod
              .openUrlInHerdrTerminalBrowser(url, ctx)
              .catch(() => {});
          }
          deliverReadyUrl(ctx, url, options.onReadyUrl);
          return;
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
    /** Take the review URL instead of the default notify (see `deliverReadyUrl`). */
    onReadyUrl?: (url: string) => void;
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
    onReadyUrl: options.onReadyUrl,
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
    /** Take the review URL instead of the default notify (see `deliverReadyUrl`). */
    onReadyUrl?: (url: string) => void;
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
    onReadyUrl: options.onReadyUrl,
  });
};
