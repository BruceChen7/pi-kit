import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type PiKitPlannotatorReviewVerdictEvent,
  PLANNOTATOR_REVIEW_VERDICT_CHANNEL,
} from "../shared/internal-events.js";
import {
  createFakePi,
  createTempRepo,
  createTestContext,
  mockPlannotatorSpawnSequence,
  PLAN_DRAFT_CONTENT,
  removeTempRepo,
  type TestCtx,
  writeTestFile,
} from "./test-helpers.js";

async function importPlannotatorAuto() {
  return (await import("./index.js")).default;
}

const cliPlanApprovedStdout = JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PermissionRequest",
    decision: { behavior: "allow" },
  },
});

const cliPlanDeniedStdout = (message: string) =>
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "deny", message },
    },
  });

/** `plannotator annotate <file> --json` verdict with feedback (deny semantics). */
const cliAnnotatedStdout = (feedback: string) =>
  JSON.stringify({ decision: "annotated", feedback });

const cliApprovedStdout = JSON.stringify({ decision: "approved" });

const getPlanFileRelative = (repoRoot: string): string => {
  const repoName = repoRoot.split("/").pop() ?? "repo";
  return `.pi/plans/${repoName}/plan/2026-04-16-workflow.md`;
};

const getHtmlFileRelative = (repoRoot: string): string => {
  const repoName = repoRoot.split("/").pop() ?? "repo";
  return `.pi/html/${repoName}/2026-04-16-workflow.html`;
};

type EmitFn = (name: string, event: unknown, ctx: TestCtx) => Promise<unknown>;

async function emitToolWrite(
  emit: EmitFn,
  ctx: TestCtx,
  relativePath: string,
): Promise<void> {
  await emit(
    "tool_execution_start",
    { toolName: "write", toolCallId: "call-1", args: { path: relativePath } },
    ctx,
  );
  await emit(
    "tool_execution_end",
    { toolName: "write", toolCallId: "call-1", isError: false },
    ctx,
  );
}

/** The pending-review gate message pi would inject on the next agent turn. */
async function gateMessage(
  emit: EmitFn,
  ctx: TestCtx,
): Promise<string | undefined> {
  const result = (await emit("before_agent_start", {}, ctx)) as
    | { message?: { content?: string } }
    | undefined;
  return result?.message?.content;
}

type RunToolFn = (
  name: string,
  params: Record<string, unknown>,
  ctx: TestCtx,
) => Promise<unknown>;

async function submitReview(
  runTool: RunToolFn,
  ctx: TestCtx,
  relativePath: string,
): Promise<string | undefined> {
  const result = (await runTool(
    "plannotator_auto_submit_review",
    { path: relativePath },
    ctx,
  )) as { details?: { status?: string } };
  return result.details?.status;
}

