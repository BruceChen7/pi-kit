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
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(
      testCase.expectUserMessage ? 1 : 0,
    );
    if (testCase.expectUserMessage) {
      expect(pi.sendUserMessage).toHaveBeenCalledWith(
        "formatted-plan-review-message",
        { deliverAs: "steer" },
      );
    }
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
    } = await setupCoordinator({
      statusResponse: {
        status: "handled",
        result: {
          status: "completed",
          reviewId: "review-1",
          approved: true,
          feedback: "Outdated review result.",
        },
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

      await coordinator.runPlanReview(runtimeCtx as never, "agent_end");

      expect(requestReviewStatus).toHaveBeenCalledTimes(1);
      expect(startPlanReview).toHaveBeenCalledTimes(1);
      expect(state.activePlanReviewByCwd.get(runtimeCtx.cwd)?.reviewId).toBe(
        "review-1",
      );
      expect(state.pendingPlanReviewByCwd.has(runtimeCtx.cwd)).toBe(false);
      expect(state.processedPlanReviewIds.has("review-1")).toBe(true);
      expect(state.settledPlanReviewPaths.size).toBe(0);
      expect(pi.sendUserMessage).not.toHaveBeenCalled();
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("waits for the review result on a busy plan-file write instead of aborting", async () => {
    const { coordinator, ctx, startPlanReview, state, emitReviewResult, pi } =
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
      let settled = false;
      const reviewPromise = Promise.resolve(
        coordinator.queuePendingPlanReview(runtimeCtx as never, {
          kind: "plan",
          planFile: planFileRelative,
          resolvedPlanPath: planFileAbsolute,
          updatedAt: Date.now(),
        }),
      ).then(() => {
        settled = true;
      });

      await Promise.resolve();
      await Promise.resolve();

      expect(startPlanReview).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      expect(runtimeCtx.abort).not.toHaveBeenCalled();
      expect(state.activePlanReviewByCwd.size).toBe(1);

      state.activePlanReviewByCwd.forEach((_active, activeCwd) => {
        expect(activeCwd).toBe(runtimeCtx.cwd);
      });

      const [activeReview] = state.activePlanReviewByCwd.values();
      expect(activeReview?.reviewId).toBe("review-1");

      emitReviewResult({
        reviewId: "review-1",
        approved: false,
        feedback: "Please split implementation and verification.",
      });

      await reviewPromise;
      expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
      expect(pi.sendUserMessage).toHaveBeenCalledWith(
        "formatted-plan-review-message",
        { deliverAs: "steer" },
      );
      expect(state.activePlanReviewByCwd.size).toBe(0);
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
    expect(pi.sendUserMessage).toHaveBeenCalledWith(
      "formatted-plan-review-message",
      { deliverAs: "steer" },
    );
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
      expect(pi.sendUserMessage).toHaveBeenCalledWith(
        "formatted-plan-review-message",
        { deliverAs: "steer" },
      );
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
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
