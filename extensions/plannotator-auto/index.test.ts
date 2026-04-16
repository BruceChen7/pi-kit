import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

type ImportedModule = {
  resolvePlanFileForReview?: (
    ctx: { cwd: string },
    planConfig: {
      planFile: string;
      resolvedPlanPath: string;
      mode: "file" | "directory";
    },
    targetPath: string,
  ) => string | null;
  shouldQueueReviewForToolPath?: (
    planConfig: {
      planFile: string;
      resolvedPlanPath: string;
      mode: "file" | "directory";
    } | null,
    targetPath: string,
  ) => boolean;
  getSessionKey?: (ctx: {
    cwd: string;
    sessionManager: { getSessionFile: () => string | null | undefined };
  }) => string;
};

const importPlannotatorAuto = async (): Promise<ImportedModule> =>
  (await import("./index.js")) as ImportedModule;

describe("resolvePlanFileForReview", () => {
  it("returns configured file path when the configured plan file was updated", async () => {
    const { resolvePlanFileForReview } = await importPlannotatorAuto();

    expect(resolvePlanFileForReview).toBeTypeOf("function");
    expect(
      resolvePlanFileForReview?.(
        { cwd: "/repo" },
        {
          planFile: ".pi/PLAN.md",
          resolvedPlanPath: "/repo/.pi/PLAN.md",
          mode: "file",
        },
        "/repo/.pi/PLAN.md",
      ),
    ).toBe(".pi/PLAN.md");
  });

  it("returns repo-relative generated path for directory mode plan files", async () => {
    const { resolvePlanFileForReview } = await importPlannotatorAuto();

    expect(
      resolvePlanFileForReview?.(
        { cwd: "/repo" },
        {
          planFile: ".pi/plans/repo/plan",
          resolvedPlanPath: "/repo/.pi/plans/repo/plan",
          mode: "directory",
        },
        "/repo/.pi/plans/repo/plan/2026-04-15-auth-flow.md",
      ),
    ).toBe(".pi/plans/repo/plan/2026-04-15-auth-flow.md");
  });
});

describe("shouldQueueReviewForToolPath", () => {
  it("skips code review when only the single configured plan file changed", async () => {
    const { shouldQueueReviewForToolPath } = await importPlannotatorAuto();

    expect(shouldQueueReviewForToolPath).toBeTypeOf("function");
    expect(
      shouldQueueReviewForToolPath?.(
        {
          planFile: ".pi/PLAN.md",
          resolvedPlanPath: "/repo/.pi/PLAN.md",
          mode: "file",
        },
        "/repo/.pi/PLAN.md",
      ),
    ).toBe(false);
  });

  it("skips code review when a generated plan file changed inside the plan directory", async () => {
    const { shouldQueueReviewForToolPath } = await importPlannotatorAuto();

    expect(
      shouldQueueReviewForToolPath?.(
        {
          planFile: ".pi/plans/repo/plan",
          resolvedPlanPath: "/repo/.pi/plans/repo/plan",
          mode: "directory",
        },
        "/repo/.pi/plans/repo/plan/2026-04-15-auth-flow.md",
      ),
    ).toBe(false);
  });

  it("still queues code review when a non-plan file changed", async () => {
    const { shouldQueueReviewForToolPath } = await importPlannotatorAuto();

    expect(
      shouldQueueReviewForToolPath?.(
        {
          planFile: ".pi/plans/repo/plan",
          resolvedPlanPath: "/repo/.pi/plans/repo/plan",
          mode: "directory",
        },
        "/repo/src/auth.ts",
      ),
    ).toBe(true);
  });
});

describe("getSessionKey", () => {
  it("falls back to a cwd-scoped ephemeral key when the session file is unavailable", async () => {
    const { getSessionKey } = await importPlannotatorAuto();

    expect(getSessionKey).toBeTypeOf("function");
    expect(
      getSessionKey?.({
        cwd: "/repo",
        sessionManager: { getSessionFile: () => null },
      }),
    ).toBe("/repo::ephemeral");
  });
});

