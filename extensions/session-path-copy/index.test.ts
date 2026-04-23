import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import sessionPathCopyExtension, { copyCurrentSessionPath } from "./index.js";

const createTempDir = (prefix: string): string =>
  fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const readJsonLines = (filePath: string): unknown[] =>
  fs
    .readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);

const createUserMessage = (content: string) => ({
  role: "user" as const,
  content,
  timestamp: Date.now(),
});

const createAssistantMessage = (text: string) => ({
  role: "assistant" as const,
  content: [{ type: "text" as const, text }],
  api: "test-api",
  provider: "test-provider",
  model: "test-model",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  },
  stopReason: "stop" as const,
  timestamp: Date.now(),
});

const seedConversation = (sessionManager: SessionManager): void => {
  sessionManager.appendMessage(createUserMessage("hello"));
  sessionManager.appendMessage(createAssistantMessage("world"));
};

type TestCtx = {
  cwd: string;
  hasUI: boolean;
  ui: {
    notify: ReturnType<typeof vi.fn>;
    setStatus: ReturnType<typeof vi.fn>;
  };
  sessionManager: unknown;
  modelRegistry: object;
  model: undefined;
  isIdle: () => boolean;
  signal: undefined;
  abort: ReturnType<typeof vi.fn>;
  hasPendingMessages: () => boolean;
  shutdown: ReturnType<typeof vi.fn>;
  getContextUsage: () => undefined;
  compact: ReturnType<typeof vi.fn>;
  getSystemPrompt: () => string;
};

const createCtx = (sessionManager: unknown, cwd: string): TestCtx => ({
  cwd,
  hasUI: false,
  ui: {
    notify: vi.fn(),
    setStatus: vi.fn(),
  },
  sessionManager,
  modelRegistry: {},
  model: undefined,
  isIdle: () => true,
  signal: undefined,
  abort: vi.fn(),
  hasPendingMessages: () => false,
  shutdown: vi.fn(),
  getContextUsage: () => undefined,
  compact: vi.fn(),
  getSystemPrompt: () => "",
});

type ShortcutRegistration = {
  description: string;
  handler: (ctx: TestCtx) => Promise<void> | void;
};

