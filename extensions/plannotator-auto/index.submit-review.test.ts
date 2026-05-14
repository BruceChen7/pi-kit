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

type SpawnSyncMockResult = {
  status: number;
  stdout?: string;
  stderr?: string;
  error?: Error;
};

function mockSpawnSync(result: SpawnSyncMockResult) {
  const spawnSync = vi.fn(() => result);
  vi.doMock("node:child_process", async (importOriginal) => ({
    ...(await importOriginal<typeof import("node:child_process")>()),
    spawnSync,
  }));
  return spawnSync;
}
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
    const spawnSync = mockSpawnSync({
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
      expect(spawnSync).toHaveBeenCalledWith(
        "plannotator",
        [],
        expect.objectContaining({
          cwd: repoRoot,
          encoding: "utf-8",
          env: expect.objectContaining({ PLANNOTATOR_CWD: repoRoot }),
          input: expect.stringContaining(
            '"hook_event_name":"PermissionRequest"',
          ),
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
    const spawnSync = mockSpawnSync({ status: 0, stdout: "", stderr: "" });

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
      expect(spawnSync).not.toHaveBeenCalledWith(
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

  it("does not enqueue a stale gate after CLI approval", async () => {
    vi.resetModules();
    const spawnSync = mockSpawnSync({
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
      expect(spawnSync).toHaveBeenCalledWith(
        "plannotator",
        [],
        expect.objectContaining({ cwd: repoRoot }),
      );
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
    const spawnSync = mockSpawnSync({
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

      expect(spawnSync).toHaveBeenCalledWith(
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

    const spawnSync = mockSpawnSync({
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

      expect(spawnSync).toHaveBeenCalled();
      expect(api.sendUserMessage).not.toHaveBeenCalled();
    } finally {
      await emit("session_shutdown", {}, ctx);
      await removeTempRepo(repoRoot);
    }
  });

  it("does not abort while running a manually submitted CLI review", async () => {
    vi.resetModules();
    mockSpawnSync({
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

  it("clears the review widget after manual CLI review completes", async () => {
    vi.resetModules();

    mockSpawnSync({
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

    mockSpawnSync({
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
