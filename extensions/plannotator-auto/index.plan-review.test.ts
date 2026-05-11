import { afterEach, describe, expect, it, vi } from "vitest";
import { PLANNOTATOR_PENDING_REVIEW_CHANNEL } from "../shared/internal-events.ts";
import {
  createFakePi,
  createTempRepo,
  createTestContext,
  type FakePlannotatorApiMock,
  flushMicrotasks,
  mockPlannotatorApi,
  removeTempRepo,
  type TestCtx,
  writeTestFile,
} from "./test-helpers.js";

async function importPlannotatorAuto() {
  return (await import("./index.js")).default;
}

type FakePi = ReturnType<typeof createFakePi>;
type Emit = FakePi["emit"];

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

type PlannotatorAutoTestHarness = FakePi &
  FakePlannotatorApiMock & {
    repoRoot: string;
    repoName: string;
    createCtx: (options?: Parameters<typeof createTestContext>[1]) => TestCtx;
  };

async function withPlannotatorAutoTest(
  repoPrefix: string,
  runTest: (harness: PlannotatorAutoTestHarness) => Promise<void>,
  apiMockOptions?: Parameters<typeof mockPlannotatorApi>[0],
): Promise<void> {
  vi.resetModules();
  const apiMocks = mockPlannotatorApi(apiMockOptions);

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
        expect(ctx.abort).not.toHaveBeenCalled();
        expect(api.sendUserMessage).not.toHaveBeenCalled();
      },
    );
  });

  it("queues manual review submission after a busy plan-file write", async () => {
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
        expect(ctx.abort).not.toHaveBeenCalled();
        expect(ctx.ui.notify).not.toHaveBeenCalled();
        expect(api.sendUserMessage).not.toHaveBeenCalled();
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

  it("does not send a follow-up gate message when a plan draft is still pending", async () => {
    await withPlannotatorAutoTest(
      "plannotator-auto-pending-gate-",
      async ({ api, emit, repoRoot, repoName, startPlanReview, createCtx }) => {
        const planFileRelative = await writePlanDraft(repoRoot, repoName);
        const ctx = createCtx();

        await emit("session_start", {}, ctx);
        await emitToolWrite(emit, ctx, planFileRelative);
        await emit("agent_end", {}, ctx);

        expect(startPlanReview).not.toHaveBeenCalled();
        expect(api.sendUserMessage).not.toHaveBeenCalled();
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
        expect(api.sendUserMessage).not.toHaveBeenCalled();
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
        expect(api.sendUserMessage).not.toHaveBeenCalled();
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
        expect(api.sendUserMessage).not.toHaveBeenCalled();
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
        expect(api.sendUserMessage).not.toHaveBeenCalled();
      },
    );
  });
});