/** Approve a plan through the auto flow: it ends up settled for the session. */
async function settlePlanThroughAutoReview(
  emit: EmitFn,
  runTool: RunToolFn,
  ctx: TestCtx,
  relativePath: string,
): Promise<void> {
  await emitToolWrite(emit, ctx, relativePath);
  expect(await submitReview(runTool, ctx, relativePath)).toBe("approved");

  // Settled: the next write stays silent (existing session behaviour).
  await emitToolWrite(emit, ctx, relativePath);
  expect(await gateMessage(emit, ctx)).toBeUndefined();
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("manual review re-arms the auto review gate", () => {
  let repoRoot: string;

  afterEach(async () => {
    if (repoRoot) {
      await removeTempRepo(repoRoot);
    }
  });

  it("queues later edits again after Ctrl+Shift+R asks for changes", async () => {
    vi.resetModules();
    mockPlannotatorSpawnSequence([
      { status: 0, stdout: cliPlanApprovedStdout },
      {
        status: 0,
        stdout: cliPlanDeniedStdout("Restructure the sections."),
      },
    ]);

    const plannotatorAuto = await importPlannotatorAuto();
    const { emit, runShortcut, runTool, api } = createFakePi();
    plannotatorAuto(api as never);

    repoRoot = await createTempRepo("plannotator-manual-rearm-");
    const planFileRelative = getPlanFileRelative(repoRoot);
    const planFilePath = await writeTestFile(
      repoRoot,
      planFileRelative,
      PLAN_DRAFT_CONTENT,
    );
    const ctx = createTestContext(repoRoot, {
      uiCustom: vi.fn().mockResolvedValue(planFilePath),
    });

    try {
      await emit("session_start", {}, ctx);
      await settlePlanThroughAutoReview(emit, runTool, ctx, planFileRelative);

      // Ctrl+Shift+R → manual review with feedback.
      await runShortcut("ctrl+shift+r", ctx);
      expect(api.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining("Restructure the sections."),
        { deliverAs: "followUp" },
      );

      // Re-armed: the revised plan queues for auto review again.
      await emitToolWrite(emit, ctx, planFileRelative);
      expect(await gateMessage(emit, ctx)).toContain(
        "plannotator_auto_submit_review",
      );
    } finally {
      await emit("session_shutdown", {}, ctx);
    }
  });

  it("queues later edits again through the /plannotator-review command", async () => {
    vi.resetModules();
    mockPlannotatorSpawnSequence([
      { status: 0, stdout: cliPlanApprovedStdout },
      {
        status: 0,
        stdout: cliPlanDeniedStdout("Revise the approved plan."),
      },
    ]);

    const plannotatorAuto = await importPlannotatorAuto();
    const { emit, runCommand, runTool, api } = createFakePi();
    plannotatorAuto(api as never);

    repoRoot = await createTempRepo("plannotator-manual-command-rearm-");
    const planFileRelative = getPlanFileRelative(repoRoot);
    const planFilePath = await writeTestFile(
      repoRoot,
      planFileRelative,
      PLAN_DRAFT_CONTENT,
    );
    const ctx = createTestContext(repoRoot, {
      uiCustom: vi.fn().mockResolvedValue(planFilePath),
    });

    try {
      await emit("session_start", {}, ctx);
      await settlePlanThroughAutoReview(emit, runTool, ctx, planFileRelative);

      await runCommand("plannotator-review", "", ctx);
      expect(api.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining("Revise the approved plan."),
        { deliverAs: "followUp" },
      );

      await emitToolWrite(emit, ctx, planFileRelative);
      expect(await gateMessage(emit, ctx)).toContain(
        "plannotator_auto_submit_review",
      );
    } finally {
      await emit("session_shutdown", {}, ctx);
    }
  });

  it("queues later edits again after Ctrl+Alt+L annotate feedback", async () => {
    vi.resetModules();
    mockPlannotatorSpawnSequence([
      { status: 0, stdout: cliPlanApprovedStdout },
      { status: 0, stdout: cliAnnotatedStdout("Tighten the boundaries.") },
      { status: 0, stdout: cliPlanApprovedStdout },
    ]);

    const plannotatorAuto = await importPlannotatorAuto();
    const { emit, runShortcut, runTool, api } = createFakePi();
    plannotatorAuto(api as never);

    repoRoot = await createTempRepo("plannotator-manual-annotate-rearm-");
    const planFileRelative = getPlanFileRelative(repoRoot);
    await writeTestFile(repoRoot, planFileRelative, PLAN_DRAFT_CONTENT);
    const ctx = createTestContext(repoRoot);

    try {
      await emit("session_start", {}, ctx);
      await settlePlanThroughAutoReview(emit, runTool, ctx, planFileRelative);

      // Ctrl+Alt+L → annotate the latest session document (the plan).
      await runShortcut("ctrl+alt+l", ctx);
      expect(api.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining("Tighten the boundaries."),
        { deliverAs: "followUp" },
      );

      await emitToolWrite(emit, ctx, planFileRelative);
      expect(await gateMessage(emit, ctx)).toContain(
        "plannotator_auto_submit_review",
      );

      // Approving the re-queued revision settles the path again.
      expect(await submitReview(runTool, ctx, planFileRelative)).toBe(
        "approved",
      );
      await emitToolWrite(emit, ctx, planFileRelative);
      expect(await gateMessage(emit, ctx)).toBeUndefined();
    } finally {
      await emit("session_shutdown", {}, ctx);
    }
  });

  it("keeps the plan settled after a manual approval", async () => {
    vi.resetModules();
    mockPlannotatorSpawnSequence([
      { status: 0, stdout: cliPlanApprovedStdout },
      { status: 0, stdout: cliPlanApprovedStdout },
    ]);

    const plannotatorAuto = await importPlannotatorAuto();
    const { emit, runShortcut, runTool, api } = createFakePi();
    plannotatorAuto(api as never);

    repoRoot = await createTempRepo("plannotator-manual-approved-");
    const planFileRelative = getPlanFileRelative(repoRoot);
    const planFilePath = await writeTestFile(
      repoRoot,
      planFileRelative,
      PLAN_DRAFT_CONTENT,
    );
    const ctx = createTestContext(repoRoot, {
      uiCustom: vi.fn().mockResolvedValue(planFilePath),
    });

    try {
      await emit("session_start", {}, ctx);
      await settlePlanThroughAutoReview(emit, runTool, ctx, planFileRelative);

      await runShortcut("ctrl+shift+r", ctx);
      expect(api.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining("Review approved"),
        { deliverAs: "followUp" },
      );

      await emitToolWrite(emit, ctx, planFileRelative);
      expect(await gateMessage(emit, ctx)).toBeUndefined();
    } finally {
      await emit("session_shutdown", {}, ctx);
    }
  });

  it("leaves the auto review state alone for non-auto-review documents", async () => {
    vi.resetModules();
    mockPlannotatorSpawnSequence([
      { status: 0, stdout: cliPlanApprovedStdout },
      { status: 0, stdout: cliPlanDeniedStdout("Add more detail.") },
    ]);

    const plannotatorAuto = await importPlannotatorAuto();
    const { emit, runShortcut, runTool, api } = createFakePi();
    plannotatorAuto(api as never);

    repoRoot = await createTempRepo("plannotator-manual-non-target-");
    const planFileRelative = getPlanFileRelative(repoRoot);
    const noteRelative = ".pi/teach/demo/lesson.md";
    await writeTestFile(repoRoot, planFileRelative, PLAN_DRAFT_CONTENT);
    await writeTestFile(repoRoot, noteRelative, "# Lesson\n\nNotes.");
    const ctx = createTestContext(repoRoot, {
      uiCustom: vi.fn().mockResolvedValue(path.join(repoRoot, noteRelative)),
    });

    try {
      await emit("session_start", {}, ctx);
      await settlePlanThroughAutoReview(emit, runTool, ctx, planFileRelative);

      // Reviewing a teach note must not touch the settled plan.
      await runShortcut("ctrl+shift+r", ctx);
      expect(api.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining("Add more detail."),
        { deliverAs: "followUp" },
      );

      await emitToolWrite(emit, ctx, planFileRelative);
      expect(await gateMessage(emit, ctx)).toBeUndefined();
    } finally {
      await emit("session_shutdown", {}, ctx);
    }
  });

  it("consumes the pending revision when it is reviewed manually", async () => {
    vi.resetModules();
    mockPlannotatorSpawnSequence([
      { status: 0, stdout: cliPlanApprovedStdout },
    ]);

    const plannotatorAuto = await importPlannotatorAuto();
    const { emit, runShortcut, runTool, api } = createFakePi();
    plannotatorAuto(api as never);

    repoRoot = await createTempRepo("plannotator-manual-pending-");
    const planFileRelative = getPlanFileRelative(repoRoot);
    const planFilePath = await writeTestFile(
      repoRoot,
      planFileRelative,
      PLAN_DRAFT_CONTENT,
    );
    const ctx = createTestContext(repoRoot, {
      uiCustom: vi.fn().mockResolvedValue(planFilePath),
    });

    try {
      await emit("session_start", {}, ctx);
      await emitToolWrite(emit, ctx, planFileRelative);
      expect(await gateMessage(emit, ctx)).toContain(
        "plannotator_auto_submit_review",
      );

      // The user reviews the pending revision by hand instead of letting the
      // agent auto-submit it.
      await runShortcut("ctrl+shift+r", ctx);

      expect(await gateMessage(emit, ctx)).toBeUndefined();

      // The submit tool is the channel other extensions observe approval
      // through (plan-mode reads `details.status === \"approved\"`), so the
      // manual verdict has to be claimable here — exactly once.
      const claimed = (await runTool(
        "plannotator_auto_submit_review",
        { path: planFileRelative },
        ctx,
      )) as {
        content?: Array<{ text?: string }>;
        details?: { status?: string };
      };
      expect(claimed.details?.status).toBe("approved");
      expect(claimed.content?.[0]?.text ?? "").toContain(
        `Review approved for ${planFileRelative}`,
      );

      const claimedAgain = (await runTool(
        "plannotator_auto_submit_review",
        { path: planFileRelative },
        ctx,
      )) as { details?: { status?: string } };
      expect(claimedAgain.details?.status).toBe("error");

      // Approved by hand → settled, so later writes stay silent.
      await emitToolWrite(emit, ctx, planFileRelative);
      expect(await gateMessage(emit, ctx)).toBeUndefined();
    } finally {
      await emit("session_shutdown", {}, ctx);
    }
  });

  it("reports a manual rejection once through the submit tool", async () => {
    vi.resetModules();
    mockPlannotatorSpawnSequence([
      { status: 0, stdout: cliPlanDeniedStdout("Use the timer interface.") },
      { status: 0, stdout: cliPlanApprovedStdout },
    ]);

    const plannotatorAuto = await importPlannotatorAuto();
    const { emit, runShortcut, runTool, api } = createFakePi();
    plannotatorAuto(api as never);

    repoRoot = await createTempRepo("plannotator-manual-rejected-");
    const planFileRelative = getPlanFileRelative(repoRoot);
    const planFilePath = await writeTestFile(
      repoRoot,
      planFileRelative,
      PLAN_DRAFT_CONTENT,
    );
    const ctx = createTestContext(repoRoot, {
      uiCustom: vi.fn().mockResolvedValue(planFilePath),
    });

    try {
      await emit("session_start", {}, ctx);
      await emitToolWrite(emit, ctx, planFileRelative);

      await runShortcut("ctrl+shift+r", ctx);

      const claimed = (await runTool(
        "plannotator_auto_submit_review",
        { path: planFileRelative },
        ctx,
      )) as {
        content?: Array<{ text?: string }>;
        details?: { status?: string };
      };
      expect(claimed.details?.status).toBe("denied");
      expect(claimed.content?.[0]?.text ?? "").toContain(
        "rejected in a manual review",
      );

      // Re-armed: revising the plan re-queues it, and the auto review works
      // again once the agent submits the revision.
      await emitToolWrite(emit, ctx, planFileRelative);
      expect(await gateMessage(emit, ctx)).toContain(
        "plannotator_auto_submit_review",
      );
      expect(await submitReview(runTool, ctx, planFileRelative)).toBe(
        "approved",
      );
    } finally {
      await emit("session_shutdown", {}, ctx);
    }
  });

  it("queues later edits of a document reviewed by hand outside plan/specs", async () => {
    vi.resetModules();
    mockPlannotatorSpawnSequence([
      {
        status: 0,
        stdout: cliPlanDeniedStdout("Add the numbers behind the claim."),
      },
      { status: 0, stdout: cliPlanApprovedStdout },
    ]);

    const plannotatorAuto = await importPlannotatorAuto();
    const { emit, runShortcut, runTool, api } = createFakePi();
    plannotatorAuto(api as never);

    repoRoot = await createTempRepo("plannotator-manual-outsider-");
    const docRelative = ".pi/research/2026-04-16-widget-display.md";
    const docPath = await writeTestFile(
      repoRoot,
      docRelative,
      PLAN_DRAFT_CONTENT,
    );
    const ctx = createTestContext(repoRoot, {
      uiCustom: vi.fn().mockResolvedValue(docPath),
    });

    try {
      await emit("session_start", {}, ctx);
      // The picker scans all of .pi, so a research document can be reviewed
      // by hand even though the auto flow never queues it.
      await runShortcut("ctrl+shift+r", ctx);
      expect(api.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining("Add the numbers behind the claim."),
        { deliverAs: "followUp" },
      );

      // The reviewed document became a review target for this session, so
      // the revision re-queues and the agent can auto-submit it.
      await emitToolWrite(emit, ctx, docRelative);
      expect(await gateMessage(emit, ctx)).toContain(
        "plannotator_auto_submit_review",
      );
      expect(await submitReview(runTool, ctx, docRelative)).toBe("approved");

      // Approved → settled: the loop ends instead of re-gating every write.
      await emitToolWrite(emit, ctx, docRelative);
      expect(await gateMessage(emit, ctx)).toBeUndefined();
    } finally {
      await emit("session_shutdown", {}, ctx);
    }
  });

  it("does not make a source file queue for review after a manual review", async () => {
    vi.resetModules();
    mockPlannotatorSpawnSequence([
      {
        status: 0,
        stdout: cliPlanDeniedStdout("Tighten the wording."),
      },
    ]);

    const plannotatorAuto = await importPlannotatorAuto();
    const { emit, runShortcut, api } = createFakePi();
    plannotatorAuto(api as never);

    repoRoot = await createTempRepo("plannotator-manual-source-");
    const docRelative = "extensions/demo/README.md";
    const docPath = await writeTestFile(
      repoRoot,
      docRelative,
      PLAN_DRAFT_CONTENT,
    );
    const ctx = createTestContext(repoRoot, {
      uiCustom: vi.fn().mockResolvedValue(docPath),
    });

    try {
      await emit("session_start", {}, ctx);
      // Ctrl+Alt+L can annotate any document in the session, including source
      // docs. Reviewing one must not turn its later edits into review gates.
      await runShortcut("ctrl+shift+r", ctx);

      await emitToolWrite(emit, ctx, docRelative);
      expect(await gateMessage(emit, ctx)).toBeUndefined();
    } finally {
      await emit("session_shutdown", {}, ctx);
    }
  });

  it("re-arms HTML artifacts reviewed manually", async () => {
    vi.resetModules();
    mockPlannotatorSpawnSequence([
      { status: 0, stdout: cliApprovedStdout },
      { status: 0, stdout: cliAnnotatedStdout("Refine the layout.") },
    ]);

    const plannotatorAuto = await importPlannotatorAuto();
    const { emit, runShortcut, runTool, api } = createFakePi();
    plannotatorAuto(api as never);

    repoRoot = await createTempRepo("plannotator-manual-html-rearm-");
    const htmlRelative = getHtmlFileRelative(repoRoot);
    const htmlPath = await writeTestFile(
      repoRoot,
      htmlRelative,
      "<html><body>Prototype</body></html>",
    );
    const ctx = createTestContext(repoRoot, {
      uiCustom: vi.fn().mockResolvedValue(htmlPath),
    });

    try {
      await emit("session_start", {}, ctx);
      await settlePlanThroughAutoReview(emit, runTool, ctx, htmlRelative);

      await runShortcut("ctrl+shift+r", ctx);
      expect(api.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining("Refine the layout."),
        { deliverAs: "followUp" },
      );

      await emitToolWrite(emit, ctx, htmlRelative);
      expect(await gateMessage(emit, ctx)).toContain(
        "plannotator_auto_submit_review",
      );
    } finally {
      await emit("session_shutdown", {}, ctx);
    }
  });
});

describe("manual review verdict broadcast", () => {
  let repoRoot: string;

  afterEach(async () => {
    if (repoRoot) {
      await removeTempRepo(repoRoot);
    }
  });

  const recordVerdicts = (
    api: ReturnType<typeof createFakePi>["api"],
  ): PiKitPlannotatorReviewVerdictEvent[] => {
    const verdicts: PiKitPlannotatorReviewVerdictEvent[] = [];
    api.events.on(PLANNOTATOR_REVIEW_VERDICT_CHANNEL, (event) => {
      verdicts.push(event as PiKitPlannotatorReviewVerdictEvent);
    });
    return verdicts;
  };

  const runManualReview = async (
    stdout: string,
    prefix: string,
  ): Promise<PiKitPlannotatorReviewVerdictEvent[]> => {
    mockPlannotatorSpawnSequence([{ status: 0, stdout }]);

    const plannotatorAuto = await importPlannotatorAuto();
    const { emit, runShortcut, api } = createFakePi();
    plannotatorAuto(api as never);
    const verdicts = recordVerdicts(api);

    repoRoot = await createTempRepo(prefix);
    const planFileRelative = getPlanFileRelative(repoRoot);
    const planFilePath = await writeTestFile(
      repoRoot,
      planFileRelative,
      PLAN_DRAFT_CONTENT,
    );
    const ctx = createTestContext(repoRoot, {
      uiCustom: vi.fn().mockResolvedValue(planFilePath),
    });

    try {
      await emit("session_start", {}, ctx);
      await emitToolWrite(emit, ctx, planFileRelative);
      await runShortcut("ctrl+shift+r", ctx);
    } finally {
      await emit("session_shutdown", {}, ctx);
    }
    return verdicts;
  };

  it("broadcasts an approved manual review", async () => {
    vi.resetModules();
    const verdicts = await runManualReview(
      cliPlanApprovedStdout,
      "plannotator-verdict-approved-",
    );

    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({
      cwd: repoRoot,
      path: getPlanFileRelative(repoRoot),
      approved: true,
    });
  });

  it("broadcasts a rejected manual review as not approved", async () => {
    vi.resetModules();
    const verdicts = await runManualReview(
      cliPlanDeniedStdout("Restructure the sections."),
      "plannotator-verdict-rejected-",
    );

    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({
      cwd: repoRoot,
      path: getPlanFileRelative(repoRoot),
      approved: false,
    });
  });

  it("stays silent when the review closes without a verdict", async () => {
    vi.resetModules();
    const verdicts = await runManualReview(
      JSON.stringify({ decision: "dismissed" }),
      "plannotator-verdict-dismissed-",
    );

    expect(verdicts).toHaveLength(0);
  });
});
