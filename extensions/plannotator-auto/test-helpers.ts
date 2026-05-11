import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";

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

export type ShortcutRegistration = {
  description: string;
  handler: ShortcutHandler;
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

export function createFakePi() {
  const handlers = new Map<string, PiEventHandler[]>();
  const events = createFakeEventBus();
  const shortcuts = new Map<string, ShortcutRegistration>();
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
    runShortcut: async (shortcut: string, ctx: TestCtx): Promise<void> => {
      const registration = shortcuts.get(shortcut);
      if (!registration) {
        throw new Error(`Shortcut not registered: ${shortcut}`);
      }

      await registration.handler(ctx);
    },
    runTool: async (
      name: string,
      params: Record<string, unknown>,
      ctx: TestCtx,
    ): Promise<unknown> => {
      const tool = tools.get(name);
      if (!tool) {
        throw new Error(`Tool not registered: ${name}`);
      }

      return tool.execute(
        "tool-call-1",
        params,
        new AbortController().signal,
        async () => {},
        ctx,
      );
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
