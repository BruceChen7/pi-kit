import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { vi } from "vitest";

type MockPlannotatorCliResult = {
  status: number;
  stdout?: string;
  stderr?: string;
  error?: Error;
};

type MockPlannotatorChild = EventEmitter & {
  kill: ReturnType<typeof vi.fn>;
  stderr: PassThrough;
  stdin: { end: ReturnType<typeof vi.fn> };
  stdout: PassThrough;
};

export function createMockPlannotatorChild(): MockPlannotatorChild {
  const child = new EventEmitter() as MockPlannotatorChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = { end: vi.fn() };
  child.kill = vi.fn(() => {
    queueMicrotask(() => child.emit("close", null));
    return true;
  });
  return child;
}

export function mockPlannotatorSpawn(result: MockPlannotatorCliResult) {
  const spawn = vi.fn(() => {
    const child = createMockPlannotatorChild();
    queueMicrotask(() => {
      if (result.error) {
        child.emit("error", result.error);
        return;
      }
      if (result.stdout) {
        child.stdout.emit("data", result.stdout);
      }
      if (result.stderr) {
        child.stderr.emit("data", result.stderr);
      }
      child.emit("close", result.status);
    });
    return child;
  });
  vi.doMock("node:child_process", async (importOriginal) => ({
    ...(await importOriginal<typeof import("node:child_process")>()),
    spawn,
  }));
  return spawn;
}

export function mockHangingPlannotatorSpawn() {
  let child: MockPlannotatorChild | null = null;
  const spawn = vi.fn(() => {
    child = createMockPlannotatorChild();
    return child;
  });
  vi.doMock("node:child_process", async (importOriginal) => ({
    ...(await importOriginal<typeof import("node:child_process")>()),
    spawn,
  }));
  return { spawn, getChild: () => child };
}

export type TestCtx = {
  cwd: string;
  hasUI: boolean;
  isIdle: () => boolean;
  abort: ReturnType<typeof vi.fn>;
  ui: {
    notify: ReturnType<typeof vi.fn>;
  };
  sessionManager: {
    getSessionFile: () => string;
  };
};

export type PiEventHandler = (event: unknown, ctx: TestCtx) => unknown;

export type FakeEventBus = {
  on: (channel: string, handler: (payload: unknown) => void) => void;
  emit: (channel: string, payload: unknown) => void;
};

export type ShortcutHandler = (ctx: TestCtx) => unknown;
export type CommandHandler = (args: string, ctx: TestCtx) => unknown;

export type ShortcutRegistration = {
  description: string;
  handler: ShortcutHandler;
};

export type CommandRegistration = {
  description: string;
  handler: CommandHandler;
};

export type ToolRegistration = {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: (update: unknown) => void | Promise<void>,
    ctx: TestCtx,
  ) => Promise<unknown>;
};

type CompletedReviewResult = {
  status: "completed";
  reviewId: string;
  approved: boolean;
  feedback?: string;
  annotations?: unknown[];
};

type FakeReviewResult = {
  reviewId?: string;
  approved: boolean;
  feedback?: string;
  annotations?: unknown[];
};

type FakePlannotatorApiOptions = {
  createRequestPlannotator?: ReturnType<typeof vi.fn>;
  startPlanReview?: ReturnType<typeof vi.fn>;
  requestCodeReview?: ReturnType<typeof vi.fn>;
  requestReviewStatus?: ReturnType<typeof vi.fn>;
  waitForReviewResult?: ReturnType<typeof vi.fn>;
  getStatus?: ReturnType<typeof vi.fn>;
  formatCodeReviewMessage?: ReturnType<typeof vi.fn>;
  formatPlanReviewMessage?: ReturnType<typeof vi.fn>;
  formatAnnotationMessage?: ReturnType<typeof vi.fn>;
};

