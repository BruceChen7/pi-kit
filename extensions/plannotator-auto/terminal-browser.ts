import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger } from "../shared/logger.ts";
import { getSessionKey } from "./session.ts";

const log = createLogger("plannotator-auto", { stderr: null });

// ---------------------------------------------------------------------------
// Functional Core — pure, value in / value out, no IO
// ---------------------------------------------------------------------------

/** Pure: Herdr detection from env snapshot. */
export const isHerdrEnvironment = (
  env: NodeJS.ProcessEnv = process.env,
): boolean => env.HERDR_ENV === "1" && !!env.HERDR_PANE_ID;

/** How a Markdown review is hosted: regular browser (default) or the Herdr terminal-browser panel. */
export type ReviewHostMode = "browser" | "herdr-panel";

/**
 * Pure: should this review use the Herdr terminal-browser panel? Only when
 * the caller opted into herdr-panel AND the runtime supports it (Herdr
 * environment + a usable terminal-browser). value in / value out.
 */
export const resolveReviewHost = (opts: {
  mode: ReviewHostMode;
  isHerdrEnv: boolean;
  terminalBrowserAvailable: boolean;
}): boolean =>
  opts.mode === "herdr-panel" &&
  opts.isHerdrEnv &&
  opts.terminalBrowserAvailable;

/**
 * Pure: next host mode after a `/plannotator-review-host` toggle.
 * Going back to browser is always allowed; switching to herdr-panel requires
 * a Herdr environment with a usable terminal-browser, otherwise the mode
 * stays browser and ok=false (the caller notifies, never silently flips).
 */
export const nextHostMode = (
  current: ReviewHostMode,
  env: NodeJS.ProcessEnv,
  terminalBrowserAvailable: boolean,
): { next: ReviewHostMode; ok: boolean } => {
  if (current === "herdr-panel") {
    return { next: "browser", ok: true };
  }
  if (isHerdrEnvironment(env) && terminalBrowserAvailable) {
    return { next: "herdr-panel", ok: true };
  }
  return { next: "browser", ok: false };
};

/** Pure: parse one READY_FILE JSONL line → url | null. */
export const parseReadyFileLine = (line: string): string | null => {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const payload = JSON.parse(trimmed) as { url?: unknown };
    if (typeof payload.url === "string" && payload.url.trim()) {
      return payload.url.trim();
    }
    return null;
  } catch {
    return null;
  }
};

/** Pure: collect first url from JSONL content. */
export const extractFirstUrlFromReadyContent = (
  content: string,
): string | null => {
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const url = parseReadyFileLine(line);
    if (url) return url;
  }
  return null;
};

/**
 * Pure: parse `herdr pane edges` stdout → does the probed pane have a right
 * neighbor? edges.right === false means a pane exists to the right;
 * edges.right === true means the pane is rightmost. Returns null when the
 * output cannot be parsed (shell treats null as "split").
 */
export const hasRightNeighborFromEdgesOutput = (
  stdout: string,
): boolean | null => {
  try {
    const parsed = JSON.parse(stdout) as {
      result?: { edges?: { right?: boolean } };
    };
    const right = parsed.result?.edges?.right;
    return typeof right === "boolean" ? right === false : null;
  } catch {
    return null;
  }
};

/** Decision shape produced by the review CLIs (approved/denied/dismissed). */
export type ReviewDecisionLike = {
  approved?: boolean;
  dismissed?: boolean;
  feedback?: string;
};

/**
 * Pure: the review ended with a terminal verdict (approved / denied /
 * dismissed) → close the Herdr review panel. Errors and aborts are not
 * terminal and keep the panel for a retry.
 */
export const shouldCloseReviewPanel = (decision: ReviewDecisionLike): boolean =>
  decision.approved === true ||
  decision.approved === false ||
  decision.dismissed === true;

/** Tracked info about the Herdr panel this session last opened. */
export type LastOpened = { strategy: "split" | "new-tab"; paneId?: string };

