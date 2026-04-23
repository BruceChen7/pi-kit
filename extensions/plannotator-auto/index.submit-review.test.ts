import { afterEach, describe, expect, it, vi } from "vitest";
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
      reviewId: options.requestReviewStatus
        ? "review-submit-fallback"
        : "review-submit-plan",
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
    const repoName = repoRoot.split("/").pop() ?? "repo";
    const planFileRelative = `.pi/plans/${repoName}/plan/2026-04-16-workflow.md`;
    await writeTestFile(repoRoot, planFileRelative, "# Plan\n\n- [ ] test\n");
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
      ).then((result) => {
        settled = true;
        return result;
      });

      await flushMicrotasks();
      expect(startPlanReview).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);

      for (const listener of reviewResultListeners) {
        listener({
          reviewId: "review-submit-plan",
          approved: true,
        });
      }

      const result = (await submitPromise) as {
        content?: Array<{ type?: string; text?: string }>;
        details?: { status?: string };
      };
      expect(result.details?.status).toBe("approved");
      expect(result.content?.[0]?.text ?? "").toContain("approved");
      expect(ctx.abort).not.toHaveBeenCalled();
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
    const repoName = repoRoot.split("/").pop() ?? "repo";
    const planFileRelative = `.pi/plans/${repoName}/plan/2026-04-16-workflow.md`;
    await writeTestFile(repoRoot, planFileRelative, "# Plan\n\n- [ ] test\n");
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
      for (const listener of reviewResultListeners) {
        listener({
          reviewId: "review-submit-plan",
          approved: true,
        });
      }
      await submitPromise;

      expect(ctx.abort).not.toHaveBeenCalled();
    } finally {
      await emit("session_shutdown", {}, ctx);
      await removeTempRepo(repoRoot);
    }
  });

  it("shows the review widget once manual review submission creates an active review", async () => {
    vi.resetModules();

    let resolveReviewResult:
      | ((value: {
          status: "completed";
          reviewId: string;
          approved: true;
        }) => void)
      | undefined;
    mockSubmitReviewApi({
      waitForReviewResult: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveReviewResult = resolve as typeof resolveReviewResult;
          }),
      ),
    });

    const plannotatorAuto = await importPlannotatorAuto();
    const { emit, runTool, api } = createFakePi();
    plannotatorAuto(api as never);

    const repoRoot = await createTempRepo("plannotator-auto-widget-active-");
    const repoName = repoRoot.split("/").pop() ?? "repo";
    const planFileRelative = `.pi/plans/${repoName}/plan/2026-04-16-workflow.md`;
    await writeTestFile(repoRoot, planFileRelative, "# Plan\n\n- [ ] test\n");
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

      resolveReviewResult?.({
        status: "completed",
        reviewId: "review-submit-plan",
        approved: true,
      });
      await submitPromise;
    } finally {
      await emit("session_shutdown", {}, ctx);
      await removeTempRepo(repoRoot);
    }
  });

  it("falls back to review-status when the async review result event is missed", async () => {
    vi.useFakeTimers();
    vi.resetModules();

    const requestReviewStatus = vi.fn(async () => ({
      status: "handled" as const,
      result: {
        status: "completed" as const,
        reviewId: "review-submit-fallback",
        approved: true,
      },
    }));
    const { startPlanReview } = mockSubmitReviewApi({
      requestReviewStatus,
      waitForReviewResult: vi.fn(() => new Promise(() => {})),
    });

    const plannotatorAuto = await importPlannotatorAuto();
    const { emit, runTool, api } = createFakePi();
    plannotatorAuto(api as never);

    const repoRoot = await createTempRepo("plannotator-auto-submit-fallback-");
    const repoName = repoRoot.split("/").pop() ?? "repo";
    const planFileRelative = `.pi/plans/${repoName}/plan/2026-04-16-workflow.md`;
    await writeTestFile(repoRoot, planFileRelative, "# Plan\n\n- [ ] test\n");
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
      expect(requestReviewStatus).toHaveBeenCalled();
      expect(settled).toBe(true);
      await submitPromise;
    } finally {
      await emit("session_shutdown", {}, ctx);
      await removeTempRepo(repoRoot);
    }
  });
});
