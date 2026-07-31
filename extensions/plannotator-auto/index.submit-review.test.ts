import { afterEach, describe, expect, it, vi } from "vitest";
import { PLANNOTATOR_PENDING_REVIEW_CHANNEL } from "../shared/internal-events.ts";
import {
  createFakePi,
  createTempRepo,
  createTestContext,
  flushMicrotasks,
  mockHangingPlannotatorSpawn,
  mockPlannotatorSpawn,
  removeTempRepo,
  writeTestFile,
} from "./test-helpers.js";

async function importPlannotatorAuto() {
  return (await import("./index.js")).default;
}

const mockSpawn = mockPlannotatorSpawn;
const PLAN_DRAFT_CONTENT = `# Plan

## Goal

这是一个用于测试的计划草稿，描述提交 Plannotator 审核前的上下文。

## Current Flow

\`\`\`mermaid
sequenceDiagram
  A->>B: current step
\`\`\`

## Desired Flow

\`\`\`mermaid
sequenceDiagram
  A->>B: new step  ← 新增
\`\`\`

## Boundaries

\`\`\`mermaid
sequenceDiagram
  L1->>L2: call  ← ownership
\`\`\`

## Implementation

parentFn()
  ├─ childA()  ← 条件分支
  └─ childB()  ← 副作用

## Testing

核心 value in / value out 测试场景。

## Decisions

推荐方案和被拒原因。

## Non-goals

不做什么。
`;

const INVALID_STANDARD_PLAN_CONTENT = "# Plan\n\n- [ ] test\n";

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

const getPlanFileRelative = (repoRoot: string): string => {
  const repoName = repoRoot.split("/").pop() ?? "repo";
  return `.pi/plans/${repoName}/plan/2026-04-16-workflow.md`;
};

