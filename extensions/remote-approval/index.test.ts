import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AGENT_END_CODE_SIMPLIFIER_APPROVAL_CHANNEL,
  createHandledState,
  NOTIFY_IDLE_CHANNEL,
  type PiKitAgentEndCodeSimplifierApprovalEvent,
  type PiKitNotifyIdleEvent,
  type PiKitPlannotatorPendingReviewEvent,
  type PiKitSafeDeleteApprovalEvent,
  PLANNOTATOR_PENDING_REVIEW_CHANNEL,
  SAFE_DELETE_APPROVAL_CHANNEL,
} from "../shared/internal-events.ts";
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
  clearSettingsCache();
};

const buildPiHarness = () => {
  const handlers = new Map<string, Handler[]>();
  const eventHandlers = new Map<string, Array<(payload: unknown) => void>>();
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
      events: {
        on(channel: string, handler: (payload: unknown) => void) {
          const list = eventHandlers.get(channel) ?? [];
          list.push(handler);
          eventHandlers.set(channel, list);
          return () => {
            const current = eventHandlers.get(channel) ?? [];
            eventHandlers.set(
              channel,
              current.filter((candidate) => candidate !== handler),
            );
          };
        },
        emit(channel: string, payload: unknown) {
          for (const handler of eventHandlers.get(channel) ?? []) {
            handler(payload);
          }
        },
      },
    },
    appendEntry,
    sendUserMessage,
    handlers,
    eventHandlers,
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
      "session_shutdown",
      "session_start",
    ]);
    expect(harness.eventHandlers.has(NOTIFY_IDLE_CHANNEL)).toBe(true);
    expect(harness.eventHandlers.has(SAFE_DELETE_APPROVAL_CHANNEL)).toBe(true);
    expect(
      harness.eventHandlers.has(AGENT_END_CODE_SIMPLIFIER_APPROVAL_CHANNEL),
    ).toBe(true);
    expect(harness.eventHandlers.has(PLANNOTATOR_PENDING_REVIEW_CHANNEL)).toBe(
      true,
    );
  });

  it("sends Telegram idle messages from notify idle events after the timeout", async () => {
    vi.useFakeTimers();
    const cwd = createTempDir("pi-kit-remote-approval-repo-");
    writeGlobalRemoteConfig(cwd, {
      enabled: true,
      botToken: "123:abc",
      chatId: "1001",
      approvalTimeoutMs: 50,
    });

    const channel = {
      sendMessage: vi.fn(async () => 42),
      editMessage: vi.fn(async () => undefined),
      sendReplyPrompt: vi.fn(async () => 99),
      poll: vi.fn(async () => null),
    };

    vi.doMock("./channel/index.ts", () => ({
      createRemoteChannel: () => ({ channel, error: null }),
    }));

    const remoteApprovalExtension = await loadExtension();
    const harness = buildPiHarness();
    remoteApprovalExtension(harness.api as unknown as ExtensionAPI);
    const ctx = createContext(cwd);

    await harness.emit("session_start", {}, ctx);
    const event: PiKitNotifyIdleEvent = {
      type: "notify.idle",
      requestId: "notify_1",
      createdAt: Date.now(),
      title: "π",
      body: "Finished the work.",
      contextPreview: ["assistant: Finished the work."],
      fullContextLines: ["assistant: Finished the work."],
      continueEnabled: true,
      handled: createHandledState(),
      ctx,
    };

    harness.api.events.emit(NOTIFY_IDLE_CHANNEL, event);
    await vi.advanceTimersByTimeAsync(49);
    expect(channel.sendMessage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();

    expect(channel.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Finished the work."),
      }),
    );
    vi.useRealTimers();
  });

  it("does not send Telegram idle messages when the notify event is handled before the timeout", async () => {
    vi.useFakeTimers();
    const cwd = createTempDir("pi-kit-remote-approval-repo-");
    writeGlobalRemoteConfig(cwd, {
      enabled: true,
      botToken: "123:abc",
      chatId: "1001",
      approvalTimeoutMs: 50,
    });

    const channel = {
      sendMessage: vi.fn(async () => 42),
      editMessage: vi.fn(async () => undefined),
      sendReplyPrompt: vi.fn(async () => 99),
      poll: vi.fn(async () => null),
    };

    vi.doMock("./channel/index.ts", () => ({
      createRemoteChannel: () => ({ channel, error: null }),
    }));

    const remoteApprovalExtension = await loadExtension();
    const harness = buildPiHarness();
    remoteApprovalExtension(harness.api as unknown as ExtensionAPI);
    const ctx = createContext(cwd);
    await harness.emit("session_start", {}, ctx);

    const handled = createHandledState();
    harness.api.events.emit(NOTIFY_IDLE_CHANNEL, {
      type: "notify.idle",
      requestId: "notify_2",
      createdAt: Date.now(),
      title: "π",
      body: "Already handled.",
      contextPreview: [],
      fullContextLines: [],
      continueEnabled: true,
      handled,
      ctx,
    } satisfies PiKitNotifyIdleEvent);
    handled.markHandled();

    await vi.advanceTimersByTimeAsync(50);
    await Promise.resolve();

    expect(channel.sendMessage).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("logs session lifecycle without handling tool_call commands", async () => {
    const cwd = createTempDir("pi-kit-remote-approval-repo-");
    writeGlobalRemoteConfig(cwd, { enabled: true });

    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    vi.doMock("../shared/logger.ts", () => ({
      createLogger: () => logger,
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
    await harness.emit("session_shutdown", {}, ctx);

    expect(result).toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith(
      "session_start",
      expect.objectContaining({
        sessionId: "abc123",
        sessionLabel: `${path.basename(cwd)} · abc123`,
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      "session_shutdown",
      expect.objectContaining({
        sessionId: "abc123",
      }),
    );
    expect(logger.info).not.toHaveBeenCalledWith(
      "approval_resolved",
      expect.anything(),
    );
  });

  it("attaches a remote decision to safe-delete events after the timeout", async () => {
    vi.useFakeTimers();
    const cwd = createTempDir("pi-kit-remote-approval-repo-");
    writeGlobalRemoteConfig(cwd, {
      enabled: true,
      botToken: "123:abc",
      chatId: "1001",
      approvalTimeoutMs: 50,
    });

    const channel = {
      sendMessage: vi.fn(async () => 42),
      sendReply: vi.fn(async () => 77),
      sendReplyPrompt: vi.fn(async () => 99),
      editMessage: vi.fn(async () => undefined),
      poll: vi.fn(async () => ({ type: "callback" as const, data: "allow" })),
    };

    vi.doMock("./channel/index.ts", () => ({
      createRemoteChannel: () => ({ channel, error: null }),
    }));

    const remoteApprovalExtension = await loadExtension();
    const harness = buildPiHarness();
    remoteApprovalExtension(harness.api as unknown as ExtensionAPI);
    const ctx = createContext(cwd);
    await harness.emit("session_start", {}, ctx);

    let attached: Promise<boolean> | null = null;
    const localDecision = new Promise<boolean>(() => undefined);
    harness.api.events.emit(SAFE_DELETE_APPROVAL_CHANNEL, {
      type: "safe-delete.approval",
      requestId: "safe_delete_1",
      createdAt: Date.now(),
      command: "rm -rf /tmp/demo",
      title: "Destructive command detected",
      body: "Allow rm -rf /tmp/demo?",
      contextPreview: [],
      fullContextLines: [],
      localDecision,
      attachRemoteDecision: (decision) => {
        attached = decision;
      },
      ctx,
    } satisfies PiKitSafeDeleteApprovalEvent);

    expect(attached).toBeInstanceOf(Promise);
    await vi.advanceTimersByTimeAsync(49);
    expect(channel.sendMessage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(attached).resolves.toBe(true);
    expect(channel.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Allow rm -rf /tmp/demo?"),
      }),
    );
    vi.useRealTimers();
  });

  it("does not attach a denying remote decision when code-simplifier remote channel is unavailable", async () => {
    const cwd = createTempDir("pi-kit-remote-approval-repo-");
    writeGlobalRemoteConfig(cwd, {
      enabled: true,
      approvalTimeoutMs: 0,
    });

    const remoteApprovalExtension = await loadExtension();
    const harness = buildPiHarness();
    remoteApprovalExtension(harness.api as unknown as ExtensionAPI);
    const ctx = createContext(cwd);
    await harness.emit("session_start", {}, ctx);

    let attached: Promise<boolean> | null = null;
    harness.api.events.emit(AGENT_END_CODE_SIMPLIFIER_APPROVAL_CHANNEL, {
      type: "agent-end-code-simplifier.approval",
      requestId: "code_simplifier_no_channel",
      createdAt: Date.now(),
      title: "Run code-simplifier?",
      body: "Run code-simplifier for src/demo.ts?",
      filePaths: ["src/demo.ts"],
      contextPreview: [],
      fullContextLines: [],
      localDecision: Promise.resolve(true),
      attachRemoteDecision: (decision) => {
        attached = decision;
      },
      ctx,
    } satisfies PiKitAgentEndCodeSimplifierApprovalEvent);

    expect(attached).toBeNull();
  });

  it("attaches a remote decision to code-simplifier approval events", async () => {
    vi.useFakeTimers();
    const cwd = createTempDir("pi-kit-remote-approval-repo-");
    writeGlobalRemoteConfig(cwd, {
      enabled: true,
      botToken: "123:abc",
      chatId: "1001",
      approvalTimeoutMs: 0,
    });

    const channel = {
      sendMessage: vi.fn(async () => 42),
      sendReply: vi.fn(async () => 77),
      sendReplyPrompt: vi.fn(async () => 99),
      editMessage: vi.fn(async () => undefined),
      poll: vi.fn(async () => ({ type: "callback" as const, data: "allow" })),
    };

    vi.doMock("./channel/index.ts", () => ({
      createRemoteChannel: () => ({ channel, error: null }),
    }));

    const remoteApprovalExtension = await loadExtension();
    const harness = buildPiHarness();
    remoteApprovalExtension(harness.api as unknown as ExtensionAPI);
    const ctx = createContext(cwd);
    await harness.emit("session_start", {}, ctx);

    let attached: Promise<boolean> | null = null;
    harness.api.events.emit(AGENT_END_CODE_SIMPLIFIER_APPROVAL_CHANNEL, {
      type: "agent-end-code-simplifier.approval",
      requestId: "code_simplifier_1",
      createdAt: Date.now(),
      title: "Run code-simplifier?",
      body: "Run code-simplifier for src/demo.ts?",
      filePaths: ["src/demo.ts"],
      contextPreview: [],
      fullContextLines: [],
      localDecision: new Promise<boolean>(() => undefined),
      attachRemoteDecision: (decision) => {
        attached = decision;
      },
      ctx,
    } satisfies PiKitAgentEndCodeSimplifierApprovalEvent);

    await vi.advanceTimersByTimeAsync(0);
    await expect(attached).resolves.toBe(true);
    expect(channel.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Code simplifier approval"),
      }),
    );
    vi.useRealTimers();
  });

  it("sends Telegram continue messages from plannotator pending review events", async () => {
    vi.useFakeTimers();
    const cwd = createTempDir("pi-kit-remote-approval-repo-");
    writeGlobalRemoteConfig(cwd, {
      enabled: true,
      botToken: "123:abc",
      chatId: "1001",
      approvalTimeoutMs: 0,
    });

    const channel = {
      sendMessage: vi.fn(async () => 42),
      editMessage: vi.fn(async () => undefined),
      sendReplyPrompt: vi.fn(async () => 99),
      poll: vi.fn(async () => null),
    };

    vi.doMock("./channel/index.ts", () => ({
      createRemoteChannel: () => ({ channel, error: null }),
    }));

    const remoteApprovalExtension = await loadExtension();
    const harness = buildPiHarness();
    remoteApprovalExtension(harness.api as unknown as ExtensionAPI);
    const ctx = createContext(cwd);
    await harness.emit("session_start", {}, ctx);

    harness.api.events.emit(PLANNOTATOR_PENDING_REVIEW_CHANNEL, {
      type: "plannotator-auto.pending-review",
      requestId: "plannotator_pending_1",
      createdAt: Date.now(),
      title: "Plannotator review pending",
      body: "Call plannotator_auto_submit_review for plan.md",
      planFiles: ["plan.md"],
      contextPreview: [],
      fullContextLines: [],
      continueEnabled: true,
      handled: createHandledState(),
      ctx,
    } satisfies PiKitPlannotatorPendingReviewEvent);

    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(channel.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("plannotator_auto_submit_review"),
      }),
    );
    vi.useRealTimers();
  });
});