type TestCtx = {
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

type PiEventHandler = (event: unknown, ctx: TestCtx) => unknown;

type FakeEventBus = {
  on: (channel: string, handler: (payload: unknown) => void) => void;
  emit: (channel: string, payload: unknown) => void;
};

const createFakeEventBus = (): FakeEventBus => {
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
};

const createFakePi = () => {
  const handlers = new Map<string, PiEventHandler[]>();
  const events = createFakeEventBus();

  return {
    api: {
      on(name: string, handler: PiEventHandler) {
        const list = handlers.get(name) ?? [];
        list.push(handler);
        handlers.set(name, list);
      },
      events,
      sendUserMessage: vi.fn(),
      getCommands: () => [],
    },
    emit: async (name: string, event: unknown, ctx: TestCtx): Promise<void> => {
      for (const handler of handlers.get(name) ?? []) {
        await handler(event, ctx);
      }
    },
  };
};

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("plan review trigger timing", () => {
  it("waits for the plan review result after a busy plan-file write", async () => {
    vi.resetModules();
    const reviewResultListeners: Array<(result: unknown) => void> = [];

    const startPlanReview = vi.fn(async () => ({
      status: "handled" as const,
      result: {
        status: "pending" as const,
        reviewId: "review-immediate",
      },
    }));

    vi.doMock("./plannotator-api.ts", () => ({
      createRequestPlannotator: vi.fn(() => vi.fn()),
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
        getStatus: vi.fn(() => null),
        markPending: vi.fn(),
        markCompleted: vi.fn(),
      })),
      formatCodeReviewMessage: vi.fn(() => ""),
      formatPlanReviewMessage: vi.fn(() => "Plan review rejected."),
      requestCodeReview: vi.fn(),
      requestReviewStatus: vi.fn(),
      startCodeReview: vi.fn(),
      startPlanReview,
    }));

    const { default: plannotatorAuto } = await import("./index.js");
    const { api, emit } = createFakePi();

    plannotatorAuto(api as never);

    const repoRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "plannotator-auto-"),
    );
    const repoName = path.basename(repoRoot);
    const planFileRelative = `.pi/plans/${repoName}/plan/2026-04-16-workflow.md`;
    const planFileAbsolute = path.join(repoRoot, planFileRelative);

    await fs.mkdir(path.dirname(planFileAbsolute), { recursive: true });
    await fs.writeFile(planFileAbsolute, "# Plan\n\n- [ ] test\n", "utf8");

    const abort = vi.fn();
    const ctx: TestCtx = {
      cwd: repoRoot,
      hasUI: true,
      isIdle: () => false,
      abort,
      ui: {
        notify: vi.fn(),
      },
      sessionManager: {
        getSessionFile: () => path.join(repoRoot, ".pi", "session.json"),
      },
    };

    try {
      await emit("session_start", {}, ctx);
      await emit(
        "tool_execution_start",
        {
          toolName: "write",
          toolCallId: "call-1",
          args: { path: planFileRelative },
        },
        ctx,
      );
      let settled = false;
      const reviewPromise = emit(
        "tool_execution_end",
        {
          toolName: "write",
          toolCallId: "call-1",
          isError: false,
        },
        ctx,
      ).then(() => {
        settled = true;
      });

      await flushMicrotasks();
      expect(startPlanReview).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      expect(abort).not.toHaveBeenCalled();

      for (const listener of reviewResultListeners) {
        listener({
          reviewId: "review-immediate",
          approved: false,
          feedback: "Please revise the rollout steps.",
        });
      }

      await reviewPromise;
      expect(api.sendUserMessage).toHaveBeenCalledTimes(1);
      expect(api.sendUserMessage).toHaveBeenCalledWith(
        "Plan review rejected.",
        {
          deliverAs: "followUp",
        },
      );
    } finally {
      await emit("session_shutdown", {}, ctx);
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("does not re-trigger single-file plan review after the plan was already submitted once", async () => {
    vi.resetModules();
    const reviewResultListeners: Array<(result: unknown) => void> = [];
    let reviewCounter = 0;

    const startPlanReview = vi.fn(async () => {
      reviewCounter += 1;
      return {
        status: "handled" as const,
        result: {
          status: "pending" as const,
          reviewId: `review-${reviewCounter}`,
        },
      };
    });

    vi.doMock("./plannotator-api.ts", () => ({
      createRequestPlannotator: vi.fn(() => vi.fn()),
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
        getStatus: vi.fn(() => null),
        markPending: vi.fn(),
        markCompleted: vi.fn(),
      })),
      formatCodeReviewMessage: vi.fn(() => ""),
      formatPlanReviewMessage: vi.fn(() => "Plan review approved."),
      requestCodeReview: vi.fn(),
      requestReviewStatus: vi.fn(),
      startCodeReview: vi.fn(),
      startPlanReview,
    }));

    const { default: plannotatorAuto } = await import("./index.js");
    const { api, emit } = createFakePi();

    plannotatorAuto(api as never);

    const repoRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "plannotator-auto-"),
    );
    const planFileRelative = ".pi/PLAN.md";
    const planFileAbsolute = path.join(repoRoot, planFileRelative);

    await fs.mkdir(path.dirname(planFileAbsolute), { recursive: true });
    await fs.writeFile(planFileAbsolute, "# Plan\n\n- [ ] first\n", "utf8");
    await fs.writeFile(
      path.join(repoRoot, ".pi", "third_extension_settings.json"),
      `${JSON.stringify(
        {
          plannotatorAuto: {
            planFile: planFileRelative,
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const ctx: TestCtx = {
      cwd: repoRoot,
      hasUI: true,
      isIdle: () => false,
      abort: vi.fn(),
      ui: {
        notify: vi.fn(),
      },
      sessionManager: {
        getSessionFile: () => path.join(repoRoot, ".pi", "session.json"),
      },
    };

    try {
      await emit("session_start", {}, ctx);

      await emit(
        "tool_execution_start",
        {
          toolName: "write",
          toolCallId: "call-1",
          args: { path: planFileRelative },
        },
        ctx,
      );

      const firstReviewPromise = emit(
        "tool_execution_end",
        {
          toolName: "write",
          toolCallId: "call-1",
          isError: false,
        },
        ctx,
      );

      await flushMicrotasks();
      expect(startPlanReview).toHaveBeenCalledTimes(1);

      for (const listener of reviewResultListeners) {
        listener({
          reviewId: "review-1",
          approved: true,
        });
      }
      await firstReviewPromise;

      await fs.writeFile(planFileAbsolute, "# Plan\n\n- [x] revised\n", "utf8");
      await emit(
        "tool_execution_start",
        {
          toolName: "write",
          toolCallId: "call-2",
          args: { path: planFileRelative },
        },
        ctx,
      );
      await emit(
        "tool_execution_end",
        {
          toolName: "write",
          toolCallId: "call-2",
          isError: false,
        },
        ctx,
      );

      expect(startPlanReview).toHaveBeenCalledTimes(1);
      expect(api.sendUserMessage).toHaveBeenCalledTimes(1);
      expect(api.sendUserMessage).toHaveBeenCalledWith(
        "Plan review approved.",
        {
          deliverAs: "followUp",
        },
      );
    } finally {
      await emit("session_shutdown", {}, ctx);
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("code review trigger timing", () => {
  it("delivers code review feedback from async review results", async () => {
    vi.resetModules();
    const reviewResultListeners: Array<(result: unknown) => void> = [];
    const startCodeReview = vi.fn(async () => ({
      status: "handled" as const,
      result: {
        status: "pending" as const,
        reviewId: "code-review-1",
      },
    }));

    vi.doMock("../shared/git.ts", () => ({
      DEFAULT_GIT_TIMEOUT_MS: 1_000,
      getRepoRoot: vi.fn(() => "/repo"),
      checkRepoDirty: vi.fn(() => ({
        summary: {
          dirty: true,
        },
      })),
    }));

    vi.doMock("./plannotator-api.ts", () => ({
      createRequestPlannotator: vi.fn(() => vi.fn()),
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
        getStatus: vi.fn(() => ({ status: "missing" as const })),
        markPending: vi.fn(),
        markCompleted: vi.fn(),
      })),
      formatCodeReviewMessage: vi.fn(
        (result: { approved?: boolean; feedback?: string }) => {
          if (result.approved) {
            return "# Code Review\n\nCode review completed — no changes requested.";
          }

          if (!result.feedback?.trim()) {
            return null;
          }

          return "Please add tests.\n\nPlease address this feedback.";
        },
      ),
      formatPlanReviewMessage: vi.fn(() => ""),
      requestCodeReview: vi.fn(),
      requestReviewStatus: vi.fn(),
      startCodeReview,
      startPlanReview: vi.fn(),
    }));

    const { default: plannotatorAuto } = await import("./index.js");
    const { api, emit } = createFakePi();

    plannotatorAuto(api as never);

    const ctx: TestCtx = {
      cwd: "/repo",
      hasUI: true,
      isIdle: () => true,
      abort: vi.fn(),
      ui: {
        notify: vi.fn(),
      },
      sessionManager: {
        getSessionFile: () => "/repo/.pi/session.json",
      },
    };

    try {
      await emit("session_start", {}, ctx);
      await emit(
        "tool_execution_start",
        {
          toolName: "write",
          toolCallId: "call-1",
          args: { path: "src/app.ts" },
        },
        ctx,
      );
      await emit(
        "tool_execution_end",
        {
          toolName: "write",
          toolCallId: "call-1",
          isError: false,
        },
        ctx,
      );

      await emit("agent_end", {}, ctx);

      expect(startCodeReview).toHaveBeenCalledTimes(1);
      expect(api.sendUserMessage).not.toHaveBeenCalled();

      for (const listener of reviewResultListeners) {
        listener({
          reviewId: "code-review-1",
          approved: false,
          feedback: "Please add tests.",
        });
      }

      expect(api.sendUserMessage).toHaveBeenCalledWith(
        "Please add tests.\n\nPlease address this feedback.",
        { deliverAs: "followUp" },
      );
      expect(ctx.ui.notify).not.toHaveBeenCalledWith(
        "Plannotator request timed out.",
        "warning",
      );
    } finally {
      await emit("session_shutdown", {}, ctx);
    }
  });
});
