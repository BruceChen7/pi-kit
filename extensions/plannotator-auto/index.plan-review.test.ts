import { afterEach, describe, expect, it, vi } from "vitest";
import { PLANNOTATOR_PENDING_REVIEW_CHANNEL } from "../shared/internal-events.ts";
import {
  createFakePi,
  createTempRepo,
  createTestContext,
  flushMicrotasks,
  removeTempRepo,
  type TestCtx,
  writeTestFile,
} from "./test-helpers.js";

async function importPlannotatorAuto() {
  return (await import("./index.js")).default;
}

type FakePi = ReturnType<typeof createFakePi>;
type Emit = FakePi["emit"];
type TestApi = FakePi["api"];
type ReviewPromptDelivery = "steer" | "followUp";
type PlanReviewApiMockOptions = {
  createRequestPlannotator?: ReturnType<typeof vi.fn>;
  startPlanReview?: ReturnType<typeof vi.fn>;
  waitForReviewResult?: ReturnType<typeof vi.fn>;
  getStatus?: ReturnType<typeof vi.fn>;
  requestReviewStatus?: ReturnType<typeof vi.fn>;
};

function mockPlanReviewApi(options: PlanReviewApiMockOptions = {}) {
  const startPlanReview = options.startPlanReview ?? vi.fn();

  vi.doMock("./plannotator-api.ts", () => ({
    createRequestPlannotator:
      options.createRequestPlannotator ?? vi.fn(() => vi.fn()),
    createReviewResultStore: vi.fn(() => ({
      onResult: vi.fn(() => vi.fn()),
      getStatus: options.getStatus ?? vi.fn(() => null),
      markPending: vi.fn(),
      markCompleted: vi.fn(),
    })),
    formatAnnotationMessage: vi.fn(() => ""),
    formatCodeReviewMessage: vi.fn(() => ""),
    formatPlanReviewMessage: vi.fn(() => "Plan review approved."),
    requestAnnotation: vi.fn(),
    requestCodeReview: vi.fn(),
    requestReviewStatus: options.requestReviewStatus ?? vi.fn(),
    startCodeReview: vi.fn(),
    startPlanReview,
    waitForReviewResult: options.waitForReviewResult ?? vi.fn(),
  }));

  return { startPlanReview };
}

async function emitToolWrite(
  emit: Emit,
  ctx: TestCtx,
  relativePath: string,
  toolCallId = "call-1",
): Promise<void> {
  await emit(
    "tool_execution_start",
    {
      toolName: "write",
      toolCallId,
      args: { path: relativePath },
    },
    ctx,
  );
  await emit(
    "tool_execution_end",
    {
      toolName: "write",
      toolCallId,
      isError: false,
    },
    ctx,
  );
}

