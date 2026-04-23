import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { clearSettingsCache, getSettingsPaths } from "../shared/settings.ts";

type Handler = (event: unknown, ctx: TestContext) => Promise<unknown> | unknown;

type TestContext = {
  cwd: string;
  hasUI: boolean;
  isIdle: () => boolean;
  ui: {
    select?: ReturnType<typeof vi.fn>;
    notify: ReturnType<typeof vi.fn>;
  };
  sessionManager: {
    getEntries: () => Array<Record<string, unknown>>;
    getSessionFile: () => string | undefined;
    getSessionName?: () => string | undefined;
  };
};

const tempDirs: string[] = [];
const originalHome = process.env.HOME;

const createTempDir = (prefix: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

const createTempHome = (): string => {
  const dir = createTempDir("pi-kit-remote-approval-home-");
  process.env.HOME = dir;
  return dir;
};

const restoreHome = (): void => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
};

const writeGlobalRemoteConfig = (
  cwd: string,
  remoteApproval: Record<string, unknown>,
): void => {
  const home = createTempHome();
  void home;
  const { globalPath } = getSettingsPaths(cwd);
  fs.mkdirSync(path.dirname(globalPath), { recursive: true });
  fs.writeFileSync(
    globalPath,
    JSON.stringify({ remoteApproval }, null, 2),
    "utf-8",
  );
};

const writeProjectRemoteConfig = (
  cwd: string,
  remoteApproval: Record<string, unknown>,
): void => {
  const { projectPath } = getSettingsPaths(cwd);
  fs.mkdirSync(path.dirname(projectPath), { recursive: true });
  fs.writeFileSync(
    projectPath,
    JSON.stringify({ remoteApproval }, null, 2),
    "utf-8",
  );
};

const buildPiHarness = () => {
  const handlers = new Map<string, Handler[]>();
  const appendEntry = vi.fn();
  const sendUserMessage = vi.fn();

  return {
    api: {
      on(event: string, handler: Handler) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      appendEntry,
      sendUserMessage,
    },
    appendEntry,
    sendUserMessage,
    handlers,
    async emit(event: string, payload: unknown, ctx: TestContext) {
      let result: unknown;
      for (const handler of handlers.get(event) ?? []) {
        result = await handler(payload, ctx);
      }
      return result;
    },
  };
};

const createContext = (
  cwd: string,
  overrides: Partial<TestContext> & {
    entries?: Array<Record<string, unknown>>;
    selectResult?: string | undefined;
    sessionFile?: string | undefined;
  } = {},
): TestContext => {
  const entries = overrides.entries ?? [];
  const sessionFile =
    overrides.sessionFile ?? path.join(cwd, ".pi", "sessions", "abc123.jsonl");

  return {
    cwd,
    hasUI: overrides.hasUI ?? true,
    isIdle: overrides.isIdle ?? (() => true),
    ui: {
      select: vi.fn(async () => overrides.selectResult ?? "Allow"),
      notify: vi.fn(),
      ...overrides.ui,
    },
    sessionManager: {
      getEntries: () => entries,
      getSessionFile: () => sessionFile,
      getSessionName: () => undefined,
      ...overrides.sessionManager,
    },
  };
};

const loadExtension = async () => {
  vi.resetModules();
  return (await import("./index.ts")).default;
};

