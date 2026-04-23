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

function mockPlanReviewApi(
  options: {
    createRequestPlannotator?: ReturnType<typeof vi.fn>;
    startPlanReview?: ReturnType<typeof vi.fn>;
    waitForReviewResult?: ReturnType<typeof vi.fn>;
    getStatus?: ReturnType<typeof vi.fn>;
    requestReviewStatus?: ReturnType<typeof vi.fn>;
  } = {},
) {
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
  emit: (name: string, event: unknown, ctx: unknown) => Promise<unknown>,
  ctx: unknown,
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

describe("plan review trigger timing", () => {
  it("immediately steers manual review submission after a busy plan-file write", async () => {
    vi.resetModules();
    const { startPlanReview } = mockPlanReviewApi({
      startPlanReview: vi.fn(async () => ({
        status: "handled" as const,
        result: {
          status: "pending" as const,
          reviewId: "review-immediate",
        },
      })),
    });

    const plannotatorAuto = await importPlannotatorAuto();
    const { api, emit } = createFakePi();
    plannotatorAuto(api as never);

    const repoRoot = await createTempRepo("plannotator-auto-plan-review-");
    const repoName = repoRoot.split("/").pop() ?? "repo";
    const planFileRelative = `.pi/plans/${repoName}/plan/2026-04-16-workflow.md`;
    await writeTestFile(repoRoot, planFileRelative, "# Plan\n\n- [ ] test\n");

    const ctx = createTestContext(repoRoot, { isIdle: false });

    try {
      await emit("session_start", {}, ctx);
      const reviewPromise = emitToolWrite(emit, ctx, planFileRelative);

      await flushMicrotasks();
      await reviewPromise;
      expect(startPlanReview).not.toHaveBeenCalled();
      expect(ctx.abort).toHaveBeenCalledTimes(1);
      expect(ctx.ui.notify).not.toHaveBeenCalled();
      expect(api.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining("plannotator_auto_submit_review"),
        { deliverAs: "steer" },
      );
      expect(api.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining(planFileRelative),
        { deliverAs: "steer" },
      );
    } finally {
      await emit("session_shutdown", {}, ctx);
      await removeTempRepo(repoRoot);
    }
  });

  it("does not show the review widget for pending-only plan review state", async () => {
    vi.resetModules();
    mockPlanReviewApi();

    const plannotatorAuto = await importPlannotatorAuto();
    const { api, emit } = createFakePi();
    plannotatorAuto(api as never);

    const repoRoot = await createTempRepo("plannotator-auto-pending-widget-");
    const repoName = repoRoot.split("/").pop() ?? "repo";
    const planFileRelative = `.pi/plans/${repoName}/plan/2026-04-16-workflow.md`;
    await writeTestFile(repoRoot, planFileRelative, "# Plan\n\n- [ ] test\n");

    const ctx = createTestContext(repoRoot);
    const setWidget = attachWidgetSpy(ctx);

    try {
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
    } finally {
      await emit("session_shutdown", {}, ctx);
      await removeTempRepo(repoRoot);
    }
  });

  it("sends a strict follow-up gate message at agent_end when a plan draft is still pending", async () => {
    vi.resetModules();
    const { startPlanReview } = mockPlanReviewApi();

    const plannotatorAuto = await importPlannotatorAuto();
    const { api, emit } = createFakePi();
    plannotatorAuto(api as never);

    const repoRoot = await createTempRepo("plannotator-auto-pending-gate-");
    const repoName = repoRoot.split("/").pop() ?? "repo";
    const planFileRelative = `.pi/plans/${repoName}/plan/2026-04-16-workflow.md`;
    await writeTestFile(repoRoot, planFileRelative, "# Plan\n\n- [ ] test\n");
    const ctx = createTestContext(repoRoot);

    try {
      await emit("session_start", {}, ctx);
      await emitToolWrite(emit, ctx, planFileRelative);
      await emit("agent_end", {}, ctx);

      expect(startPlanReview).not.toHaveBeenCalled();
      expect(api.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining("plannotator_auto_submit_review"),
        { deliverAs: "followUp" },
      );
      expect(api.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining(planFileRelative),
        { deliverAs: "followUp" },
      );
    } finally {
      await emit("session_shutdown", {}, ctx);
      await removeTempRepo(repoRoot);
    }
  });

  it("injects pending review guidance before the next agent turn", async () => {
    vi.resetModules();
    mockPlanReviewApi();

    const plannotatorAuto = await importPlannotatorAuto();
    const { emit, api } = createFakePi();
    plannotatorAuto(api as never);

    const repoRoot = await createTempRepo("plannotator-before-agent-start-");
    const repoName = repoRoot.split("/").pop() ?? "repo";
    const planFileRelative = `.pi/plans/${repoName}/plan/2026-04-16-workflow.md`;
    await writeTestFile(repoRoot, planFileRelative, "# Plan\n\n- [ ] test\n");
    const ctx = createTestContext(repoRoot);

    try {
      await emit("session_start", {}, ctx);
      await emitToolWrite(emit, ctx, planFileRelative);

      const result = (await emit("before_agent_start", {}, ctx)) as {
        message?: { content?: string };
      };

      expect(result.message?.content ?? "").toContain(
        "plannotator_auto_submit_review",
      );
      expect(result.message?.content ?? "").toContain(planFileRelative);
    } finally {
      await emit("session_shutdown", {}, ctx);
      await removeTempRepo(repoRoot);
    }
  });

  it("gates generated design specs until the agent submits the review explicitly", async () => {
    vi.resetModules();
    const { startPlanReview } = mockPlanReviewApi();

    const plannotatorAuto = await importPlannotatorAuto();
    const { api, emit } = createFakePi();
    plannotatorAuto(api as never);

    const repoRoot = await createTempRepo("plannotator-spec-review-");
    const repoName = repoRoot.split("/").pop() ?? "repo";
    const specFileRelative = `.pi/plans/${repoName}/specs/2026-04-20-agent-design.md`;
    await writeTestFile(repoRoot, specFileRelative, "# Spec\n\n- draft\n");
    const ctx = createTestContext(repoRoot, { isIdle: false });

    try {
      await emit("session_start", {}, ctx);
      await emitToolWrite(emit, ctx, specFileRelative);
      await emit("agent_end", {}, ctx);

      expect(startPlanReview).not.toHaveBeenCalled();
      expect(api.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining("plannotator_auto_submit_review"),
        { deliverAs: "followUp" },
      );
      expect(api.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining(specFileRelative),
        { deliverAs: "followUp" },
      );
    } finally {
      await emit("session_shutdown", {}, ctx);
      await removeTempRepo(repoRoot);
    }
  });

  it("gates files matching configured extra review targets until explicit submission", async () => {
    vi.resetModules();
    const { startPlanReview } = mockPlanReviewApi();

    const plannotatorAuto = await importPlannotatorAuto();
    const { api, emit } = createFakePi();
    plannotatorAuto(api as never);

    const repoRoot = await createTempRepo(
      "plannotator-auto-extra-target-review-",
    );
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
    const ctx = createTestContext(repoRoot, { isIdle: false });

    try {
      await emit("session_start", {}, ctx);
      await emitToolWrite(emit, ctx, extraTargetRelative);
      await emit("agent_end", {}, ctx);

      expect(startPlanReview).not.toHaveBeenCalled();
      expect(api.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining(extraTargetRelative),
        { deliverAs: "followUp" },
      );
    } finally {
      await emit("session_shutdown", {}, ctx);
      await removeTempRepo(repoRoot);
    }
  });

  it("does not trigger plan review for legacy single-file configuration", async () => {
    vi.resetModules();
    const { startPlanReview } = mockPlanReviewApi();

    const plannotatorAuto = await importPlannotatorAuto();
    const { api, emit } = createFakePi();
    plannotatorAuto(api as never);

    const repoRoot = await createTempRepo("plannotator-auto-legacy-plan-");
    const planFileRelative = ".pi/PLAN.md";
    await writeTestFile(repoRoot, planFileRelative, "# Plan\n\n- [ ] first\n");
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
    const ctx = createTestContext(repoRoot, { isIdle: false });

    try {
      await emit("session_start", {}, ctx);
      await emitToolWrite(emit, ctx, planFileRelative);
      await flushMicrotasks();

      expect(startPlanReview).not.toHaveBeenCalled();
      expect(api.sendUserMessage).not.toHaveBeenCalled();
    } finally {
      await emit("session_shutdown", {}, ctx);
      await removeTempRepo(repoRoot);
    }
  });
});
