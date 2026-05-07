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
  expectAbort: boolean;
  expectNotify: boolean;
};

type SetupOptions = {
  isIdle?: boolean;
  startResponse?: unknown;
  statusResponse?: unknown;
  getSessionContextByKey?: (key: string) => unknown;
};

const createPlanReviewState = () => ({
  pendingPlanReviewByCwd: new Map(),
  activePlanReviewByCwd: new Map(),
  processedPlanReviewIds: new Set(),
  settledPlanReviewPaths: new Set(),
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

  vi.doMock("../plannotator-api.ts", () => ({
    createRequestPlannotator: vi.fn(() => vi.fn()),
    startPlanReview,
    requestReviewStatus,
    waitForReviewResult: vi.fn(
      (
        _reviewResults: {
          onResult: (listener: (result: unknown) => void) => () => void;
        },
        reviewId: string,
      ) =>
        new Promise<{ approved: boolean; feedback?: string }>((resolve) => {
          const unsubscribe = reviewResults.onResult((result: unknown) => {
            if (
              typeof result === "object" &&
              result !== null &&
              "reviewId" in result &&
              result.reviewId === reviewId
            ) {
              unsubscribe();
              resolve(result as { approved: boolean; feedback?: string });
            }
          });
        }),
    ),
  }));

  const { createPlanReviewCoordinator } = await import("./coordinator.js");

  const state = createPlanReviewState();
  const sessionKey = "/repo/.pi/session.json";
  const sessionStates = new Map([[sessionKey, state]]);
  const reviewResultListeners: Array<(result: unknown) => void> = [];

  const reviewResults = {
    markPending: vi.fn(),
    markCompleted: vi.fn(),
    getStatus: vi.fn(() => ({ status: "missing" as const })),
    onResult: vi.fn((listener: (result: unknown) => void) => {
      reviewResultListeners.push(listener);
      return () => {
        const index = reviewResultListeners.indexOf(listener);
        if (index >= 0) {
          reviewResultListeners.splice(index, 1);
        }
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
    getSessionContextByKey: (key) =>
      options.getSessionContextByKey?.(key) ??
      (key === sessionKey ? (ctx as never) : undefined),
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
    emitReviewResult: (result: unknown) => {
      for (const listener of [...reviewResultListeners]) {
        listener(result);
      }
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
      expectAbort: false,
      expectNotify: true,
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
      expectAbort: false,
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
      expectAbort: false,
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
      expectAbort: false,
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
      kind: "plan",
      planFile: ".pi/plans/repo/plan/2026-04-16-flow.md",
      resolvedPlanPath: "/repo/.pi/plans/repo/plan/2026-04-16-flow.md",
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
    expect(ctx.abort).toHaveBeenCalledTimes(testCase.expectAbort ? 1 : 0);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledTimes(testCase.expectNotify ? 1 : 0);
  });
});

describe("PlanReviewCoordinator key workflow effects", () => {
  it("suppresses completion messages for superseded active reviews", async () => {
    const {
      coordinator,
      state,
      ctx,
      pi,
      requestReviewStatus,
      startPlanReview,
      emitReviewResult,
    } = await setupCoordinator();

    requestReviewStatus.mockResolvedValueOnce({
      status: "handled",
      result: {
        status: "completed",
        reviewId: "review-1",
        approved: true,
        feedback: "Outdated review result.",
      },
    });
    startPlanReview.mockResolvedValueOnce({
      status: "handled",
      result: {
        status: "pending",
        reviewId: "review-2",
      },
    });

    const repoRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "plannotator-stale-review-"),
    );
    const planFileRelative = ".pi/plans/repo/plan/2026-04-16-flow.md";
    const planFileAbsolute = path.join(repoRoot, planFileRelative);
    await fs.mkdir(path.dirname(planFileAbsolute), { recursive: true });
    await fs.writeFile(planFileAbsolute, "# Plan\n\n- [ ] latest\n", "utf8");

    const runtimeCtx = {
      ...ctx,
      cwd: repoRoot,
    };

    try {
      state.activePlanReviewByCwd.set(runtimeCtx.cwd, {
        reviewId: "review-1",
        kind: "plan",
        planFile: planFileRelative,
        resolvedPlanPath: planFileAbsolute,
        startedAt: 100,
      });
      state.pendingPlanReviewByCwd.set(runtimeCtx.cwd, {
        kind: "plan",
        planFile: planFileRelative,
        resolvedPlanPath: planFileAbsolute,
        updatedAt: 101,
      });

      const runPromise = Promise.resolve(
        coordinator.runPlanReview(runtimeCtx as never, "agent_end"),
      );
      await vi.waitFor(() => {
        expect(state.activePlanReviewByCwd.get(runtimeCtx.cwd)?.reviewId).toBe(
          "review-2",
        );
      });

      emitReviewResult({
        reviewId: "review-2",
        approved: true,
        feedback: "Latest review result.",
      });
      await runPromise;

      expect(requestReviewStatus).toHaveBeenCalledTimes(1);
      expect(startPlanReview).toHaveBeenCalledTimes(1);
      expect(state.activePlanReviewByCwd.has(runtimeCtx.cwd)).toBe(false);
      expect(state.pendingPlanReviewByCwd.has(runtimeCtx.cwd)).toBe(false);
      expect(state.processedPlanReviewIds.has("review-1")).toBe(true);
      expect(state.processedPlanReviewIds.has("review-2")).toBe(true);
      expect(state.settledPlanReviewPaths.has(planFileAbsolute)).toBe(true);
      expect(pi.sendUserMessage).not.toHaveBeenCalled();
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("queues a busy plan-file write without auto-starting review", async () => {
    const { coordinator, ctx, startPlanReview, state, pi } =
      await setupCoordinator({
        isIdle: false,
      });

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
      await coordinator.queuePendingPlanReview(runtimeCtx as never, {
        kind: "plan",
        planFile: planFileRelative,
        resolvedPlanPath: planFileAbsolute,
        updatedAt: Date.now(),
      });

      expect(startPlanReview).not.toHaveBeenCalled();
      expect(runtimeCtx.abort).not.toHaveBeenCalled();
      expect(runtimeCtx.ui.notify).not.toHaveBeenCalled();
      expect(pi.sendUserMessage).not.toHaveBeenCalled();
      expect(state.activePlanReviewByCwd.size).toBe(0);
      expect(state.pendingPlanReviewByCwd.get(runtimeCtx.cwd)?.planFile).toBe(
        planFileRelative,
      );
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("waits synchronously when active review status is pending", async () => {
    const {
      coordinator,
      state,
      ctx,
      emitReviewResult,
      pi,
      requestReviewStatus,
    } = await setupCoordinator({
      statusResponse: {
        status: "handled",
        result: {
          status: "pending",
        },
      },
    });

    state.activePlanReviewByCwd.set(ctx.cwd, {
      reviewId: "review-1",
      kind: "plan",
      planFile: ".pi/plans/repo/plan/2026-04-16-flow.md",
      resolvedPlanPath: "/repo/.pi/plans/repo/plan/2026-04-16-flow.md",
      startedAt: Date.now(),
    });

    let settled = false;
    const runPromise = Promise.resolve(
      coordinator.runPlanReview(ctx as never, "agent_end"),
    ).then(() => {
      settled = true;
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(requestReviewStatus).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    expect(state.pendingPlanReviewRetry).toBeNull();

    emitReviewResult({
      reviewId: "review-1",
      approved: true,
      feedback: "Looks good.",
    });

    await runPromise;

    expect(state.activePlanReviewByCwd.size).toBe(0);
    expect(ctx.abort).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Plannotator plan review draft is ready. Submit it manually in Plannotator to continue.",
      "info",
    );
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("waits synchronously after accepted start for non plan-file-write reasons", async () => {
    const { coordinator, state, ctx, emitReviewResult, pi, startPlanReview } =
      await setupCoordinator({
        statusResponse: {
          status: "handled",
          result: {
            status: "pending",
          },
        },
      });

    const repoRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "plannotator-agent-end-plan-review-"),
    );
    const planFileRelative = ".pi/plans/repo/plan/2026-04-17-agent-end.md";
    const planFileAbsolute = path.join(repoRoot, planFileRelative);
    await fs.mkdir(path.dirname(planFileAbsolute), { recursive: true });
    await fs.writeFile(planFileAbsolute, "# Plan\n\n- [ ] wait\n", "utf8");

    const runtimeCtx = {
      ...ctx,
      cwd: repoRoot,
    };

    try {
      state.pendingPlanReviewByCwd.set(runtimeCtx.cwd, {
        kind: "plan",
        planFile: planFileRelative,
        resolvedPlanPath: planFileAbsolute,
        updatedAt: Date.now(),
      });

      let settled = false;
      const runPromise = Promise.resolve(
        coordinator.runPlanReview(runtimeCtx as never, "agent_end"),
      ).then(() => {
        settled = true;
      });

      await Promise.resolve();
      await Promise.resolve();

      expect(startPlanReview).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      expect(state.pendingPlanReviewRetry).toBeNull();
      expect(state.activePlanReviewByCwd.has(runtimeCtx.cwd)).toBe(true);

      emitReviewResult({
        reviewId: "review-1",
        approved: false,
        feedback: "Please adjust acceptance criteria.",
      });

      await runPromise;

      expect(state.activePlanReviewByCwd.has(runtimeCtx.cwd)).toBe(false);
      expect(state.pendingPlanReviewByCwd.has(runtimeCtx.cwd)).toBe(false);
      expect(runtimeCtx.abort).not.toHaveBeenCalled();
      expect(runtimeCtx.ui.notify).toHaveBeenCalledWith(
        "Plannotator plan review draft is ready. Submit it manually in Plannotator to continue.",
        "info",
      );
      expect(pi.sendUserMessage).not.toHaveBeenCalled();
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("waits for review result events after accepted start without polling review-status", async () => {
    vi.useFakeTimers();

    const {
      coordinator,
      state,
      ctx,
      emitReviewResult,
      requestReviewStatus,
      startPlanReview,
    } = await setupCoordinator({
      statusResponse: {
        status: "handled",
        result: {
          status: "completed",
          reviewId: "review-1",
          approved: true,
        },
      },
    });

    const repoRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "plannotator-no-status-poll-"),
    );
    const planFileRelative = ".pi/plans/repo/plan/2026-04-17-agent-end.md";
    const planFileAbsolute = path.join(repoRoot, planFileRelative);
    await fs.mkdir(path.dirname(planFileAbsolute), { recursive: true });
    await fs.writeFile(planFileAbsolute, "# Plan\n\n- [ ] wait\n", "utf8");

    const runtimeCtx = {
      ...ctx,
      cwd: repoRoot,
    };

    try {
      state.pendingPlanReviewByCwd.set(runtimeCtx.cwd, {
        kind: "plan",
        planFile: planFileRelative,
        resolvedPlanPath: planFileAbsolute,
        updatedAt: Date.now(),
      });

      let settled = false;
      const runPromise = Promise.resolve(
        coordinator.runPlanReview(runtimeCtx as never, "agent_end"),
      ).then(() => {
        settled = true;
      });

      await Promise.resolve();
      expect(startPlanReview).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(2_000);
      await Promise.resolve();

      expect(requestReviewStatus).not.toHaveBeenCalled();
      expect(settled).toBe(false);

      emitReviewResult({
        reviewId: "review-1",
        approved: true,
        feedback: "Looks good.",
      });
      await runPromise;
      expect(settled).toBe(true);
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("uses the replacement session context for delayed plan-review retries", async () => {
    vi.useFakeTimers();

    const staleMessage =
      "This extension instance is stale after session replacement or reload. Use the provided replacement-session context instead.";
    let stale = false;
    let replacementNotify: ReturnType<typeof vi.fn> | null = null;

    const { coordinator, state, ctx, requestReviewStatus } =
      await setupCoordinator({
        statusResponse: {
          status: "unavailable",
          error: "Plannotator request timed out.",
        },
        getSessionContextByKey: (key) => {
          if (key !== "/repo/.pi/session.json") {
            return undefined;
          }

          if (!stale) {
            return ctx as never;
          }

          replacementNotify ??= vi.fn();
          return {
            ...ctx,
            ui: {
              notify: replacementNotify,
            },
          } as never;
        },
      });

    requestReviewStatus.mockResolvedValueOnce({
      status: "unavailable",
      error: "Plannotator request timed out.",
    });
    requestReviewStatus.mockResolvedValueOnce({
      status: "error",
      error: "review-status failed",
    });

    ctx.ui.notify.mockImplementation(() => {
      if (stale) {
        throw new Error(staleMessage);
      }
    });

    state.activePlanReviewByCwd.set(ctx.cwd, {
      reviewId: "review-1",
      kind: "plan",
      planFile: ".pi/plans/repo/plan/2026-04-16-flow.md",
      resolvedPlanPath: "/repo/.pi/plans/repo/plan/2026-04-16-flow.md",
      startedAt: Date.now(),
    });

    await coordinator.runPlanReview(ctx as never, "agent_end");

    expect(requestReviewStatus).toHaveBeenCalledTimes(1);
    stale = true;

    await vi.advanceTimersByTimeAsync(2_000);
    await Promise.resolve();
    await Promise.resolve();

    expect(requestReviewStatus).toHaveBeenCalledTimes(2);
    expect(replacementNotify).toHaveBeenCalledWith(
      "review-status failed",
      "warning",
    );
  });

  it("stops retrying after retry-attempt cap is exceeded", async () => {
    vi.useFakeTimers();

    const { coordinator, state, ctx, requestReviewStatus } =
      await setupCoordinator({
        statusResponse: {
          status: "unavailable",
          error: "Plannotator request timed out.",
        },
      });

    state.activePlanReviewByCwd.set(ctx.cwd, {
      reviewId: "review-1",
      kind: "plan",
      planFile: ".pi/plans/repo/plan/2026-04-16-flow.md",
      resolvedPlanPath: "/repo/.pi/plans/repo/plan/2026-04-16-flow.md",
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