afterEach(() => {
  clearSettingsCache();
  restoreHome();
  vi.restoreAllMocks();
  vi.doUnmock("../shared/logger.ts");
  vi.doUnmock("./channel/index.ts");
  vi.doUnmock("./flows/idle.ts");
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("remote-approval extension", () => {
  it("registers the expected lifecycle handlers", async () => {
    const harness = buildPiHarness();
    const remoteApprovalExtension = await loadExtension();

    remoteApprovalExtension(harness.api as unknown as ExtensionAPI);

    expect(Array.from(harness.handlers.keys()).sort()).toEqual([
      "agent_end",
      "session_shutdown",
      "session_start",
      "tool_call",
    ]);
  });

  it("logs session lifecycle and remote approval decisions", async () => {
    const cwd = createTempDir("pi-kit-remote-approval-repo-");
    writeGlobalRemoteConfig(cwd, {
      enabled: true,
      botToken: "123:abc",
      chatId: "1001",
      interceptTools: ["bash", "write", "edit"],
    });

    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    vi.doMock("../shared/logger.ts", () => ({
      createLogger: () => logger,
    }));
    vi.doMock("./channel/index.ts", () => ({
      createRemoteChannel: () => ({
        channel: {
          sendMessage: vi.fn(async () => 42),
          sendReply: vi.fn(async () => 77),
          sendReplyPrompt: vi.fn(async () => 99),
          editMessage: vi.fn(async () => undefined),
          poll: vi.fn(async () => ({ type: "callback", data: "deny" })),
        },
        error: null,
      }),
    }));

    const remoteApprovalExtension = await loadExtension();
    const harness = buildPiHarness();
    remoteApprovalExtension(harness.api as unknown as ExtensionAPI);
    const ctx = createContext(cwd, { hasUI: false });

    await harness.emit("session_start", {}, ctx);
    await harness.emit(
      "tool_call",
      { toolName: "bash", input: { command: "npm test" } },
      ctx,
    );
    await harness.emit("session_shutdown", {}, ctx);

    expect(logger.info).toHaveBeenCalledWith(
      "session_start",
      expect.objectContaining({
        sessionId: "abc123",
        sessionLabel: `${path.basename(cwd)} · abc123`,
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      "approval_resolved",
      expect.objectContaining({
        decision: "deny",
        resolvedBy: "remote",
        toolName: "bash",
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      "session_shutdown",
      expect.objectContaining({
        sessionId: "abc123",
      }),
    );
  });

  it("skips tools outside the configured intercept list", async () => {
    const cwd = createTempDir("pi-kit-remote-approval-repo-");
    const remoteApprovalExtension = await loadExtension();
    writeGlobalRemoteConfig(cwd, {
      enabled: true,
      interceptTools: ["bash", "write", "edit"],
    });
    const harness = buildPiHarness();
    remoteApprovalExtension(harness.api as unknown as ExtensionAPI);
    const ctx = createContext(cwd);

    await harness.emit("session_start", {}, ctx);
    const result = await harness.emit(
      "tool_call",
      { toolName: "read", input: { path: "README.md" } },
      ctx,
    );

    expect(result).toBeUndefined();
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it("skips approval when a restored session allow rule matches", async () => {
    const cwd = createTempDir("pi-kit-remote-approval-repo-");
    const remoteApprovalExtension = await loadExtension();
    writeGlobalRemoteConfig(cwd, {
      enabled: true,
      interceptTools: ["bash", "write", "edit"],
    });
    const harness = buildPiHarness();
    remoteApprovalExtension(harness.api as unknown as ExtensionAPI);
    const ctx = createContext(cwd, {
      entries: [
        {
          type: "custom",
          customType: "remote-approval-allow-rule",
          data: {
            toolName: "bash",
            scope: "exact-command",
            value: "npm test",
            createdAt: 1,
          },
        },
      ],
    });

    await harness.emit("session_start", {}, ctx);
    const result = await harness.emit(
      "tool_call",
      { toolName: "bash", input: { command: "npm test" } },
      ctx,
    );

    expect(result).toBeUndefined();
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it("blocks when the local user selects Deny", async () => {
    const cwd = createTempDir("pi-kit-remote-approval-repo-");
    const remoteApprovalExtension = await loadExtension();
    writeGlobalRemoteConfig(cwd, {
      enabled: true,
      interceptTools: ["bash", "write", "edit"],
    });
    const harness = buildPiHarness();
    remoteApprovalExtension(harness.api as unknown as ExtensionAPI);
    const ctx = createContext(cwd, { selectResult: "Deny" });

    await harness.emit("session_start", {}, ctx);
    const result = await harness.emit(
      "tool_call",
      { toolName: "bash", input: { command: "npm test" } },
      ctx,
    );

    expect(ctx.ui.select).toHaveBeenCalled();
    expect(result).toEqual({
      block: true,
      reason: "Blocked by user via local approval",
    });
  });

  it("persists a session allow rule when the local user selects Always", async () => {
    const cwd = createTempDir("pi-kit-remote-approval-repo-");
    const remoteApprovalExtension = await loadExtension();
    writeGlobalRemoteConfig(cwd, {
      enabled: true,
      interceptTools: ["bash", "write", "edit"],
    });
    const harness = buildPiHarness();
    remoteApprovalExtension(harness.api as unknown as ExtensionAPI);
    const ctx = createContext(cwd, { selectResult: "Always" });

    await harness.emit("session_start", {}, ctx);
    const first = await harness.emit(
      "tool_call",
      { toolName: "bash", input: { command: "npm test" } },
      ctx,
    );
    const second = await harness.emit(
      "tool_call",
      { toolName: "bash", input: { command: "npm test" } },
      ctx,
    );

    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    expect(ctx.ui.select).toHaveBeenCalledTimes(1);
    expect(harness.appendEntry).toHaveBeenCalledWith(
      "remote-approval-allow-rule",
      {
        toolName: "bash",
        scope: "exact-command",
        value: "npm test",
        createdAt: expect.any(Number),
      },
    );
  });

  it("blocks in strict mode when remote approval is required but no local UI is available", async () => {
    const cwd = createTempDir("pi-kit-remote-approval-repo-");
    writeGlobalRemoteConfig(cwd, {
      enabled: true,
      strictRemote: true,
      interceptTools: ["bash", "write", "edit"],
    });
    vi.doMock("./channel/index.ts", () => ({
      createRemoteChannel: () => ({
        channel: null,
        error: { reason: "missing" },
      }),
    }));
    const remoteApprovalExtension = await loadExtension();
    const harness = buildPiHarness();
    remoteApprovalExtension(harness.api as unknown as ExtensionAPI);
    const ctx = createContext(cwd, { hasUI: false });

    await harness.emit("session_start", {}, ctx);
    const result = await harness.emit(
      "tool_call",
      { toolName: "bash", input: { command: "npm test" } },
      ctx,
    );

    expect(result).toEqual({
      block: true,
      reason: "Remote approval required but unavailable",
    });
  });

  it("project settings can extend the intercept tool list", async () => {
    const cwd = createTempDir("pi-kit-remote-approval-repo-");
    const remoteApprovalExtension = await loadExtension();
    writeGlobalRemoteConfig(cwd, {
      enabled: true,
      interceptTools: ["bash", "write", "edit"],
    });
    writeProjectRemoteConfig(cwd, {
      extraInterceptTools: ["deploy"],
    });
    const harness = buildPiHarness();
    remoteApprovalExtension(harness.api as unknown as ExtensionAPI);
    const ctx = createContext(cwd);

    await harness.emit("session_start", {}, ctx);
    await harness.emit(
      "tool_call",
      { toolName: "deploy", input: { environment: "prod" } },
      ctx,
    );

    expect(ctx.ui.select).toHaveBeenCalled();
  });

  it("blocks when remote approval denies before the local approval resolves", async () => {
    const cwd = createTempDir("pi-kit-remote-approval-repo-");
    writeGlobalRemoteConfig(cwd, {
      enabled: true,
      botToken: "123:abc",
      chatId: "1001",
      interceptTools: ["bash", "write", "edit"],
    });

    const channel = {
      sendMessage: vi.fn(async () => 42),
      editMessage: vi.fn(async () => undefined),
      sendReplyPrompt: vi.fn(async () => 99),
      poll: vi.fn(async () => ({ type: "callback", data: "deny" })),
    };

    vi.doMock("./channel/index.ts", () => ({
      createRemoteChannel: () => ({ channel, error: null }),
    }));

    const remoteApprovalExtension = await loadExtension();
    const harness = buildPiHarness();
    remoteApprovalExtension(harness.api as unknown as ExtensionAPI);
    const ctx = createContext(cwd, {
      ui: {
        select: vi.fn(async () => await new Promise<string>(() => undefined)),
        notify: vi.fn(),
      },
    });

    await harness.emit("session_start", {}, ctx);
    const result = await harness.emit(
      "tool_call",
      { toolName: "bash", input: { command: "npm test" } },
      ctx,
    );

    expect(result).toEqual({
      block: true,
      reason: "Blocked by user via remote approval",
    });
    expect(channel.sendMessage).toHaveBeenCalled();
    expect(channel.poll).toHaveBeenCalledWith([42]);
  });

  it("starts the idle continue flow on agent_end when idle notifications are enabled", async () => {
    const cwd = createTempDir("pi-kit-remote-approval-repo-");
    writeGlobalRemoteConfig(cwd, {
      enabled: true,
      botToken: "123:abc",
      chatId: "1001",
      idleEnabled: true,
    });

    const runIdleContinueFlow = vi.fn(async () => undefined);
    const channel = {
      sendMessage: vi.fn(async () => 42),
      editMessage: vi.fn(async () => undefined),
      sendReplyPrompt: vi.fn(async () => 99),
      poll: vi.fn(async () => null),
    };

    vi.doMock("./flows/idle.ts", () => ({
      runIdleContinueFlow,
    }));
    vi.doMock("./channel/index.ts", () => ({
      createRemoteChannel: () => ({ channel, error: null }),
    }));

    const remoteApprovalExtension = await loadExtension();
    const harness = buildPiHarness();
    remoteApprovalExtension(harness.api as unknown as ExtensionAPI);
    const ctx = createContext(cwd, {
      entries: [
        {
          type: "message",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "Finished the work." }],
          },
        },
      ],
    });

    await harness.emit("session_start", {}, ctx);
    await harness.emit("agent_end", { messages: [] }, ctx);
    await Promise.resolve();

    expect(runIdleContinueFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        channel,
        pi: expect.objectContaining({
          sendUserMessage: harness.sendUserMessage,
        }),
        executionContext: expect.objectContaining({
          isIdle: ctx.isIdle,
        }),
        request: expect.objectContaining({
          requestId: expect.stringMatching(/^idle_abc123_/),
          sessionId: "abc123",
          sessionLabel: `${path.basename(cwd)} · abc123`,
          assistantSummary: "Finished the work.",
          contextPreview: ["assistant: Finished the work."],
          fullContextLines: ["assistant: Finished the work."],
          continueEnabled: true,
          fullContextAvailable: true,
        }),
      }),
    );
  });
});
