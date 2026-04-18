import fs from "node:fs";
import path from "node:path";

import {
  type SessionEntry,
  type SessionHeader,
  SessionManager,
} from "@mariozechner/pi-coding-agent";

type SessionSnapshotSource = {
  getHeader(): SessionHeader | null;
  getEntries(): SessionEntry[];
};

type ForkSessionForWorktreeInput = {
  currentSessionFile: string;
  worktreePath: string;
  sessionManager: SessionSnapshotSource;
};

const trimToNull = (value: string | null | undefined): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export function forkSessionForWorktree(
  input: ForkSessionForWorktreeInput,
): string | null {
  const sourcePath = trimToNull(input.currentSessionFile);
  if (!sourcePath) return null;

  if (fs.existsSync(sourcePath)) {
    const forked = SessionManager.forkFrom(sourcePath, input.worktreePath);
    return trimToNull(forked.getSessionFile());
  }

  const sourceHeader = input.sessionManager.getHeader();
  const sourceEntries = input.sessionManager.getEntries();

  if (!sourceHeader) return null;

  const forked = SessionManager.create(input.worktreePath);
  const forkedPath = trimToNull(forked.getSessionFile());
  const forkedHeader = forked.getHeader();

  if (!forkedPath || !forkedHeader) return null;

  const headerParent = trimToNull(input.currentSessionFile);
  const fallbackParent =
    typeof sourceHeader.parentSession === "string"
      ? trimToNull(sourceHeader.parentSession)
      : null;

  const snapshotHeader: SessionHeader = {
    ...forkedHeader,
    parentSession: headerParent ?? fallbackParent ?? undefined,
  };

  const lines = [
    JSON.stringify(snapshotHeader),
    ...sourceEntries.map((entry) => JSON.stringify(entry)),
  ];

  fs.mkdirSync(path.dirname(forkedPath), { recursive: true });
  fs.writeFileSync(forkedPath, `${lines.join("\n")}\n`, "utf8");

  return forkedPath;
}
