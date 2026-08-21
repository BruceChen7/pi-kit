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

/** Pure: decide panel strategy from existing state. */
export const selectPanelStrategy = (options: {
  hasHerdrRightPane: boolean;
  hasExistingTerminalBrowser: boolean;
}): "split" | "new-tab" => {
  // Herdr panel concept: if right pane already exists, reuse via new-tab;
  // otherwise split a new pane.
  if (options.hasExistingTerminalBrowser && options.hasHerdrRightPane) {
    return "new-tab";
  }
  if (options.hasExistingTerminalBrowser) {
    return "new-tab";
  }
  return "split";
};

/** Pure: should close terminal-browser tab on decision. */
export const shouldAutoClose = (decision: { approved?: boolean }): boolean =>
  decision.approved === true;

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

export const shouldUseTerminalBrowser = async (ctx: {
  cwd: string;
  sessionManager: { getSessionFile: () => string | null | undefined };
}): Promise<boolean> => {
  // Functional Core short-circuit: never use terminal-browser in test runs
  // (keeps unit tests hermetic; manual Herdr verification still works).
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return false;
  }
  if (!isHerdrEnvironment(process.env)) {
    return false;
  }
  const key = getSessionKey(ctx);
  const available = await isTerminalBrowserAvailable(key);
  return available;
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

const hasExistingTerminalBrowser = async (): Promise<boolean> => {
  try {
    const result = await runCommand("terminal-browser", ["ls", "--json"], 2000);
    if (result.code !== 0) return false;
    const data = JSON.parse(result.stdout) as {
      browsers?: unknown[];
      tabs?: unknown[];
    };
    // terminal-browser ls --json shape varies; treat any non-empty browsers/tabs as existing
    const browsers = (data as { browsers?: unknown[] }).browsers;
    const tabs = (data as { tabs?: unknown[] }).tabs;
    if (Array.isArray(browsers) && browsers.length > 0) return true;
    if (Array.isArray(tabs) && tabs.length > 0) return true;
    // Fallback: raw stdout contains "browser" or "tab"
    return result.stdout.includes("browser") || result.stdout.includes("tab");
  } catch {
    return false;
  }
};

const hasHerdrRightPane = async (): Promise<boolean> => {
  // Lightweight probe: if herdr CLI is available and pane list succeeds,
  // assume we can inspect layout. Failure → false (fall back to split).
  try {
    const paneResult = await runCommand(
      "herdr",
      ["pane", "list", "--json"],
      2000,
    );
    if (paneResult.code !== 0) return false;
    // If pane list is non-empty, there is at least one pane; we conservatively
    // claim "right pane exists" when ≥2 panes to avoid over-splitting.
    const parsed = JSON.parse(paneResult.stdout) as {
      panes?: unknown[];
      result?: { panes?: unknown[] };
    };
    const panes = parsed.panes ?? parsed.result?.panes ?? [];
    return Array.isArray(panes) && panes.length >= 2;
  } catch {
    return false;
  }
};

export const resolveHerdrPanelStrategy = async (): Promise<
  "split" | "new-tab"
> => {
  const [hasBrowser, hasRightPane] = await Promise.all([
    hasExistingTerminalBrowser(),
    hasHerdrRightPane(),
  ]);
  return selectPanelStrategy({
    hasExistingTerminalBrowser: hasBrowser,
    hasHerdrRightPane: hasRightPane,
  });
};

// --- Track last opened pane/tab per sessionKey for precise close on approved ---

type LastOpened = { strategy: "split" | "new-tab"; paneId?: string };

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
    // Herdr panel concept: --split right creates a new Herdr pane; track it for close on approved
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

export const tryCloseTerminalBrowserTab = async (ctx?: {
  cwd: string;
  sessionManager: { getSessionFile: () => string | null | undefined };
}): Promise<void> => {
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return;
  }
  const sessionKey = ctx ? getSessionKey(ctx) : "global";
  const last = lastOpenedByKey.get(sessionKey) ?? lastOpenedByKey.get("global");
  // Functional Core already decided shouldAutoClose; here we only execute the shell
  if (last?.strategy === "split" && last.paneId) {
    // Precise close: the pane that --split right created for this review
    const result = await runCommand(
      "herdr",
      ["pane", "close", last.paneId],
      3000,
    );
    if (result.code === 0) {
      log.info("closed herdr pane for approved review", {
        paneId: last.paneId,
      });
      lastOpenedByKey.delete(sessionKey);
      lastOpenedByKey.delete("global");
      return;
    }
    log.warn("herdr pane close failed, fallback to generic", {
      paneId: last.paneId,
      stderr: result.stderr.slice(0, 200),
    });
  }
  // Fallback / new-tab case: close active browser tab
  try {
    const result = await runCommand(
      "terminal-browser",
      ["action", "--", "close"],
      2000,
    );
    if (result.code !== 0) {
      // Last resort: try herdr pane close on current pane's right neighbor? noop
      log.debug("terminal-browser action close failed", {
        stderr: result.stderr.slice(0, 200),
      });
    } else {
      log.info("closed terminal-browser tab for approved review");
    }
  } catch {
    // ignore
  } finally {
    lastOpenedByKey.delete(sessionKey);
    lastOpenedByKey.delete("global");
  }
};

export const clearLastOpened = (sessionKey?: string): void => {
  if (sessionKey) {
    lastOpenedByKey.delete(sessionKey);
    // "global" is used as fallback key in tryClose; clean it when clearing a real session
    if (sessionKey !== "global") {
      lastOpenedByKey.delete("global");
    }
  } else {
    lastOpenedByKey.clear();
  }
};

// Backward compat for tests that import the old name
export const clearLastOpenedForTests = clearLastOpened;
