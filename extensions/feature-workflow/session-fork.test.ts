import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SessionManager } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { forkSessionForWorktree } from "./session-fork.js";

const createTempDir = (prefix: string): string =>
  fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const readJsonLines = (filePath: string): unknown[] =>
  fs
    .readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);

const writeSnapshot = (
  sessionManager: SessionManager,
  filePath: string,
): void => {
  const header = sessionManager.getHeader();
  if (!header) throw new Error("session header missing");

  const lines = [
    JSON.stringify(header),
    ...sessionManager.getEntries().map((entry) => JSON.stringify(entry)),
  ];

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
};

describe("session-fork", () => {
  it("creates a worktree session from in-memory snapshot when source session file is missing", () => {
    const sourceCwd = createTempDir("pi-kit-fw-source-");
    const worktreePath = createTempDir("pi-kit-fw-worktree-");

    const source = SessionManager.create(sourceCwd);
    source.appendCustomEntry("test", { hello: "world" });

    const currentSessionFile = source.getSessionFile();
    expect(currentSessionFile).toBeTruthy();
    expect(fs.existsSync(currentSessionFile as string)).toBe(false);

    const forkedPath = forkSessionForWorktree({
      currentSessionFile: currentSessionFile as string,
      worktreePath,
      sessionManager: source,
    });

    expect(forkedPath).toBeTruthy();
    expect(fs.existsSync(forkedPath as string)).toBe(true);

    const lines = readJsonLines(forkedPath as string) as Array<
      Record<string, unknown>
    >;
    expect(lines[0]?.type).toBe("session");
    expect(lines[0]?.cwd).toBe(worktreePath);
    expect(lines[0]?.parentSession).toBe(currentSessionFile);
    expect(lines.length).toBe(source.getEntries().length + 1);
  });

  it("uses SessionManager.forkFrom when source session file already exists", () => {
    const sourceCwd = createTempDir("pi-kit-fw-source-existing-");
    const worktreePath = createTempDir("pi-kit-fw-worktree-existing-");

    const source = SessionManager.create(sourceCwd);
    source.appendCustomEntry("test", { snapshot: true });

    const currentSessionFile = source.getSessionFile();
    expect(currentSessionFile).toBeTruthy();

    writeSnapshot(source, currentSessionFile as string);
    expect(fs.existsSync(currentSessionFile as string)).toBe(true);

    const forkedPath = forkSessionForWorktree({
      currentSessionFile: currentSessionFile as string,
      worktreePath,
      sessionManager: source,
    });

    expect(forkedPath).toBeTruthy();
    const lines = readJsonLines(forkedPath as string) as Array<
      Record<string, unknown>
    >;
    expect(lines[0]?.type).toBe("session");
    expect(lines[0]?.cwd).toBe(worktreePath);
    expect(lines[0]?.parentSession).toBe(currentSessionFile);
  });
});