/**
 * Pure: how should the shell close the panel tracked for this session?
 * Returns null when nothing is tracked (this session never opened a panel)
 * — the shell must then do nothing, never touching panes/tabs opened by
 * someone else.
 */
export const pickCloseTarget = (
  last: LastOpened | undefined,
): { kind: "pane"; paneId: string } | { kind: "active-tab" } | null => {
  if (!last) return null;
  if (last.strategy === "split" && last.paneId) {
    return { kind: "pane", paneId: last.paneId };
  }
  return { kind: "active-tab" };
};

// ---------------------------------------------------------------------------
// Imperative Shell — thin wrappers around IO
// ---------------------------------------------------------------------------

const availabilityCache = new Map<string, boolean>();
const whichCheck = (): boolean => {
  try {
    const bunWhich = (
      globalThis as unknown as {
        Bun?: { which?: (bin: string) => string | null };
      }
    ).Bun?.which;
    if (typeof bunWhich === "function") {
      return !!bunWhich("terminal-browser");
    }
    return false;
  } catch {
    return false;
  }
};

const spawnCheck = (timeoutMs = 1000): Promise<boolean> =>
  new Promise((resolve) => {
    const child = spawn("terminal-browser", ["--version"], {
      stdio: "ignore",
      timeout: timeoutMs,
    });
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
    setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finish(false);
    }, timeoutMs + 100);
  });

export const isTerminalBrowserAvailable = async (
  sessionKey?: string,
): Promise<boolean> => {
  if (sessionKey && availabilityCache.has(sessionKey)) {
    return availabilityCache.get(sessionKey)!;
  }
  let available = false;
  if (whichCheck()) {
    available = true;
  } else {
    available = await spawnCheck(1000);
  }
  if (sessionKey) {
    availabilityCache.set(sessionKey, available);
  }
  log.debug("terminal-browser availability", { sessionKey, available });
  return available;
};

export const clearTerminalBrowserCache = (sessionKey?: string): void => {
  if (sessionKey) {
    availabilityCache.delete(sessionKey);
  } else {
    availabilityCache.clear();
  }
};

export const shouldUseTerminalBrowser = async (
  ctx: {
    cwd: string;
    sessionManager: { getSessionFile: () => string | null | undefined };
  },
  hostMode: ReviewHostMode = "browser",
): Promise<boolean> => {
  // Functional Core short-circuit: never use terminal-browser in test runs
  // (keeps unit tests hermetic; manual Herdr verification still works).
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return false;
  }
  const key = getSessionKey(ctx);
  const available = await isTerminalBrowserAvailable(key);
  return resolveReviewHost({
    mode: hostMode,
    isHerdrEnv: isHerdrEnvironment(process.env),
    terminalBrowserAvailable: available,
  });
};

// ---------------------------------------------------------------------------
// READY_FILE polling (Shell)
// ---------------------------------------------------------------------------

export const waitForReadyFile = async (
  readyFile: string,
  signal?: AbortSignal,
  timeoutMs = 8000,
): Promise<string | null> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      return null;
    }
    try {
      if (fs.existsSync(readyFile)) {
        const content = fs.readFileSync(readyFile, "utf8");
        const url = extractFirstUrlFromReadyContent(content);
        if (url) {
          log.debug("ready file url found", { readyFile, url });
          return url;
        }
      }
    } catch (error) {
      log.debug("ready file read failed", { readyFile, error: String(error) });
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 100);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
  log.debug("waitForReadyFile timeout", { readyFile, timeoutMs });
  return null;
};

export const createTempReadyFile = async (): Promise<string> => {
  const dir = os.tmpdir();
  const name = `plannotator-ready-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jsonl`;
  const file = path.join(dir, name);
  fs.writeFileSync(file, "", { mode: 0o600 });
  return file;
};

export const removeTempReadyFile = (file: string): void => {
  try {
    fs.rmSync(file, { force: true });
  } catch {}
};

// ---------------------------------------------------------------------------
// Herdr + terminal-browser open (Shell, thin)
// ---------------------------------------------------------------------------