export type FakePlannotatorApiMock = {
  createRequestPlannotator: ReturnType<typeof vi.fn>;
  startPlanReview: ReturnType<typeof vi.fn>;
  requestCodeReview: ReturnType<typeof vi.fn>;
  requestReviewStatus: ReturnType<typeof vi.fn>;
  waitForReviewResult: ReturnType<typeof vi.fn>;
  formatCodeReviewMessage: ReturnType<typeof vi.fn>;
  formatPlanReviewMessage: ReturnType<typeof vi.fn>;
  formatAnnotationMessage: ReturnType<typeof vi.fn>;
  emitReviewResult: (result: FakeReviewResult) => void;
};

export function createFakeEventBus(): FakeEventBus {
  const handlers = new Map<string, Array<(payload: unknown) => void>>();

  return {
    on(channel, handler) {
      const list = handlers.get(channel) ?? [];
      list.push(handler);
      handlers.set(channel, list);
    },
    emit(channel, payload) {
      for (const handler of handlers.get(channel) ?? []) {
        handler(payload);
      }
    },
  };
}

export function createDeferredReviewResult(
  result: CompletedReviewResult = {
    status: "completed",
    reviewId: "review-submit-plan",
    approved: true,
  },
): {
  waitForReviewResult: ReturnType<typeof vi.fn>;
  resolve: () => void;
} {
  let resolveReviewResult: ((value: CompletedReviewResult) => void) | undefined;

  return {
    waitForReviewResult: vi.fn(
      () =>
        new Promise<CompletedReviewResult>((resolve) => {
          resolveReviewResult = resolve;
        }),
    ),
    resolve: () => {
      resolveReviewResult?.(result);
    },
  };
}

export function mockPlannotatorApi(
  options: FakePlannotatorApiOptions = {},
): FakePlannotatorApiMock {
  const reviewResultListeners: Array<(result: unknown) => void> = [];
  const createRequestPlannotator =
    options.createRequestPlannotator ?? vi.fn(() => vi.fn());
  const startPlanReview =
    options.startPlanReview ??
    vi.fn(async () => ({
      status: "handled" as const,
      result: {
        status: "pending" as const,
        reviewId: "review-submit-plan",
      },
    }));
  const requestReviewStatus =
    options.requestReviewStatus ??
    vi.fn(async () => ({
      status: "handled" as const,
      result: {
        status: "missing" as const,
      },
    }));
  const requestCodeReview =
    options.requestCodeReview ??
    vi.fn(async () => ({
      status: "handled" as const,
      result: {
        status: "pending" as const,
        reviewId: "code-review-1",
      },
    }));
  const waitForReviewResult =
    options.waitForReviewResult ??
    vi.fn(
      (_store, reviewId: string) =>
        new Promise((resolve) => {
          reviewResultListeners.push((result) => {
            const completed = result as FakeReviewResult;
            if (completed.reviewId === reviewId) {
              resolve({ status: "completed", ...completed });
            }
          });
        }),
    );
  const formatCodeReviewMessage =
    options.formatCodeReviewMessage ??
    vi.fn((result: { approved?: boolean; feedback?: string }) => {
      if (result.approved) {
        return "# Code Review\n\nCode review completed — no changes requested.";
      }

      if (!result.feedback?.trim()) {
        return null;
      }

      return `${result.feedback}\n\nPlease address this feedback.`;
    });
  const formatPlanReviewMessage =
    options.formatPlanReviewMessage ?? vi.fn(() => "Plan review approved.");
  const formatAnnotationMessage =
    options.formatAnnotationMessage ?? vi.fn(() => "");

  vi.doMock("./plannotator-api.ts", () => ({
    createRequestPlannotator,
    createReviewResultStore: vi.fn(() => ({
      onResult: vi.fn((listener: (result: unknown) => void) => {
        reviewResultListeners.push(listener);
        return () => {
          const index = reviewResultListeners.indexOf(listener);
          if (index >= 0) {
            reviewResultListeners.splice(index, 1);
          }
        };
      }),
      getStatus:
        options.getStatus ?? vi.fn(() => ({ status: "missing" as const })),
      markPending: vi.fn(),
      markCompleted: vi.fn(),
    })),
    formatAnnotationMessage,
    formatCodeReviewMessage,
    formatPlanReviewMessage,
    requestAnnotation: vi.fn(),
    requestCodeReview,
    requestReviewStatus,
    startCodeReview: vi.fn(),
    startPlanReview,
    waitForReviewResult,
  }));

  return {
    createRequestPlannotator,
    startPlanReview,
    requestCodeReview,
    requestReviewStatus,
    waitForReviewResult,
    formatCodeReviewMessage,
    formatPlanReviewMessage,
    formatAnnotationMessage,
    emitReviewResult(result) {
      const event = { reviewId: "review-submit-plan", ...result };
      for (const listener of reviewResultListeners) {
        listener(event);
      }
    },
  };
}