type PendingReviewEvent = {
  handled?: {
    isHandled: () => boolean;
  };
};

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
  it("submits a pending plan draft through the Plannotator CLI", async () => {
    vi.resetModules();
    const spawn = mockSpawn({
      status: 0,
      stdout: cliPlanApprovedStdout,
      stderr: "",
    });
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

      const result = (await runTool(
        "plannotator_auto_submit_review",
        { path: planFileRelative },
        ctx,
      )) as {
        content?: Array<{ type?: string; text?: string }>;
        details?: { status?: string };
      };
      expect(spawn).toHaveBeenCalledWith(
        "plannotator",
        [],
        expect.objectContaining({
          cwd: repoRoot,
          env: expect.objectContaining({ PLANNOTATOR_CWD: repoRoot }),
          stdio: ["pipe", "pipe", "pipe"],
        }),
      );
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
    const spawn = mockSpawn({ status: 0, stdout: "", stderr: "" });

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
      expect(spawn).not.toHaveBeenCalledWith(
        "plannotator",
        expect.anything(),
        expect.anything(),
      );
      expect(emitted[0]?.handled?.isHandled()).toBe(false);
      expect(gateResult.message?.content ?? "").toContain(planFileRelative);
    } finally {
      await emit("session_shutdown", {}, ctx);
      await removeTempRepo(repoRoot);
    }
  });

  it("blocks plans with invalid mermaid before starting review", async () => {
    vi.resetModules();
    const spawn = mockSpawn({ status: 0, stdout: "", stderr: "" });

    const plannotatorAuto = await importPlannotatorAuto();
    const { emit, runTool, api } = createFakePi();
    plannotatorAuto(api as never);

    const repoRoot = await createTempRepo("plannotator-auto-bad-mermaid-");
    const planFileRelative = getPlanFileRelative(repoRoot);
    // Flowchart with an unquoted bracket label containing parens — the real
    // parser rejects it (no silent normalize/auto-fix anymore).
    const INVALID_MERMAID_PLAN = `# Plan

## Goal

坏 mermaid 校验用例。

## Current Flow

\`\`\`mermaid
flowchart TD
  A[bad (label] --> B
\`\`\`

## Desired Flow

\`\`\`mermaid
sequenceDiagram
  A->>B: new step
\`\`\`

## Boundaries

\`\`\`mermaid
sequenceDiagram
  L1->>L2: call
\`\`\`

## Implementation

parentFn()
  ├─ childA()
  └─ childB()

## Testing

核心 value in / value out。

## Decisions

推荐方案。

## Non-goals

不做的事。
`;
    await writeTestFile(repoRoot, planFileRelative, INVALID_MERMAID_PLAN);
    const ctx = createTestContext(repoRoot);

    try {
      await emit("session_start", {}, ctx);
      await emitToolWrite(emit, ctx, planFileRelative);

      const result = (await runTool(
        "plannotator_auto_submit_review",
        { path: planFileRelative },
        ctx,
      )) as {
        content?: Array<{ type?: string; text?: string }>;
        details?: { status?: string; reason?: string };
      };

      expect(result.details?.status).toBe("error");
      expect(result.details?.reason).toBe("mermaid-validation");
      expect(result.content?.[0]?.text ?? "").toContain("flowchart");
      expect(spawn).not.toHaveBeenCalledWith(
        "plannotator",
        expect.anything(),
        expect.anything(),
      );
    } finally {
      await emit("session_shutdown", {}, ctx);
      await removeTempRepo(repoRoot);
    }
  });

  it("proceeds with review and surfaces a notice when mermaid validation is skipped", async () => {
    vi.resetModules();
    const spawn = mockSpawn({
      status: 0,
      stdout: cliPlanApprovedStdout,
      stderr: "",
    });
    // Simulate a broken mermaid runtime: the validator degrades to skipped,
    // the gate must still submit and clearly say validation did not run.
    vi.doMock("./mermaid-validator.ts", () => ({
      runPlanMermaidValidation: vi.fn(async () => ({
        skipped: true,
        reason: "mock runtime down",
        errors: [],
      })),
      formatPlanMermaidErrors: vi.fn(() => ""),
    }));

    const plannotatorAuto = await importPlannotatorAuto();
    const { emit, runTool, api } = createFakePi();
    plannotatorAuto(api as never);

    const repoRoot = await createTempRepo("plannotator-auto-skip-mermaid-");
    const planFileRelative = getPlanFileRelative(repoRoot);
    await writeTestFile(repoRoot, planFileRelative, PLAN_DRAFT_CONTENT);
    const ctx = createTestContext(repoRoot);

    try {
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

      // Gate still submits to Plannotator…
      expect(spawn).toHaveBeenCalledWith(
        "plannotator",
        [],
        expect.objectContaining({ cwd: repoRoot }),
      );
      // …and the result explicitly says validation was skipped.
      expect(result.details?.status).toBe("approved");
      expect(result.content?.[0]?.text ?? "").toContain("mermaid 语法校验跳过");
      expect(result.content?.[0]?.text ?? "").toContain("mock runtime down");
    } finally {
      await emit("session_shutdown", {}, ctx);
      await removeTempRepo(repoRoot);
    }
  });

  it("does not enqueue a stale gate after CLI approval", async () => {
    vi.resetModules();
    const spawn = mockSpawn({
      status: 0,
      stdout: cliPlanApprovedStdout,
      stderr: "",
    });
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
      // The submit now runs real mermaid validation first (dynamic imports +
      // parse), so the CLI spawn may arrive a few async ticks later.
      await vi.waitFor(() => {
        expect(spawn).toHaveBeenCalledWith(
          "plannotator",
          [],
          expect.objectContaining({ cwd: repoRoot }),
        );
      });
      expect(api.sendUserMessage).not.toHaveBeenCalled();

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
      expect(api.sendUserMessage).not.toHaveBeenCalled();
    } finally {
      await emit("session_shutdown", {}, ctx);
      await removeTempRepo(repoRoot);
    }
  });

  it("keeps the pending gate available after CLI annotation feedback", async () => {
    vi.resetModules();
    const spawn = mockSpawn({
      status: 0,
      stdout: cliPlanDeniedStdout("Please revise."),
      stderr: "",
    });
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

      const result = (await runTool(
        "plannotator_auto_submit_review",
        { path: planFileRelative },
        ctx,
      )) as {
        details?: { status?: string };
      };
      const gateResult = (await emit("before_agent_start", {}, ctx)) as {
        message?: { content?: string };
      };

      expect(spawn).toHaveBeenCalledWith(
        "plannotator",
        [],
        expect.objectContaining({ cwd: repoRoot }),
      );
      expect(result.details?.status).toBe("denied");
      expect(gateResult.message?.content ?? "").toContain(
        "plannotator_auto_submit_review",
      );
      expect(gateResult.message?.content ?? "").toContain(planFileRelative);
      expect(api.sendUserMessage).not.toHaveBeenCalled();
    } finally {
      await emit("session_shutdown", {}, ctx);
      await removeTempRepo(repoRoot);
    }
  });

  it("does not poll review-status after CLI manual submit", async () => {
    vi.resetModules();

    const spawn = mockSpawn({
      status: 0,
      stdout: cliPlanApprovedStdout,
      stderr: "",
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

      await runTool(
        "plannotator_auto_submit_review",
        { path: planFileRelative },
        ctx,
      );
      await emit("agent_end", {}, ctx);

      expect(spawn).toHaveBeenCalled();
      expect(api.sendUserMessage).not.toHaveBeenCalled();
    } finally {
      await emit("session_shutdown", {}, ctx);
      await removeTempRepo(repoRoot);
    }
  });

  it("does not abort while running a manually submitted CLI review", async () => {
    vi.resetModules();
    mockSpawn({
      status: 0,
      stdout: cliPlanApprovedStdout,
      stderr: "",
    });
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

      await runTool(
        "plannotator_auto_submit_review",
        { path: planFileRelative },
        ctx,
      );

      expect(ctx.abort).not.toHaveBeenCalled();
    } finally {
      await emit("session_shutdown", {}, ctx);
      await removeTempRepo(repoRoot);
    }
  });

  it("kills the Plannotator CLI when manual review is aborted", async () => {
    vi.resetModules();
    const { getChild } = mockHangingPlannotatorSpawn();
    const plannotatorAuto = await importPlannotatorAuto();
    const { emit, runTool, api } = createFakePi();
    plannotatorAuto(api as never);

    const repoRoot = await createTempRepo("plannotator-auto-submit-abort-");
    const planFileRelative = getPlanFileRelative(repoRoot);
    await writeTestFile(repoRoot, planFileRelative, PLAN_DRAFT_CONTENT);
    const ctx = createTestContext(repoRoot);
    const abortController = new AbortController();

    try {
      await emit("session_start", {}, ctx);
      await emitToolWrite(emit, ctx, planFileRelative);

      const resultPromise = runTool(
        "plannotator_auto_submit_review",
        { path: planFileRelative },
        ctx,
        abortController.signal,
      ) as Promise<{ details?: { status?: string } }>;
      await flushMicrotasks();
      abortController.abort();
      const result = await resultPromise;

      expect(getChild()?.kill).toHaveBeenCalled();
      expect(result.details?.status).toBe("aborted");
    } finally {
      await emit("session_shutdown", {}, ctx);
      await removeTempRepo(repoRoot);
    }
  });

  it("clears the review widget after manual CLI review completes", async () => {
    vi.resetModules();

    mockSpawn({
      status: 0,
      stdout: cliPlanApprovedStdout,
      stderr: "",
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

      await runTool(
        "plannotator_auto_submit_review",
        { path: planFileRelative },
        ctx,
      );

      expect(setWidget).toHaveBeenLastCalledWith(
        "plannotator-auto-review",
        undefined,
      );
    } finally {
      await emit("session_shutdown", {}, ctx);
      await removeTempRepo(repoRoot);
    }
  });

  it("returns the submitted CLI review result", async () => {
    vi.resetModules();

    mockSpawn({
      status: 0,
      stdout: cliPlanApprovedStdout,
      stderr: "",
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

      const result = (await runTool(
        "plannotator_auto_submit_review",
        { path: planFileRelative },
        ctx,
      )) as { details?: { status?: string } };

      expect(result.details?.status).toBe("approved");
    } finally {
      await emit("session_shutdown", {}, ctx);
      await removeTempRepo(repoRoot);
    }
  });
});
