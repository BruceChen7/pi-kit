import { afterEach, describe, expect, it, vi } from "vitest";
import { PLANNOTATOR_PENDING_REVIEW_CHANNEL } from "../shared/internal-events.ts";
import {
  createFakePi,
  createTempRepo,
  createTestContext,
  flushMicrotasks,
  removeTempRepo,
  writeTestFile,
} from "./test-helpers.js";

async function importPlannotatorAuto() {
  return (await import("./index.js")).default;
}

const SUBMITTED_REVIEW_ID = "review-submit-plan";
const PLAN_DRAFT_CONTENT = `# Plan

## Context

这是一个用于测试的计划草稿，描述提交 Plannotator 审核前的上下文。

## Steps

- [ ] 中文检查：执行一个测试步骤。

## Verification

- [ ] 中文验证：确认测试审核流程按预期完成。

## Review

- [ ] 中文复核：后续结果记录包含改动点、验证结果、剩余风险和 bug 修复原因。
`;

const INVALID_STANDARD_PLAN_CONTENT = "# Plan\n\n- [ ] test\n";

const getPlanFileRelative = (repoRoot: string): string => {
  const repoName = repoRoot.split("/").pop() ?? "repo";
  return `.pi/plans/${repoName}/plan/2026-04-16-workflow.md`;
};

type PendingReviewEvent = {
  handled?: {
    isHandled: () => boolean;
  };
};

type ReviewResult = {
  reviewId?: string;
  approved: boolean;
  feedback?: string;
};

type CompletedReviewResult = {
  status: "completed";
  reviewId: string;
  approved: true;
};

function createReviewStoreMock(
  reviewResultListeners: Array<(result: unknown) => void>,
) {
  return {
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
  };
}