const runCommand = (
  command: string,
  args: string[],
  timeoutMs = 5000,
): Promise<{ stdout: string; stderr: string; code: number | null }> =>
  new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      resolve({ stdout, stderr, code });
    };
    child.on("error", () => finish(1));
    child.on("close", finish);
    setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finish(1);
    }, timeoutMs);
  });

const hasHerdrRightPane = async (): Promise<boolean> => {
  // Probe the edges of the pane that launched this extension (HERDR_PANE_ID),
  // NOT the focused pane: opening a review panel moves focus to the new pane,
  // so an unnamed probe would measure the new pane's own edges (always
  // rightmost) and wrongly decide to split again.
  const args = process.env.HERDR_PANE_ID
    ? ["pane", "edges", "--pane", process.env.HERDR_PANE_ID]
    : ["pane", "edges"];
  try {
    const result = await runCommand("herdr", args, 2000);
    if (result.code !== 0) return false;
    return hasRightNeighborFromEdgesOutput(result.stdout) === true;
  } catch {
    return false;
  }
};

export const resolveHerdrPanelStrategy = async (): Promise<
  "split" | "new-tab"
> => {
  const hasRightPane = await hasHerdrRightPane();
  // Split right only when the launcher pane has no right neighbor yet; once a
  // right pane exists, reuse it via new-tab instead of over-splitting.
  return hasRightPane ? "new-tab" : "split";
};

// --- Track last opened pane/tab per sessionKey for precise close on terminal verdict ---

const lastOpenedByKey = new Map<string, LastOpened>();

const getHerdrPaneIds = async (): Promise<string[]> => {
  try {
    const result = await runCommand("herdr", ["pane", "list"], 2000);
    if (result.code !== 0) return [];
    const parsed = JSON.parse(result.stdout) as {
      result?: { panes?: Array<{ pane_id?: string }> };
      panes?: Array<{ pane_id?: string }>;
    };
    const panes = parsed.result?.panes ?? parsed.panes ?? [];
    return panes
      .map((p) => (typeof p.pane_id === "string" ? p.pane_id : null))
      .filter((id): id is string => !!id);
  } catch {
    return [];
  }
};

const findNewPaneId = (before: string[], after: string[]): string | null => {
  const beforeSet = new Set(before);
  const added = after.filter((id) => !beforeSet.has(id));
  return added.length === 1 ? added[0] : (added[0] ?? null);
};

export const openUrlInHerdrTerminalBrowser = async (
  url: string,
  ctx?: {
    cwd: string;
    sessionManager: { getSessionFile: () => string | null | undefined };
  },
): Promise<void> => {
  const strategy = await resolveHerdrPanelStrategy();
  const sessionKey = ctx ? getSessionKey(ctx) : "global";
  log.debug("opening url in terminal-browser", { url, strategy, sessionKey });

  if (strategy === "split") {
    // Herdr panel concept: --split right creates a new Herdr pane; track it for close on the terminal verdict
    const beforeIds = await getHerdrPaneIds();
    const result = await runCommand(
      "terminal-browser",
      ["open", url, "--split", "right", "--size", "0.45"],
      5000,
    );
    if (result.code !== 0) {
      log.warn("terminal-browser open failed", {
        stderr: result.stderr.slice(0, 200),
        url,
      });
      return;
    }
    // Brief settle then diff pane list to capture the new pane id
    await new Promise((r) => setTimeout(r, 300));
    const afterIds = await getHerdrPaneIds();
    const newPaneId = findNewPaneId(beforeIds, afterIds);
    if (newPaneId) {
      lastOpenedByKey.set(sessionKey, { strategy, paneId: newPaneId });
      log.info("terminal-browser opened url (tracked pane)", {
        url,
        strategy,
        paneId: newPaneId,
      });
    } else {
      lastOpenedByKey.set(sessionKey, { strategy });
      log.info("terminal-browser opened url (pane not tracked)", {
        url,
        strategy,
      });
    }
    return;
  }

  // new-tab: reuse existing terminal-browser pane, open new browser tab
  let result = await runCommand("terminal-browser", ["new-tab", url], 5000);
  if (result.code !== 0) {
    log.warn("terminal-browser new-tab failed, fallback to open --split", {
      stderr: result.stderr.slice(0, 200),
    });
    const beforeIds = await getHerdrPaneIds();
    result = await runCommand(
      "terminal-browser",
      ["open", url, "--split", "right", "--size", "0.45"],
      5000,
    );
    if (result.code === 0) {
      await new Promise((r) => setTimeout(r, 300));
      const afterIds = await getHerdrPaneIds();
      const newPaneId = findNewPaneId(beforeIds, afterIds);
      lastOpenedByKey.set(sessionKey, {
        strategy: "split",
        paneId: newPaneId ?? undefined,
      });
    }
  } else {
    // new-tab succeeded: store as tab (no paneId); close will use browser tab close
    lastOpenedByKey.set(sessionKey, { strategy: "new-tab" });
    log.info("terminal-browser opened url (new-tab)", { url });
    return;
  }
  if (result.code !== 0) {
    log.warn("terminal-browser open failed", {
      stderr: result.stderr.slice(0, 200),
      url,
    });
  } else {
    log.info("terminal-browser opened url", { url, strategy });
  }
};

