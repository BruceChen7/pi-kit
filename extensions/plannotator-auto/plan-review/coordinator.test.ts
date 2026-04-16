import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type StatusResponseCase = {
  name: string;
  statusResponse: unknown;
  expectActive: boolean;
  expectProcessed: boolean;
  expectRetryScheduled: boolean;
  expectUserMessage: boolean;
  expectNotify: boolean;
};

type SetupOptions = {
  isIdle?: boolean;
  startResponse?: unknown;
  statusResponse?: unknown;
  formatMessage?: string;
};

const createPlanReviewState = () => ({
  pendingPlanReviewByCwd: new Map(),
  activePlanReviewByCwd: new Map(),
  processedPlanReviewIds: new Set(),
  pendingPlanReviewRetry: null as ReturnType<typeof setTimeout> | null,
  planReviewRetryAttemptsByCwd: new Map<string, number>(),
  planReviewInFlight: false,
  plannotatorUnavailableNotified: false,
});

const setupCoordinator = async (options: SetupOptions = {}) => {
  vi.resetModules();

  const startPlanReview = vi.fn(
    async () =>
      options.startResponse ?? {
        status: "handled" as const,
        result: {
          status: "pending" as const,
          reviewId: "review-1",
        },
      },
  );

  const requestReviewStatus = vi.fn(
    async () =>
      options.statusResponse ?? {
        status: "handled" as const,
        result: {
          status: "pending" as const,
        },
      },
  );

  const formatPlanReviewMessage = vi.fn(
    () => options.formatMessage ?? "formatted-plan-review-message",
  );

  vi.doMock("../plannotator-api.ts", () => ({
    createRequestPlannotator: vi.fn(() => vi.fn()),
    startPlanReview,
    requestReviewStatus,
    formatPlanReviewMessage,
  }));

  const { createPlanReviewCoordinator } = await import("./coordinator.js");

  const state = createPlanReviewState();
  const sessionKey = "/repo/.pi/session.json";
  const sessionStates = new Map([[sessionKey, state]]);
  let reviewResultListener: ((result: unknown) => void) | null = null;

  const reviewResults = {
    markPending: vi.fn(),
    markCompleted: vi.fn(),
    getStatus: vi.fn(() => ({ status: "missing" as const })),
    onResult: vi.fn((listener: (result: unknown) => void) => {
      reviewResultListener = listener;
      return () => {
        reviewResultListener = null;
      };
    }),
  };

  const pi = {
    events: {
      on: vi.fn(),
      emit: vi.fn(),
    },
    sendUserMessage: vi.fn(),
  };

  const ctx = {
    cwd: "/repo",
    hasUI: true,
    isIdle: () => options.isIdle ?? true,
    abort: vi.fn(),
    ui: {
      notify: vi.fn(),
    },
    sessionManager: {
      getSessionFile: () => sessionKey,
    },
  };

  const coordinator = createPlanReviewCoordinator({
    pi: pi as never,
    reviewResults: reviewResults as never,
    getSessionState: () => state,
    getSessionStateByKey: (key) => sessionStates.get(key),
    getSessionKey: (runtimeCtx) =>
      runtimeCtx.sessionManager.getSessionFile() ??
      `${runtimeCtx.cwd}::ephemeral`,
    iterateSessionStates: () =>
      Array.from(sessionStates.entries()).map(
        ([entrySessionKey, entryState]) => ({
          sessionKey: entrySessionKey,
          state: entryState,
        }),
      ),
    log: null,
  });

  return {
    coordinator,
    state,
    ctx,
    pi,
    startPlanReview,
    requestReviewStatus,
    formatPlanReviewMessage,
    emitReviewResult: (result: unknown) => {
      reviewResultListener?.(result);
    },
  };
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PlanReviewCoordinator transition table", () => {
  it.each<StatusResponseCase>([
    {
      name: "active + pending status -> keep active and schedule retry",
      statusResponse: {
        status: "handled",
        result: {
          status: "pending",
        },
      },
      expectActive: true,
      expectProcessed: false,
      expectRetryScheduled: true,
      expectUserMessage: false,
      expectNotify: false,
    },
    {
      name: "active + completed status -> complete review and clear active",
      statusResponse: {
        status: "handled",
        result: {
          status: "completed",
          reviewId: "review-1",
          approved: false,
          feedback: "Please revise rollout section.",
        },
      },
      expectActive: false,
      expectProcessed: true,
      expectRetryScheduled: false,
      expectUserMessage: true,
      expectNotify: false,
    },
    {
      name: "active + missing status -> clear active without completion message",
      statusResponse: {
        status: "handled",
        result: {
          status: "missing",
        },
      },
      expectActive: false,
      expectProcessed: false,
      expectRetryScheduled: false,
      expectUserMessage: false,
      expectNotify: false,
    },
    {
      name: "active + unavailable status -> notify and retry",
      statusResponse: {
        status: "unavailable",
        error: "Plannotator request timed out.",
      },
      expectActive: true,
      expectProcessed: false,
      expectRetryScheduled: true,
      expectUserMessage: false,
      expectNotify: true,
    },
    {
      name: "active + error status -> warning and retry",
      statusResponse: {
        status: "error",
        error: "review-status failed",
      },
      expectActive: true,
      expectProcessed: false,
      expectRetryScheduled: true,
      expectUserMessage: false,
      expectNotify: true,
    },
  ])("$name", async (testCase) => {
    vi.useFakeTimers();

    const { coordinator, state, ctx, pi, requestReviewStatus } =
      await setupCoordinator({
        statusResponse: testCase.statusResponse,
      });

    state.activePlanReviewByCwd.set(ctx.cwd, {
      reviewId: "review-1",
      planFile: ".pi/plans/repo/plan/2026-04-16-flow.md",
      startedAt: Date.now(),
    });

    await coordinator.runPlanReview(ctx as never, "agent_end");

    expect(requestReviewStatus).toHaveBeenCalledTimes(1);
    expect(state.activePlanReviewByCwd.has(ctx.cwd)).toBe(
      testCase.expectActive,
    );
    expect(state.processedPlanReviewIds.has("review-1")).toBe(
      testCase.expectProcessed,
    );
    expect(state.pendingPlanReviewRetry !== null).toBe(
      testCase.expectRetryScheduled,
    );
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(
      testCase.expectUserMessage ? 1 : 0,
    );
    expect(ctx.ui.notify).toHaveBeenCalledTimes(testCase.expectNotify ? 1 : 0);
  });
});