function mockSubmitReviewApi(
  options: {
    waitForReviewResult?: ReturnType<typeof vi.fn>;
    requestReviewStatus?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const reviewResultListeners: Array<(result: unknown) => void> = [];
  const startPlanReview = vi.fn(async () => ({
    status: "handled" as const,
    result: {
      status: "pending" as const,
      reviewId: SUBMITTED_REVIEW_ID,
    },
  }));

  vi.doMock("./plannotator-api.ts", () => ({
    createRequestPlannotator: vi.fn(() => vi.fn()),
    createReviewResultStore: vi.fn(() =>
      createReviewStoreMock(reviewResultListeners),
    ),
    formatAnnotationMessage: vi.fn(() => ""),
    formatCodeReviewMessage: vi.fn(() => ""),
    formatPlanReviewMessage: vi.fn(() => "Plan review approved."),
    requestAnnotation: vi.fn(),
    requestCodeReview: vi.fn(),
    requestReviewStatus:
      options.requestReviewStatus ??
      vi.fn(() => ({ status: "missing" as const })),
    startCodeReview: vi.fn(),
    startPlanReview,
    waitForReviewResult:
      options.waitForReviewResult ??
      vi.fn(
        (_store, reviewId: string) =>
          new Promise((resolve) => {
            reviewResultListeners.push((result) => {
              const completed = result as {
                reviewId?: string;
                approved?: boolean;
                feedback?: string;
              };
              if (completed.reviewId === reviewId) {
                resolve({ status: "completed", ...completed });
              }
            });
          }),
      ),
  }));

  return { reviewResultListeners, startPlanReview };
}

async function emitToolWrite(
  emit: (name: string, event: unknown, ctx: unknown) => Promise<unknown>,
  ctx: unknown,
  relativePath: string,
): Promise<void> {
  await emit(
    "tool_execution_start",
    {
      toolName: "write",
      toolCallId: "call-1",
      args: { path: relativePath },
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
}

function attachWidgetSpy(ctx: ReturnType<typeof createTestContext>) {
  const setWidget = vi.fn();
  (
    ctx.ui as typeof ctx.ui & {
      setWidget?: ReturnType<typeof vi.fn>;
    }
  ).setWidget = setWidget;
  return setWidget;
}

function emitReviewResult(
  reviewResultListeners: Array<(result: unknown) => void>,
  result: ReviewResult,
): void {
  const event = { reviewId: SUBMITTED_REVIEW_ID, ...result };
  for (const listener of reviewResultListeners) {
    listener(event);
  }
}

function resolveApprovedReview(
  resolveReviewResult: ((value: CompletedReviewResult) => void) | undefined,
): void {
  resolveReviewResult?.({
    status: "completed",
    reviewId: SUBMITTED_REVIEW_ID,
    approved: true,
  });
}

function createDeferredApprovedReview() {
  let resolveReviewResult: ((value: CompletedReviewResult) => void) | undefined;

  return {
    waitForReviewResult: vi.fn(
      () =>
        new Promise<CompletedReviewResult>((resolve) => {
          resolveReviewResult = resolve;
        }),
    ),
    resolve: () => resolveApprovedReview(resolveReviewResult),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("submit review tool", () => {
  it("submits a pending plan draft and waits for approval", async () => {
    vi.resetModules();
    const { reviewResultListeners, startPlanReview } = mockSubmitReviewApi();

    const plannotatorAuto = await importPlannotatorAuto();
    const { emit, runTool, api } = createFakePi();
    plannotatorAuto(api as never);

    const repoRoot = await createTempRepo("plannotator-auto-submit-tool-");
    const planFileRelative = getPlanFileRelative(repoRoot);
    await writeTestFile(repoRoot, planFileRelative, PLAN_DRAFT_CONTENT);
    const ctx = createTestContext(repoRoot);

    try {
      const emitted: PendingReviewEvent[] = [];
      api.events.on(PLANNOTATOR_PENDING_REVIEW_CHANNEL, (event) => {
        emitted.push(event as PendingReviewEvent);
      });

      await emit("session_start", {}, ctx);
      await emitToolWrite(emit, ctx, planFileRelative);
      expect(emitted[0]?.handled?.isHandled()).toBe(false);

      let settled = false;
      const submitPromise = Promise.resolve(
        runTool(
          "plannotator_auto_submit_review",
          { path: planFileRelative },
          ctx,
        ),
      ).then((result) => {
        settled = true;
        return result;
      });

      await flushMicrotasks();
      expect(startPlanReview).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);

      emitReviewResult(reviewResultListeners, { approved: true });

      const result = (await submitPromise) as {
        content?: Array<{ type?: string; text?: string }>;
        details?: { status?: string };
      };
      expect(result.details?.status).toBe("approved");
      expect(result.content?.[0]?.text ?? "").toContain("approved");
      expect(emitted[0]?.handled?.isHandled()).toBe(true);
      expect(ctx.abort).not.toHaveBeenCalled();
    } finally {
      await emit("session_shutdown", {}, ctx);
      await removeTempRepo(repoRoot);
    }
  });

  it("blocks invalid standard plan artifacts before starting review", async () => {
    vi.resetModules();
    const { startPlanReview } = mockSubmitReviewApi();

    const plannotatorAuto = await importPlannotatorAuto();
    const { emit, runTool, api } = createFakePi();
    plannotatorAuto(api as never);

    const repoRoot = await createTempRepo("plannotator-auto-invalid-plan-");
    const planFileRelative = getPlanFileRelative(repoRoot);
    await writeTestFile(
      repoRoot,
      planFileRelative,
      INVALID_STANDARD_PLAN_CONTENT,
    );
    const ctx = createTestContext(repoRoot);

    try {
      const emitted: PendingReviewEvent[] = [];
      api.events.on(PLANNOTATOR_PENDING_REVIEW_CHANNEL, (event) => {
        emitted.push(event as PendingReviewEvent);
      });

      await emit("session_start", {}, ctx);
      await emitToolWrite(emit, ctx, planFileRelative);

      const result = (await runTool(
        "plannotator_auto_submit_review",
        { path: planFileRelative },
        ctx,
      )) as {
        content?: Array<{ type?: string; text?: string }>;
        details?: { status?: string };
      };
      const gateResult = (await emit("before_agent_start", {}, ctx)) as {
        message?: { content?: string };
      };

      expect(result.details?.status).toBe("error");
      expect(result.content?.[0]?.text ?? "").toContain(
        "Plan Mode artifact policy blocked review submission",
      );
      expect(startPlanReview).not.toHaveBeenCalled();
      expect(emitted[0]?.handled?.isHandled()).toBe(false);
      expect(gateResult.message?.content ?? "").toContain(planFileRelative);
    } finally {
      await emit("session_shutdown", {}, ctx);
      await removeTempRepo(repoRoot);
    }
  });

  it("does not enqueue a stale gate or request another submit while review is active", async () => {
    vi.resetModules();
    const { reviewResultListeners, startPlanReview } = mockSubmitReviewApi();

    const plannotatorAuto = await importPlannotatorAuto();
    const { emit, runTool, api } = createFakePi();
    plannotatorAuto(api as never);

    const repoRoot = await createTempRepo("plannotator-auto-submit-once-");
    const planFileRelative = getPlanFileRelative(repoRoot);
    await writeTestFile(repoRoot, planFileRelative, PLAN_DRAFT_CONTENT);
    const ctx = createTestContext(repoRoot);

    try {
      await emit("session_start", {}, ctx);
      await emitToolWrite(emit, ctx, planFileRelative);

      const submitPromise = Promise.resolve(
        runTool(
          "plannotator_auto_submit_review",
          { path: planFileRelative },
          ctx,
        ),
      );

      await flushMicrotasks();
      expect(startPlanReview).toHaveBeenCalledTimes(1);
      expect(api.sendUserMessage).not.toHaveBeenCalled();

      const activeGateResult = (await emit("before_agent_start", {}, ctx)) as {
        message?: { content?: string };
      };
      expect(activeGateResult?.message).toBeUndefined();

      emitReviewResult(reviewResultListeners, { approved: true });

      await submitPromise;
      await emit("agent_end", {}, ctx);
      const approvedGateResult = (await emit(
        "before_agent_start",
        {},
        ctx,
      )) as {
        message?: { content?: string };
      };

      expect(approvedGateResult?.message).toBeUndefined();
      expect(startPlanReview).toHaveBeenCalledTimes(1);
      expect(api.sendUserMessage).not.toHaveBeenCalled();
    } finally {
      await emit("session_shutdown", {}, ctx);
      await removeTempRepo(repoRoot);
    }
  });

  it("keeps the pending gate available after a denied review", async () => {
    vi.resetModules();
    const { reviewResultListeners, startPlanReview } = mockSubmitReviewApi();

    const plannotatorAuto = await importPlannotatorAuto();
    const { emit, runTool, api } = createFakePi();
    plannotatorAuto(api as never);

    const repoRoot = await createTempRepo("plannotator-auto-submit-denied-");
    const planFileRelative = getPlanFileRelative(repoRoot);
    await writeTestFile(repoRoot, planFileRelative, PLAN_DRAFT_CONTENT);
    const ctx = createTestContext(repoRoot);

    try {
      await emit("session_start", {}, ctx);
      await emitToolWrite(emit, ctx, planFileRelative);

      const submitPromise = Promise.resolve(
        runTool(
          "plannotator_auto_submit_review",
          { path: planFileRelative },
          ctx,
        ),
      );
      await flushMicrotasks();

      emitReviewResult(reviewResultListeners, {
        approved: false,
        feedback: "Please revise.",
      });

      const result = (await submitPromise) as {
        details?: { status?: string };
      };
      const gateResult = (await emit("before_agent_start", {}, ctx)) as {
        message?: { content?: string };
      };

      expect(result.details?.status).toBe("denied");
      expect(gateResult.message?.content ?? "").toContain(
        "plannotator_auto_submit_review",
      );
      expect(gateResult.message?.content ?? "").toContain(planFileRelative);
      expect(startPlanReview).toHaveBeenCalledTimes(1);
      expect(api.sendUserMessage).not.toHaveBeenCalled();
    } finally {
      await emit("session_shutdown", {}, ctx);
      await removeTempRepo(repoRoot);
    }
  });

  it("does not poll review-status on agent_end while a manual submit is active", async () => {
    vi.resetModules();

    const requestReviewStatus = vi.fn(async () => ({
      status: "handled" as const,
      result: {
        status: "missing" as const,
      },
    }));
    const approvedReview = createDeferredApprovedReview();
    const { startPlanReview } = mockSubmitReviewApi({
      requestReviewStatus,
      waitForReviewResult: approvedReview.waitForReviewResult,
    });

    const plannotatorAuto = await importPlannotatorAuto();
    const { emit, runTool, api } = createFakePi();
    plannotatorAuto(api as never);

    const repoRoot = await createTempRepo("plannotator-auto-submit-agent-end-");
    const planFileRelative = getPlanFileRelative(repoRoot);
    await writeTestFile(repoRoot, planFileRelative, PLAN_DRAFT_CONTENT);
    const ctx = createTestContext(repoRoot);

    try {
      await emit("session_start", {}, ctx);
      await emitToolWrite(emit, ctx, planFileRelative);

      const submitPromise = Promise.resolve(
        runTool(
          "plannotator_auto_submit_review",
          { path: planFileRelative },
          ctx,
        ),
      );
      await flushMicrotasks();

      await emit("agent_end", {}, ctx);

      expect(startPlanReview).toHaveBeenCalledTimes(1);
      expect(requestReviewStatus).not.toHaveBeenCalled();
      expect(api.sendUserMessage).not.toHaveBeenCalled();

      approvedReview.resolve();
      await submitPromise;
    } finally {
      await emit("session_shutdown", {}, ctx);
      await removeTempRepo(repoRoot);
    }
  });

  it("does not abort while waiting for a manually submitted review result", async () => {
    vi.resetModules();
    const { reviewResultListeners } = mockSubmitReviewApi();

    const plannotatorAuto = await importPlannotatorAuto();
    const { emit, runTool, api } = createFakePi();
    plannotatorAuto(api as never);

    const repoRoot = await createTempRepo("plannotator-auto-submit-busy-");
    const planFileRelative = getPlanFileRelative(repoRoot);
    await writeTestFile(repoRoot, planFileRelative, PLAN_DRAFT_CONTENT);
    const ctx = createTestContext(repoRoot, { isIdle: false });

    try {
      await emit("session_start", {}, ctx);
      await emitToolWrite(emit, ctx, planFileRelative);
      ctx.abort.mockClear();

      const submitPromise = Promise.resolve(
        runTool(
          "plannotator_auto_submit_review",
          { path: planFileRelative },
          ctx,
        ),
      );

      await flushMicrotasks();
      emitReviewResult(reviewResultListeners, { approved: true });
      await submitPromise;

      expect(ctx.abort).not.toHaveBeenCalled();
    } finally {
      await emit("session_shutdown", {}, ctx);
      await removeTempRepo(repoRoot);
    }
  });

  it("shows the review widget once manual review submission creates an active review", async () => {
    vi.resetModules();

    const approvedReview = createDeferredApprovedReview();
    mockSubmitReviewApi({
      waitForReviewResult: approvedReview.waitForReviewResult,
    });

    const plannotatorAuto = await importPlannotatorAuto();
    const { emit, runTool, api } = createFakePi();
    plannotatorAuto(api as never);

    const repoRoot = await createTempRepo("plannotator-auto-widget-active-");
    const planFileRelative = getPlanFileRelative(repoRoot);
    await writeTestFile(repoRoot, planFileRelative, PLAN_DRAFT_CONTENT);
    const ctx = createTestContext(repoRoot);
    const setWidget = attachWidgetSpy(ctx);

    try {
      await emit("session_start", {}, ctx);
      await emitToolWrite(emit, ctx, planFileRelative);
      setWidget.mockClear();

      const submitPromise = Promise.resolve(
        runTool(
          "plannotator_auto_submit_review",
          { path: planFileRelative },
          ctx,
        ),
      );
      await flushMicrotasks();

      expect(setWidget).toHaveBeenCalledWith(
        "plannotator-auto-review",
        ["Plan/Spec review is active"],
        { placement: "belowEditor" },
      );

      approvedReview.resolve();
      await submitPromise;
    } finally {
      await emit("session_shutdown", {}, ctx);
      await removeTempRepo(repoRoot);
    }
  });

  it("waits for the submitted review result event without polling review-status", async () => {
    vi.useFakeTimers();
    vi.resetModules();

    const requestReviewStatus = vi.fn(async () => ({
      status: "handled" as const,
      result: {
        status: "completed" as const,
        reviewId: SUBMITTED_REVIEW_ID,
        approved: true,
      },
    }));
    const approvedReview = createDeferredApprovedReview();
    const { startPlanReview } = mockSubmitReviewApi({
      requestReviewStatus,
      waitForReviewResult: approvedReview.waitForReviewResult,
    });

    const plannotatorAuto = await importPlannotatorAuto();
    const { emit, runTool, api } = createFakePi();
    plannotatorAuto(api as never);

    const repoRoot = await createTempRepo("plannotator-auto-submit-event-");
    const planFileRelative = getPlanFileRelative(repoRoot);
    await writeTestFile(repoRoot, planFileRelative, PLAN_DRAFT_CONTENT);
    const ctx = createTestContext(repoRoot);

    try {
      await emit("session_start", {}, ctx);
      await emitToolWrite(emit, ctx, planFileRelative);

      let settled = false;
      const submitPromise = Promise.resolve(
        runTool(
          "plannotator_auto_submit_review",
          { path: planFileRelative },
          ctx,
        ),
      ).then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(2_000);
      await flushMicrotasks();

      expect(startPlanReview).toHaveBeenCalledTimes(1);
      expect(requestReviewStatus).not.toHaveBeenCalled();
      expect(settled).toBe(false);

      approvedReview.resolve();
      await submitPromise;
      expect(settled).toBe(true);
    } finally {
      await emit("session_shutdown", {}, ctx);
      await removeTempRepo(repoRoot);
    }
  });
});
