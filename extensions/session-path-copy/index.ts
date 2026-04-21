import fs from "node:fs";
import path from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
  SessionHeader,
} from "@mariozechner/pi-coding-agent";
import { copyToClipboard, SessionManager } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";

const STATUS_KEY = "session-path-copy";
const STATUS_DURATION_MS = 2000;

type StatusLevel = "info" | "warning";
type TimerRef = { value: ReturnType<typeof setTimeout> | null };
type CopySessionPathOptions = {
  copy?: (text: string) => void;
  clearTimerRef?: TimerRef;
};

type CopySessionPathResult =
  | { ok: true; path: string; persistedNow: boolean }
  | { ok: false; reason: string };

type MutableSessionManager = {
  persist: boolean;
  sessionDir: string;
  setSessionFile: (sessionPath: string) => void;
};

function showStatus(
  ctx: ExtensionContext,
  message: string,
  level: StatusLevel,
  clearTimerRef: TimerRef,
): void {
  if (ctx.hasUI) {
    ctx.ui.setStatus(STATUS_KEY, message);
    if (clearTimerRef.value) {
      clearTimeout(clearTimerRef.value);
    }
    clearTimerRef.value = setTimeout(() => {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      clearTimerRef.value = null;
    }, STATUS_DURATION_MS);
    return;
  }

  ctx.ui.notify(message, level);
}

export function trimToNull(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function persistSessionSnapshot(
  cwd: string,
  header: SessionHeader,
  entries: SessionEntry[],
): string | null {
  const persisted = SessionManager.create(cwd);
  const persistedPath = trimToNull(persisted.getSessionFile());
  const persistedHeader = persisted.getHeader();

  if (!persistedPath || !persistedHeader) {
    return null;
  }

  const parentSession = trimToNull(header.parentSession);
  const snapshotHeader: SessionHeader = {
    ...persistedHeader,
    parentSession: parentSession ?? undefined,
  };

  const lines = [
    JSON.stringify(snapshotHeader),
    ...entries.map((entry) => JSON.stringify(entry)),
  ];

  fs.mkdirSync(path.dirname(persistedPath), { recursive: true });
  fs.writeFileSync(persistedPath, `${lines.join("\n")}\n`, "utf8");

  return persistedPath;
}

export function activatePersistedSession(
  sessionManager: ExtensionContext["sessionManager"],
  sessionPath: string,
): void {
  if (!(sessionManager instanceof SessionManager)) {
    throw new Error("Session manager cannot be rebound from shortcut context");
  }

  const mutableSessionManager = sessionManager as unknown as MutableSessionManager;
  mutableSessionManager.persist = true;
  mutableSessionManager.sessionDir = path.dirname(sessionPath);
  mutableSessionManager.setSessionFile(sessionPath);
}

function cleanupSessionFile(sessionPath: string): void {
  try {
    fs.rmSync(sessionPath, { force: true });
  } catch {
    // Best effort cleanup only.
  }
}

export async function copyCurrentSessionPath(
  ctx: ExtensionContext,
  options: CopySessionPathOptions = {},
): Promise<CopySessionPathResult> {
  const clearTimerRef = options.clearTimerRef ?? { value: null };
  const copy = options.copy ?? copyToClipboard;
  const existingPath = trimToNull(ctx.sessionManager.getSessionFile());

  if (existingPath) {
    copy(existingPath);
    showStatus(ctx, "Copied session path to clipboard", "info", clearTimerRef);
    return { ok: true, path: existingPath, persistedNow: false };
  }

  const header = ctx.sessionManager.getHeader();
  if (!header) {
    showStatus(ctx, "No session snapshot available", "warning", clearTimerRef);
    return { ok: false, reason: "missing-session-header" };
  }

  const entries = ctx.sessionManager.getEntries();

  let persistedPath: string | null;
  try {
    persistedPath = persistSessionSnapshot(ctx.cwd, header, entries);
  } catch {
    showStatus(
      ctx,
      "Failed to persist session snapshot",
      "warning",
      clearTimerRef,
    );
    return { ok: false, reason: "persist-session-snapshot-failed" };
  }

  if (!persistedPath) {
    showStatus(
      ctx,
      "Failed to persist session snapshot",
      "warning",
      clearTimerRef,
    );
    return { ok: false, reason: "missing-persisted-session-path" };
  }

  try {
    activatePersistedSession(ctx.sessionManager, persistedPath);
  } catch {
    cleanupSessionFile(persistedPath);
    showStatus(
      ctx,
      "Failed to activate persisted session",
      "warning",
      clearTimerRef,
    );
    return { ok: false, reason: "activate-persisted-session-failed" };
  }

  const activePath = trimToNull(ctx.sessionManager.getSessionFile());
  if (!activePath) {
    cleanupSessionFile(persistedPath);
    showStatus(
      ctx,
      "Failed to activate persisted session",
      "warning",
      clearTimerRef,
    );
    return { ok: false, reason: "missing-active-session-path" };
  }

  copy(activePath);
  showStatus(
    ctx,
    "Persisted session, switched, and copied path",
    "info",
    clearTimerRef,
  );

  return { ok: true, path: activePath, persistedNow: true };
}

export default function sessionPathCopyExtension(pi: ExtensionAPI) {
  const clearTimerRef: TimerRef = { value: null };

  pi.registerShortcut(Key.ctrlShift("j"), {
    description: "Copy current session JSONL path (Ctrl+Shift+J)",
    handler: async (ctx) => {
      await copyCurrentSessionPath(ctx, { clearTimerRef });
    },
  });
}