/**
 * Shell: terminal verdict → close the panel this review opened
 * (fire-and-forget, mirrors the fire-and-forget open).
 */
export const closeReviewPanelOnTerminalDecision = (
  decision: ReviewDecisionLike,
  ctx?: {
    cwd: string;
    sessionManager: { getSessionFile: () => string | null | undefined };
  },
): void => {
  if (!shouldCloseReviewPanel(decision)) return;
  void tryCloseTerminalBrowserTab(ctx).catch(() => {});
};

/**
 * Shell: close the Herdr panel this session opened (tracked in
 * lastOpenedByKey). Strictly per-session: with nothing tracked for this
 * session it does nothing — never closing another session's pane or an
 * unrelated active tab. Errors and aborts never reach here (runCli only
 * calls this on a handled terminal verdict).
 */
export const tryCloseTerminalBrowserTab = async (ctx?: {
  cwd: string;
  sessionManager: { getSessionFile: () => string | null | undefined };
}): Promise<void> => {
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return;
  }
  const sessionKey = ctx ? getSessionKey(ctx) : "global";
  // Functional Core already picked the target; here we only execute the shell.
  const target = pickCloseTarget(lastOpenedByKey.get(sessionKey));
  if (!target) return;
  if (target.kind === "pane") {
    // Precise close: the pane that --split right created for this review
    const result = await runCommand(
      "herdr",
      ["pane", "close", target.paneId],
      3000,
    );
    if (result.code === 0) {
      log.info("closed herdr pane for terminal review verdict", {
        paneId: target.paneId,
      });
      lastOpenedByKey.delete(sessionKey);
      return;
    }
    log.warn("herdr pane close failed, fallback to active tab", {
      paneId: target.paneId,
      stderr: result.stderr.slice(0, 200),
    });
  }
  // new-tab case / pane close failed: close the active browser tab
  try {
    const result = await runCommand(
      "terminal-browser",
      ["action", "--", "close"],
      2000,
    );
    if (result.code !== 0) {
      log.debug("terminal-browser action close failed", {
        stderr: result.stderr.slice(0, 200),
      });
    } else {
      log.info("closed terminal-browser tab for terminal review verdict");
    }
  } catch {
    // ignore
  } finally {
    lastOpenedByKey.delete(sessionKey);
  }
};

export const clearLastOpened = (sessionKey?: string): void => {
  if (sessionKey) {
    lastOpenedByKey.delete(sessionKey);
  } else {
    lastOpenedByKey.clear();
  }
};

// Backward compat for tests that import the old name
export const clearLastOpenedForTests = clearLastOpened;