async function emitBashCommand(
  emit: Emit,
  ctx: TestCtx,
  command: string,
  toolCallId = "bash-call-1",
): Promise<void> {
  await emit(
    "tool_execution_start",
    {
      toolName: "bash",
      toolCallId,
      args: { command },
    },
    ctx,
  );
  await emit(
    "tool_execution_end",
    {
      toolName: "bash",
      toolCallId,
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

async function writePlanDraft(
  repoRoot: string,
  repoName: string,
): Promise<string> {
  const relativePath = `.pi/plans/${repoName}/plan/2026-04-16-workflow.md`;
  await writeTestFile(repoRoot, relativePath, "# Plan\n\n- [ ] test\n");
  return relativePath;
}

async function writeSpecDraft(
  repoRoot: string,
  repoName: string,
): Promise<string> {
  const relativePath = `.pi/plans/${repoName}/specs/2026-04-20-agent-design.md`;
  await writeTestFile(repoRoot, relativePath, "# Spec\n\n- draft\n");
  return relativePath;
}

function expectReviewPromptSent(
  sendUserMessage: TestApi["sendUserMessage"],
  options: {
    path: string;
    deliverAs: ReviewPromptDelivery;
    shouldContainToolName?: boolean;
  },
): void {
  const matchingCall = (
    sendUserMessage.mock.calls as Array<[unknown, unknown]>
  ).find(([body, delivery]) => {
    const message = String(body);
    const deliverAs = (delivery as { deliverAs?: unknown } | undefined)
      ?.deliverAs;
    const hasExpectedDelivery = deliverAs === options.deliverAs;
    const hasExpectedPath = message.includes(options.path);
    const hasExpectedToolName =
      options.shouldContainToolName === false ||
      message.includes("plannotator_auto_submit_review");

    return hasExpectedDelivery && hasExpectedPath && hasExpectedToolName;
  });

  expect(matchingCall).toBeDefined();
}

type PlannotatorAutoTestHarness = FakePi &
  ReturnType<typeof mockPlanReviewApi> & {
    repoRoot: string;
    repoName: string;
    createCtx: (options?: Parameters<typeof createTestContext>[1]) => TestCtx;
  };

async function withPlannotatorAutoTest(
  repoPrefix: string,
  runTest: (harness: PlannotatorAutoTestHarness) => Promise<void>,
  apiMockOptions?: PlanReviewApiMockOptions,
): Promise<void> {
  vi.resetModules();
  const apiMocks = mockPlanReviewApi(apiMockOptions);

  const plannotatorAuto = await importPlannotatorAuto();
  const pi = createFakePi();
  plannotatorAuto(pi.api as never);

  const repoRoot = await createTempRepo(repoPrefix);
  const repoName = repoRoot.split("/").pop() ?? "repo";
  let ctx: TestCtx | undefined;

  try {
    await runTest({
      ...pi,
      ...apiMocks,
      repoRoot,
      repoName,
      createCtx: (options) => {
        ctx = createTestContext(repoRoot, options);
        return ctx;
      },
    });
  } finally {
    if (ctx) {
      await pi.emit("session_shutdown", {}, ctx);
    }
    await removeTempRepo(repoRoot);
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("plan review trigger timing", () => {
  it("queues review submission after a bash heredoc creates a plan file", async () => {
    await withPlannotatorAutoTest(
      "plannotator-auto-bash-plan-",
      async ({ api, emit, repoRoot, repoName, startPlanReview, createCtx }) => {
        const planFileRelative = await writePlanDraft(repoRoot, repoName);
        const ctx = createCtx({ isIdle: false });

        await emit("session_start", {}, ctx);
        await emitBashCommand(
          emit,
          ctx,
          `cat > ${planFileRelative} <<'EOF'\n# Plan\n\n- [ ] test\nEOF`,
        );

        expect(startPlanReview).not.toHaveBeenCalled();
        expect(ctx.abort).toHaveBeenCalledTimes(1);
        expectReviewPromptSent(api.sendUserMessage, {
          path: planFileRelative,
          deliverAs: "steer",
        });
      },
    );
  });

  it("immediately steers manual review submission after a busy plan-file write", async () => {
    await withPlannotatorAutoTest(
      "plannotator-auto-plan-review-",
      async ({ api, emit, repoRoot, repoName, startPlanReview, createCtx }) => {
        const planFileRelative = await writePlanDraft(repoRoot, repoName);
        const ctx = createCtx({ isIdle: false });

        await emit("session_start", {}, ctx);
        const reviewPromise = emitToolWrite(emit, ctx, planFileRelative);

        await flushMicrotasks();
        await reviewPromise;

        expect(startPlanReview).not.toHaveBeenCalled();
        expect(ctx.abort).toHaveBeenCalledTimes(1);
        expect(ctx.ui.notify).not.toHaveBeenCalled();
        expectReviewPromptSent(api.sendUserMessage, {
          path: planFileRelative,
          deliverAs: "steer",
        });
      },
    );
  });

  it("does not show the review widget for pending-only plan review state", async () => {
    await withPlannotatorAutoTest(
      "plannotator-auto-pending-widget-",
      async ({ emit, repoRoot, repoName, createCtx }) => {
        const planFileRelative = await writePlanDraft(repoRoot, repoName);

        const ctx = createCtx();
        const setWidget = attachWidgetSpy(ctx);

        await emit("session_start", {}, ctx);
        setWidget.mockClear();

        await emitToolWrite(emit, ctx, planFileRelative);

        expect(setWidget).toHaveBeenCalled();
        expect(
          setWidget.mock.calls.every(
            ([key, content]) =>
              key === "plannotator-auto-review" && content === undefined,
          ),
        ).toBe(true);
      },
    );
  });

  it("sends a strict follow-up gate message at agent_end when a plan draft is still pending", async () => {
    await withPlannotatorAutoTest(
      "plannotator-auto-pending-gate-",
      async ({ api, emit, repoRoot, repoName, startPlanReview, createCtx }) => {
        const planFileRelative = await writePlanDraft(repoRoot, repoName);
        const ctx = createCtx();

        await emit("session_start", {}, ctx);
        await emitToolWrite(emit, ctx, planFileRelative);
        await emit("agent_end", {}, ctx);

        expect(startPlanReview).not.toHaveBeenCalled();
        expectReviewPromptSent(api.sendUserMessage, {
          path: planFileRelative,
          deliverAs: "followUp",
        });
      },
    );
  });

  it("emits a remote pending-review event when a plan draft is gated", async () => {
    await withPlannotatorAutoTest(
      "plannotator-pending-event-",
      async ({ emit, events, repoRoot, repoName, createCtx }) => {
        const emitted: unknown[] = [];
        events.on(PLANNOTATOR_PENDING_REVIEW_CHANNEL, (event) => {
          emitted.push(event);
        });

        const planFileRelative = await writePlanDraft(repoRoot, repoName);
        const ctx = createCtx({ isIdle: false });

        await emit("session_start", {}, ctx);
        await emitToolWrite(emit, ctx, planFileRelative);

        expect(emitted).toEqual([
          expect.objectContaining({
            type: "plannotator-auto.pending-review",
            planFiles: [planFileRelative],
            body: expect.stringContaining("plannotator_auto_submit_review"),
          }),
        ]);
      },
    );
  });

  it("injects pending review guidance before the next agent turn", async () => {
    await withPlannotatorAutoTest(
      "plannotator-before-agent-start-",
      async ({ emit, repoRoot, repoName, createCtx }) => {
        const planFileRelative = await writePlanDraft(repoRoot, repoName);
        const ctx = createCtx();

        await emit("session_start", {}, ctx);
        await emitToolWrite(emit, ctx, planFileRelative);

        const result = (await emit("before_agent_start", {}, ctx)) as {
          message?: { content?: string };
        };

        expect(result.message?.content ?? "").toContain(
          "plannotator_auto_submit_review",
        );
        expect(result.message?.content ?? "").toContain(planFileRelative);
      },
    );
  });

  it("gates generated plans from any worktree slug until explicit submission", async () => {
    await withPlannotatorAutoTest(
      "plannotator-wildcard-plan-",
      async ({ api, emit, repoRoot, startPlanReview, createCtx }) => {
        const planFileRelative =
          ".pi/plans/other-worktree/plan/2026-04-16-wildcard.md";
        await writeTestFile(
          repoRoot,
          planFileRelative,
          "# Plan\n\n- [ ] test\n",
        );
        const ctx = createCtx({ isIdle: false });

        await emit("session_start", {}, ctx);
        await emitToolWrite(emit, ctx, planFileRelative);
        await emit("agent_end", {}, ctx);

        expect(startPlanReview).not.toHaveBeenCalled();
        expectReviewPromptSent(api.sendUserMessage, {
          path: planFileRelative,
          deliverAs: "followUp",
          shouldContainToolName: false,
        });
      },
    );
  });

  it("gates generated specs from any worktree slug until explicit submission", async () => {
    await withPlannotatorAutoTest(
      "plannotator-wildcard-spec-",
      async ({ api, emit, repoRoot, startPlanReview, createCtx }) => {
        const specFileRelative =
          ".pi/plans/other-worktree/specs/2026-04-20-agent-design.md";
        await writeTestFile(repoRoot, specFileRelative, "# Spec\n\n- draft\n");
        const ctx = createCtx({ isIdle: false });

        await emit("session_start", {}, ctx);
        await emitToolWrite(emit, ctx, specFileRelative);
        await emit("agent_end", {}, ctx);

        expect(startPlanReview).not.toHaveBeenCalled();
        expectReviewPromptSent(api.sendUserMessage, {
          path: specFileRelative,
          deliverAs: "followUp",
          shouldContainToolName: false,
        });
      },
    );
  });

  it("gates generated design specs until the agent submits the review explicitly", async () => {
    await withPlannotatorAutoTest(
      "plannotator-spec-review-",
      async ({ api, emit, repoRoot, repoName, startPlanReview, createCtx }) => {
        const specFileRelative = await writeSpecDraft(repoRoot, repoName);
        const ctx = createCtx({ isIdle: false });

        await emit("session_start", {}, ctx);
        await emitToolWrite(emit, ctx, specFileRelative);
        await emit("agent_end", {}, ctx);

        expect(startPlanReview).not.toHaveBeenCalled();
        expectReviewPromptSent(api.sendUserMessage, {
          path: specFileRelative,
          deliverAs: "followUp",
        });
      },
    );
  });

  it("gates files matching configured extra review targets until explicit submission", async () => {
    await withPlannotatorAutoTest(
      "plannotator-auto-extra-target-review-",
      async ({ api, emit, repoRoot, startPlanReview, createCtx }) => {
        const extraTargetRelative =
          ".pi/plans/pi-kit/office-hours/ming-main-office-hours-20260422-123456.md";
        await writeTestFile(repoRoot, extraTargetRelative, "# Office Hours\n");
        await writeTestFile(
          repoRoot,
          ".pi/third_extension_settings.json",
          `${JSON.stringify(
            {
              plannotatorAuto: {
                extraReviewTargets: [
                  {
                    dir: ".pi/plans/pi-kit/office-hours",
                    filePattern: "^[^/]+-office-hours-\\d{8}-\\d{6}\\.md$",
                  },
                ],
              },
            },
            null,
            2,
          )}\n`,
        );
        const ctx = createCtx({ isIdle: false });

        await emit("session_start", {}, ctx);
        await emitToolWrite(emit, ctx, extraTargetRelative);
        await emit("agent_end", {}, ctx);

        expect(startPlanReview).not.toHaveBeenCalled();
        expectReviewPromptSent(api.sendUserMessage, {
          path: extraTargetRelative,
          deliverAs: "followUp",
          shouldContainToolName: false,
        });
      },
    );
  });

  it("does not trigger plan review for legacy single-file configuration", async () => {
    await withPlannotatorAutoTest(
      "plannotator-auto-legacy-plan-",
      async ({ api, emit, repoRoot, startPlanReview, createCtx }) => {
        const planFileRelative = ".pi/PLAN.md";
        await writeTestFile(
          repoRoot,
          planFileRelative,
          "# Plan\n\n- [ ] first\n",
        );
        await writeTestFile(
          repoRoot,
          ".pi/third_extension_settings.json",
          `${JSON.stringify(
            {
              plannotatorAuto: {
                planFile: planFileRelative,
              },
            },
            null,
            2,
          )}\n`,
        );
        const ctx = createCtx({ isIdle: false });

        await emit("session_start", {}, ctx);
        await emitToolWrite(emit, ctx, planFileRelative);
        await flushMicrotasks();

        expect(startPlanReview).not.toHaveBeenCalled();
        expect(api.sendUserMessage).not.toHaveBeenCalled();
      },
    );
  });
});