const getRegistered = <T>(
  registrations: Map<string, T>,
  kind: string,
  name: string,
): T => {
  const registration = registrations.get(name);
  if (!registration) {
    throw new Error(`${kind} not registered: ${name}`);
  }
  return registration;
};

export function createFakePi() {
  const handlers = new Map<string, PiEventHandler[]>();
  const events = createFakeEventBus();
  const shortcuts = new Map<string, ShortcutRegistration>();
  const commands = new Map<string, CommandRegistration>();
  const tools = new Map<string, ToolRegistration>();

  return {
    api: {
      on(name: string, handler: PiEventHandler) {
        const list = handlers.get(name) ?? [];
        list.push(handler);
        handlers.set(name, list);
      },
      registerShortcut: vi.fn(
        (shortcut: unknown, registration: ShortcutRegistration) => {
          shortcuts.set(String(shortcut), registration);
        },
      ),
      registerCommand: vi.fn(
        (name: string, registration: CommandRegistration) => {
          commands.set(name, registration);
        },
      ),
      registerTool: vi.fn((tool: ToolRegistration) => {
        tools.set(tool.name, tool);
      }),
      events,
      sendUserMessage: vi.fn(),
      getCommands: () => [],
    },
    events,
    emit: async (
      name: string,
      event: unknown,
      ctx: TestCtx,
    ): Promise<unknown> => {
      let result: unknown;
      for (const handler of handlers.get(name) ?? []) {
        result = await handler(event, ctx);
      }
      return result;
    },
    runCommand: async (
      name: string,
      args: string,
      ctx: TestCtx,
    ): Promise<void> => {
      const registration = getRegistered(commands, "Command", name);
      await registration.handler(args, ctx);
    },
    runShortcut: async (shortcut: string, ctx: TestCtx): Promise<void> => {
      const registration = getRegistered(shortcuts, "Shortcut", shortcut);
      await registration.handler(ctx);
    },
    runTool: async (
      name: string,
      params: Record<string, unknown>,
      ctx: TestCtx,
      signal: AbortSignal = new AbortController().signal,
    ): Promise<unknown> => {
      const tool = getRegistered(tools, "Tool", name);
      return tool.execute("tool-call-1", params, signal, async () => {}, ctx);
    },
  };
}

export function createTestContext(
  cwd: string,
  options: {
    hasUI?: boolean;
    isIdle?: boolean;
    sessionFile?: string;
  } = {},
): TestCtx {
  return {
    cwd,
    hasUI: options.hasUI ?? true,
    isIdle: () => options.isIdle ?? true,
    abort: vi.fn(),
    ui: {
      notify: vi.fn(),
    },
    sessionManager: {
      getSessionFile: () =>
        options.sessionFile ?? path.join(cwd, ".pi", "session.json"),
    },
  };
}

export async function createTempRepo(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function writeTestFile(
  repoRoot: string,
  repoRelativePath: string,
  content: string,
  modifiedAt?: Date,
): Promise<string> {
  const absolutePath = path.join(repoRoot, repoRelativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, "utf8");

  if (modifiedAt) {
    await fs.utimes(absolutePath, modifiedAt, modifiedAt);
  }

  return absolutePath;
}

export async function removeTempRepo(repoRoot: string): Promise<void> {
  await fs.rm(repoRoot, { recursive: true, force: true });
}

export async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