const createFakePi = () => {
  const shortcuts = new Map<string, ShortcutRegistration>();

  return {
    shortcuts,
    api: {
      registerShortcut: vi.fn(
        (shortcut: unknown, registration: ShortcutRegistration) => {
          shortcuts.set(String(shortcut), registration);
        },
      ),
    },
  };
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("session-path-copy", () => {
  it("registers the Ctrl+Shift+J shortcut", () => {
    const { api, shortcuts } = createFakePi();

    sessionPathCopyExtension(api as never);

    expect(shortcuts.has("ctrl+shift+j")).toBe(true);
    expect(shortcuts.get("ctrl+shift+j")?.description).toContain(
      "Ctrl+Shift+J",
    );
  });

  it("copies the existing persisted session path", async () => {
    const cwd = createTempDir("session-path-copy-cwd-");
    const sessionDir = createTempDir("session-path-copy-dir-");
    const sessionManager = SessionManager.create(cwd, sessionDir);
    const copied: string[] = [];
    const ctx = createCtx(sessionManager, cwd);

    const result = await copyCurrentSessionPath(ctx as never, {
      copy: (text) => copied.push(text),
    });

    expect(result).toEqual({
      ok: true,
      path: sessionManager.getSessionFile(),
      persistedNow: false,
    });
    expect(copied).toEqual([sessionManager.getSessionFile()]);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Copied session path to clipboard",
      "info",
    );
  });

  it("persists an ephemeral session, binds it, and copies the bound path", async () => {
    const cwd = createTempDir("session-path-copy-ephemeral-cwd-");
    const sessionDir = createTempDir("session-path-copy-ephemeral-dir-");
    const sessionManager = SessionManager.inMemory(cwd);
    const copied: string[] = [];
    const ctx = createCtx(sessionManager, cwd);
    const originalCreate = SessionManager.create;

    seedConversation(sessionManager);

    vi.spyOn(SessionManager, "create").mockImplementation(
      (createCwd: string, createSessionDir?: string) =>
        originalCreate(
          createCwd,
          createSessionDir ?? sessionDir,
        ) as SessionManager,
    );

    const result = await copyCurrentSessionPath(ctx as never, {
      copy: (text) => copied.push(text),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected persisted session path result");
    }

    expect(result.persistedNow).toBe(true);
    expect(copied).toEqual([result.path]);
    expect(fs.existsSync(result.path)).toBe(true);
    expect(sessionManager.getSessionFile()).toBe(result.path);
    expect(readJsonLines(result.path)).toHaveLength(
      sessionManager.getEntries().length + 1,
    );

    const beforeAppendLineCount = readJsonLines(result.path).length;
    sessionManager.appendCustomEntry("after-bind", { ok: true });
    expect(readJsonLines(result.path)).toHaveLength(beforeAppendLineCount + 1);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Persisted session, switched, and copied path",
      "info",
    );
  });

  it("warns when no session snapshot is available", async () => {
    const cwd = createTempDir("session-path-copy-missing-header-");
    const copied: string[] = [];
    const ctx = createCtx(
      {
        getSessionFile: () => undefined,
        getHeader: () => null,
        getEntries: () => [],
      },
      cwd,
    );

    const result = await copyCurrentSessionPath(ctx as never, {
      copy: (text) => copied.push(text),
    });

    expect(result).toEqual({ ok: false, reason: "missing-session-header" });
    expect(copied).toHaveLength(0);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "No session snapshot available",
      "warning",
    );
  });

  it("cleans up the persisted file when activation fails", async () => {
    const cwd = createTempDir("session-path-copy-activation-cwd-");
    const sessionDir = createTempDir("session-path-copy-activation-dir-");
    const source = SessionManager.inMemory(cwd);
    const copied: string[] = [];
    const originalCreate = SessionManager.create;

    seedConversation(source);

    vi.spyOn(SessionManager, "create").mockImplementation(
      (createCwd: string, createSessionDir?: string) =>
        originalCreate(
          createCwd,
          createSessionDir ?? sessionDir,
        ) as SessionManager,
    );

    const ctx = createCtx(
      {
        getSessionFile: () => undefined,
        getHeader: () => source.getHeader(),
        getEntries: () => source.getEntries(),
      },
      cwd,
    );

    const result = await copyCurrentSessionPath(ctx as never, {
      copy: (text) => copied.push(text),
    });

    expect(result).toEqual({
      ok: false,
      reason: "activate-persisted-session-failed",
    });
    expect(copied).toHaveLength(0);
    expect(fs.readdirSync(sessionDir)).toHaveLength(0);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Failed to activate persisted session",
      "warning",
    );
  });

  it("warns when writing the snapshot fails", async () => {
    const cwd = createTempDir("session-path-copy-write-failure-");
    const sessionDir = createTempDir("session-path-copy-write-dir-");
    const sessionManager = SessionManager.inMemory(cwd);
    const copied: string[] = [];
    const ctx = createCtx(sessionManager, cwd);
    const originalCreate = SessionManager.create;

    seedConversation(sessionManager);

    vi.spyOn(SessionManager, "create").mockImplementation(
      (createCwd: string, createSessionDir?: string) =>
        originalCreate(
          createCwd,
          createSessionDir ?? sessionDir,
        ) as SessionManager,
    );
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("disk full");
    });

    const result = await copyCurrentSessionPath(ctx as never, {
      copy: (text) => copied.push(text),
    });

    expect(result).toEqual({
      ok: false,
      reason: "persist-session-snapshot-failed",
    });
    expect(copied).toHaveLength(0);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Failed to persist session snapshot",
      "warning",
    );
  });

  it("does not touch stale UI when clearing copied status after session replacement", async () => {
    vi.useFakeTimers();

    const cwd = createTempDir("session-path-copy-stale-status-cwd-");
    const sessionDir = createTempDir("session-path-copy-stale-status-dir-");
    const sessionManager = SessionManager.create(cwd, sessionDir);
    const copied: string[] = [];
    const ctx = createCtx(sessionManager, cwd);
    ctx.hasUI = true;

    let stale = false;
    ctx.ui.setStatus.mockImplementation(() => {
      if (stale) {
        throw new Error(
          "This extension instance is stale after session replacement or reload. Use the provided replacement-session context instead.",
        );
      }
    });

    const result = await copyCurrentSessionPath(ctx as never, {
      copy: (text) => copied.push(text),
    });

    expect(result).toEqual({
      ok: true,
      path: sessionManager.getSessionFile(),
      persistedNow: false,
    });
    expect(copied).toEqual([sessionManager.getSessionFile()]);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "session-path-copy",
      "Copied session path to clipboard",
    );

    stale = true;
    expect(() => vi.advanceTimersByTime(2_000)).not.toThrow();
  });
});