describe("PlanReviewCoordinator key workflow effects", () => {
  it("starts plan review on plan-file write while busy and aborts current run", async () => {
    vi.useFakeTimers();

    const { coordinator, ctx, startPlanReview, state } = await setupCoordinator(
      {
        isIdle: false,
      },
    );

    const repoRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "plannotator-coordinator-"),
    );
    const planFileRelative = ".pi/plans/repo/plan/2026-04-16-workflow.md";
    const planFileAbsolute = path.join(repoRoot, planFileRelative);
    await fs.mkdir(path.dirname(planFileAbsolute), { recursive: true });
    await fs.writeFile(planFileAbsolute, "# Plan\n\n- [ ] verify\n", "utf8");

    const runtimeCtx = {
      ...ctx,
      cwd: repoRoot,
    };

    try {
      coordinator.queuePendingPlanReview(runtimeCtx as never, {
        planFile: planFileRelative,
        resolvedPlanPath: planFileAbsolute,
        updatedAt: Date.now(),
      });

      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();
      await Promise.resolve();

      expect(startPlanReview).toHaveBeenCalledTimes(1);
      expect(runtimeCtx.abort).toHaveBeenCalledTimes(1);
      expect(state.activePlanReviewByCwd.size).toBe(1);
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("stops retrying after retry-attempt cap is exceeded", async () => {
    vi.useFakeTimers();

    const { coordinator, state, ctx, requestReviewStatus } =
      await setupCoordinator({
        statusResponse: {
          status: "handled",
          result: {
            status: "pending",
          },
        },
      });

    state.activePlanReviewByCwd.set(ctx.cwd, {
      reviewId: "review-1",
      planFile: ".pi/plans/repo/plan/2026-04-16-flow.md",
      startedAt: Date.now(),
    });
    state.planReviewRetryAttemptsByCwd.set(ctx.cwd, 12);

    await coordinator.runPlanReview(ctx as never, "agent_end");

    expect(requestReviewStatus).toHaveBeenCalledTimes(1);
    expect(state.pendingPlanReviewRetry).toBeNull();
    expect(state.planReviewRetryAttemptsByCwd.has(ctx.cwd)).toBe(false);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Plannotator Auto stopped retrying plan review. Please run a manual review check.",
      "warning",
    );
  });
});
