import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakePi,
  createTestContext,
  flushMicrotasks,
} from "./test-helpers.js";

async function importPlannotatorAuto() {
  return (await import("./index.js")).default;
}

function mockCodeReviewApi(
  options: {
    formatCodeReviewMessage?: ReturnType<typeof vi.fn>;
    requestCodeReview?: ReturnType<typeof vi.fn>;
    requestReviewStatus?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const reviewResultListeners: Array<(result: unknown) => void> = [];
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
  const formatCodeReviewMessage =
    options.formatCodeReviewMessage ??
    vi.fn((result: { approved?: boolean; feedback?: string }) => {
      if (result.approved) {
        return "# Code Review\n\nCode review completed — no changes requested.";
      }

      if (!result.feedback?.trim()) {
        return null;
      }

      return "Please add tests.\n\nPlease address this feedback.";
    });

  vi.doMock("../shared/settings.ts", () => ({
    loadGlobalSettings: vi.fn(() => ({
      globalPath: "/home/test/.pi/agent/third_extension_settings.json",
      global: {},
    })),
    loadSettings: vi.fn(() => ({
      merged: {
        plannotatorAuto: {
          codeReviewAutoTrigger: true,
        },
      },
    })),
  }));

  vi.doMock("../shared/git.ts", () => ({
    DEFAULT_GIT_TIMEOUT_MS: 1_000,
    getRepoRoot: vi.fn(() => "/repo"),
    getGitCommonDir: vi.fn(() => "/repo/.git"),
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
    formatAnnotationMessage: vi.fn(() => ""),
    formatCodeReviewMessage,
    formatPlanReviewMessage: vi.fn(() => ""),
    requestAnnotation: vi.fn(),
    requestCodeReview,
    requestReviewStatus,
    startCodeReview: vi.fn(),
    startPlanReview: vi.fn(),
  }));

  return {
    formatCodeReviewMessage,
    requestCodeReview,
    requestReviewStatus,
    reviewResultListeners,
  };
}

async function triggerCodeReview(
  emit: (name: string, event: unknown, ctx: unknown) => Promise<unknown>,
  ctx: unknown,
): Promise<void> {
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
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("code review trigger timing", () => {
  it("probes plannotator before waiting for a synchronous code review result", async () => {
    vi.resetModules();
    let resolveCodeReview:
      | ((value: {
          status: "handled";
          result: {
            approved: boolean;
            feedback?: string;
          };
        }) => void)
      | null = null;

    const { requestCodeReview, requestReviewStatus } = mockCodeReviewApi({
      requestCodeReview: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveCodeReview = resolve;
          }),
      ),
    });

    const plannotatorAuto = await importPlannotatorAuto();
    const { api, emit } = createFakePi();
    plannotatorAuto(api as never);
    const ctx = createTestContext("/repo");

    try {
      await emit("session_start", {}, ctx);
      await triggerCodeReview(emit, ctx);

      const agentEndPromise = emit("agent_end", {}, ctx);
      await flushMicrotasks();
      await flushMicrotasks();
      await flushMicrotasks();

      expect(requestReviewStatus).toHaveBeenCalledTimes(1);
      expect(requestCodeReview).toHaveBeenCalledTimes(1);
      expect(requestReviewStatus.mock.invocationCallOrder[0]).toBeLessThan(
        requestCodeReview.mock.invocationCallOrder[0],
      );
      expect(ctx.ui.notify).not.toHaveBeenCalledWith(
        "Plannotator request timed out.",
        "warning",
      );

      resolveCodeReview?.({
        status: "handled",
        result: {
          approved: false,
          feedback: "Please add tests.",
        },
      });
      await agentEndPromise;

      expect(api.sendUserMessage).toHaveBeenCalledWith(
        "Please add tests.\n\nPlease address this feedback.",
        { deliverAs: "followUp" },
      );
    } finally {
      await emit("session_shutdown", {}, ctx);
    }
  });

  it("delivers code review feedback from async review results", async () => {
    vi.resetModules();
    const { requestCodeReview, requestReviewStatus, reviewResultListeners } =
      mockCodeReviewApi();

    const plannotatorAuto = await importPlannotatorAuto();
    const { api, emit } = createFakePi();
    plannotatorAuto(api as never);
    const ctx = createTestContext("/repo");

    try {
      await emit("session_start", {}, ctx);
      await triggerCodeReview(emit, ctx);
      await emit("agent_end", {}, ctx);

      expect(requestReviewStatus).toHaveBeenCalledTimes(1);
      expect(requestCodeReview).toHaveBeenCalledTimes(1);
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

  it("uses the replacement session context for delayed code-review retries", async () => {
    vi.useFakeTimers();
    vi.resetModules();

    const requestReviewStatus = vi
      .fn()
      .mockResolvedValueOnce({
        status: "handled" as const,
        result: {
          status: "missing" as const,
        },
      })
      .mockResolvedValueOnce({
        status: "error" as const,
        error: "review-status failed",
      });

    mockCodeReviewApi({ requestReviewStatus });

    const plannotatorAuto = await importPlannotatorAuto();
    const { api, emit } = createFakePi();
    plannotatorAuto(api as never);
    const ctx = createTestContext("/repo", {
      sessionFile: "/repo/.pi/session.json",
    });
    const replacementCtx = createTestContext("/repo", {
      sessionFile: "/repo/.pi/session.json",
    });
    let stale = false;

    ctx.ui.notify.mockImplementation(() => {
      if (stale) {
        throw new Error(
          "This extension instance is stale after session replacement or reload. Use the provided replacement-session context instead.",
        );
      }
    });

    try {
      await emit("session_start", {}, ctx);
      await triggerCodeReview(emit, ctx);
      await emit("agent_end", {}, ctx);

      expect(requestReviewStatus).toHaveBeenCalledTimes(1);

      await emit("session_start", {}, replacementCtx);
      stale = true;

      await vi.advanceTimersByTimeAsync(1_200);
      await flushMicrotasks();

      expect(requestReviewStatus).toHaveBeenCalledTimes(2);
      expect(replacementCtx.ui.notify).toHaveBeenCalledWith(
        "review-status failed",
        "warning",
      );
    } finally {
      await emit("session_shutdown", {}, replacementCtx);
    }
  });

  it("delivers a follow-up when async code review returns annotations without top-level feedback", async () => {
    vi.resetModules();
    const annotations = [{ file: "src/app.ts", line: 12, text: "Add a test." }];
    const { formatCodeReviewMessage, reviewResultListeners } =
      mockCodeReviewApi({
        formatCodeReviewMessage: vi.fn(
          (result: {
            approved?: boolean;
            feedback?: string;
            annotations?: unknown[];
          }) => {
            if (result.feedback?.trim()) {
              return `${result.feedback}\n\nPlease address this feedback.`;
            }

            if ((result.annotations?.length ?? 0) > 0) {
              return "# Code Review\n\nCode review completed with inline annotations. Please address the review comments.";
            }

            return null;
          },
        ),
      });

    const plannotatorAuto = await importPlannotatorAuto();
    const { api, emit } = createFakePi();
    plannotatorAuto(api as never);
    const ctx = createTestContext("/repo");

    try {
      await emit("session_start", {}, ctx);
      await triggerCodeReview(emit, ctx);
      await emit("agent_end", {}, ctx);

      for (const listener of reviewResultListeners) {
        listener({
          reviewId: "code-review-1",
          approved: false,
          annotations,
        });
      }

      expect(formatCodeReviewMessage).toHaveBeenCalledWith({
        approved: false,
        feedback: undefined,
        annotations,
      });
      expect(api.sendUserMessage).toHaveBeenCalledWith(
        "# Code Review\n\nCode review completed with inline annotations. Please address the review comments.",
        { deliverAs: "followUp" },
      );
      expect(ctx.ui.notify).not.toHaveBeenCalledWith(
        "Code review closed (no feedback).",
        "info",
      );
    } finally {
      await emit("session_shutdown", {}, ctx);
    }
  });
});
