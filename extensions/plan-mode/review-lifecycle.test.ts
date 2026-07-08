import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  ACT_MODE_TODO_TOOL,
  approveDemoPlan,
  approvedPlanPolicyFixPrompt,
  buildCtx,
  buildHarness,
  completeApprovedDemoRun,
  demoPlanPath,
  emitAbortedAgentEnd,
  emitApprovedReview,
  emitReviewArtifactWrite,
  expectNoApprovedArtifactChangedFollowUp,
  expectNoApprovedContinuationFollowUp,
  expectToolAllowed,
  expectToolBlocked,
  invalidPlanContent,
  lastPersistedPlanModeSnapshot,
  PLAN_MODE_TODO_TOOL,
  PLANNOTATOR_REVIEW_TOOL,
  plainWidgetText,
  planModeExtension,
  sendAgentPrompt,
  startApprovedDemoRun,
  startPlanModeSession,
  validPlanContent,
  withTempCtx,
  writePlanArtifact,
  writeProjectSettings,
} from "./test-harness.js";

describe("plan-mode extension: review lifecycle", () => {
  it("switches plan mode to act phase after plannotator approves the submitted plan", async () => {
    const harness = buildHarness();
    const ctx = buildCtx();
    planModeExtension(harness.api as unknown as ExtensionAPI);
    await harness.emit("session_start", {}, ctx);
    await harness.runCommand("plan-mode", "plan", ctx);

    await approveDemoPlan(harness, ctx);

    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("plan-mode", undefined);
    await expectToolAllowed(harness, ctx, "write", { path: "x.ts" });
  });

  it("plan-continues approved plans for balanced preset", async () => {
    await withTempCtx(async (ctx) => {
      writeProjectSettings(ctx.cwd, {
        planMode: { defaultMode: "plan", preset: "balanced" },
      });
      writePlanArtifact(ctx.cwd, demoPlanPath, validPlanContent);
      const harness = buildHarness();
      planModeExtension(harness.api as unknown as ExtensionAPI);
      await harness.emit("session_start", {}, ctx);
      await completeApprovedDemoRun(harness, ctx, "提交 reviewable plan");
      await emitAbortedAgentEnd(harness, ctx);

      expect(ctx.ui.confirm).not.toHaveBeenCalled();
      expectNoApprovedContinuationFollowUp(harness);
    });
  });

  it("ignores legacy manual approval continuation config", async () => {
    await withTempCtx(async (ctx) => {
      writeProjectSettings(ctx.cwd, {
        planMode: { approval: { continueAfterApproval: "manual" } },
      });
      writePlanArtifact(ctx.cwd, demoPlanPath, validPlanContent);
      const harness = buildHarness();
      planModeExtension(harness.api as unknown as ExtensionAPI);
      await harness.emit("session_start", {}, ctx);
      await harness.runCommand("plan-mode", "plan", ctx);
      await completeApprovedDemoRun(harness, ctx, "提交 reviewable plan");
      await harness.emit("agent_end", { messages: [] }, ctx);

      expect(ctx.ui.confirm).not.toHaveBeenCalled();
      expectNoApprovedContinuationFollowUp(harness);
      expect(lastPersistedPlanModeSnapshot(harness)).toMatchObject({
        activePlanPath: demoPlanPath,
        pendingApprovedPlanContinuationPath: null,
        confirmedApprovedContinuationPath: null,
      });
    });
  });

  it("solo preset disables review waiting reminders", async () => {
    await withTempCtx(async (ctx) => {
      writeProjectSettings(ctx.cwd, { planMode: { preset: "solo" } });
      const harness = buildHarness();
      planModeExtension(harness.api as unknown as ExtensionAPI);
      await harness.emit("session_start", {}, ctx);
      await harness.runTool(
        PLAN_MODE_TODO_TOOL,
        {
          action: "set",
          items: [{ text: "solo task", status: "todo" }],
        },
        ctx,
      );
      await harness.emit("agent_end", { messages: [] }, ctx);

      expect(harness.api.sendUserMessage).not.toHaveBeenCalledWith(
        expect.stringContaining("approved Plannotator plan/spec"),
        expect.anything(),
      );
    });
  });

  it("does not inject an implementation follow-up after approval", async () => {
    await withTempCtx(async (ctx) => {
      writePlanArtifact(ctx.cwd, demoPlanPath, validPlanContent);
      const harness = buildHarness();
      planModeExtension(harness.api as unknown as ExtensionAPI);
      await harness.emit("session_start", {}, ctx);
      await harness.runCommand("plan-mode", "plan", ctx);
      await completeApprovedDemoRun(harness, ctx, "提交 reviewable plan");
      await harness.emit("agent_end", { messages: [] }, ctx);

      expect(ctx.ui.confirm).not.toHaveBeenCalled();
      expectNoApprovedContinuationFollowUp(harness);
      expect(lastPersistedPlanModeSnapshot(harness)).toMatchObject({
        activePlanPath: demoPlanPath,
        pendingApprovedPlanContinuationPath: null,
        confirmedApprovedContinuationPath: null,
      });
    });
  });

  it("does not emit implementation follow-ups for repeated approval results", async () => {
    await withTempCtx(async (ctx) => {
      writePlanArtifact(ctx.cwd, demoPlanPath, validPlanContent);
      const harness = buildHarness();
      planModeExtension(harness.api as unknown as ExtensionAPI);
      await harness.emit("session_start", {}, ctx);
      await harness.runCommand("plan-mode", "plan", ctx);

      const followUpCount = () =>
        harness.api.sendUserMessage.mock.calls.filter(([message, options]) => {
          const isImplementationFollowUp = String(message).includes(
            `Continue implementing approved plan: ${demoPlanPath}`,
          );
          return isImplementationFollowUp && options?.deliverAs === "followUp";
        }).length;

      await completeApprovedDemoRun(harness, ctx, "提交 reviewable plan");
      await harness.emit("agent_end", { messages: [] }, ctx);
      expect(followUpCount()).toBe(0);

      await approveDemoPlan(harness, ctx);
      await harness.emit("agent_end", { messages: [] }, ctx);

      expect(followUpCount()).toBe(0);
      expect(lastPersistedPlanModeSnapshot(harness)).toMatchObject({
        activePlanPath: demoPlanPath,
        pendingApprovedPlanContinuationPath: null,
        confirmedApprovedContinuationPath: null,
      });
    });
  });

  it("keeps approved act context without prompt matching", async () => {
    await withTempCtx(async (ctx) => {
      writePlanArtifact(ctx.cwd, demoPlanPath, validPlanContent);
      const harness = buildHarness();
      planModeExtension(harness.api as unknown as ExtensionAPI);
      await harness.emit("session_start", {}, ctx);
      await startApprovedDemoRun(harness, ctx, "执行批准计划");
      await harness.emit("agent_end", { messages: [] }, ctx);
      const result = await sendAgentPrompt(harness, ctx, "start");

      expect(result.systemPrompt).toContain("Use act_mode_todo");
      expect(result.systemPrompt).not.toContain("Use plan_mode_todo");
      expect(harness.api.setActiveTools).toHaveBeenLastCalledWith(
        expect.arrayContaining([ACT_MODE_TODO_TOOL]),
      );
      await harness.runTool(
        ACT_MODE_TODO_TOOL,
        {
          action: "set",
          items: [{ text: "执行批准计划", status: "in_progress" }],
        },
        ctx,
      );
      expect(plainWidgetText(ctx)).toContain(
        "【Approved, executing】进行中 #1/1：执行批准计划",
      );
      await expect(
        harness.runToolCall("bash", { command: "npm test" }, ctx),
      ).resolves.toBeUndefined();
      expect(lastPersistedPlanModeSnapshot(harness)).toMatchObject({
        phase: "act",
        activePlanPath: demoPlanPath,
        confirmedApprovedContinuationPath: null,
      });
    });
  });

  it("does not offer a decline path for approved continuation", async () => {
    await withTempCtx(async (ctx) => {
      ctx.ui.confirm.mockResolvedValueOnce(false);
      writePlanArtifact(ctx.cwd, demoPlanPath, validPlanContent);
      const harness = buildHarness();
      planModeExtension(harness.api as unknown as ExtensionAPI);
      await harness.emit("session_start", {}, ctx);
      await harness.runCommand("plan-mode", "plan", ctx);
      await completeApprovedDemoRun(harness, ctx, "提交 reviewable plan");
      await harness.emit("agent_end", { messages: [] }, ctx);

      expect(ctx.ui.confirm).not.toHaveBeenCalled();
      expectNoApprovedContinuationFollowUp(harness);
      expect(lastPersistedPlanModeSnapshot(harness)).toMatchObject({
        activePlanPath: demoPlanPath,
        pendingApprovedPlanContinuationPath: null,
        confirmedApprovedContinuationPath: null,
      });
    });
  });

  it("keeps completed approved runs in act despite prompt matching", async () => {
    const harness = buildHarness();
    const ctx = buildCtx();
    planModeExtension(harness.api as unknown as ExtensionAPI);
    await harness.emit("session_start", {}, ctx);
    await harness.runCommand("plan-mode", "plan", ctx);

    await completeApprovedDemoRun(harness, ctx, "提交 reviewable plan");
    await sendAgentPrompt(harness, ctx, "迁移到 Svelte + Vite");
    await sendAgentPrompt(harness, ctx, "impl it");

    expect(lastPersistedPlanModeSnapshot(harness)).toMatchObject({
      mode: "act",
      phase: "act",
    });
    await expect(
      harness.runToolCall("write", { path: "x.ts" }, ctx),
    ).resolves.toBeUndefined();
  });

  it("returns completed approved plan runs to act for unrelated work", async () => {
    const harness = buildHarness();
    const ctx = buildCtx();
    planModeExtension(harness.api as unknown as ExtensionAPI);
    await harness.emit("session_start", {}, ctx);
    await harness.runCommand("plan-mode", "plan", ctx);

    await completeApprovedDemoRun(harness, ctx);

    await sendAgentPrompt(harness, ctx, "迁移到 Svelte + Vite");

    expect(lastPersistedPlanModeSnapshot(harness)).toMatchObject({
      mode: "act",
      phase: "act",
      activePlanPath: null,
      pendingApprovedPlanContinuationPath: null,
      confirmedApprovedContinuationPath: null,
      resumableApprovedPlanPath: null,
    });
    await expectToolAllowed(harness, ctx, "write", { path: "x.ts" });
    await expectToolAllowed(harness, ctx, "bash", { command: "npm test" });
  });

  it("returns completed approved runs to act after continuation-like prompt matching", async () => {
    const harness = buildHarness();
    const ctx = buildCtx();
    planModeExtension(harness.api as unknown as ExtensionAPI);
    await harness.emit("session_start", {}, ctx);
    await harness.runCommand("plan-mode", "plan", ctx);

    await completeApprovedDemoRun(harness, ctx, "写入并提交 reviewable plan");

    await sendAgentPrompt(harness, ctx, "impl the plan");

    expect(lastPersistedPlanModeSnapshot(harness)).toMatchObject({
      mode: "act",
      phase: "act",
    });
    await expectToolAllowed(harness, ctx, "write", { path: "x.ts" });

    const result = await harness.runTool(
      PLAN_MODE_TODO_TOOL,
      {
        action: "set",
        items: [{ text: "实现已批准 plan", status: "todo" }],
      },
      ctx,
    );
    expect(result).toMatchObject({
      details: {
        activeRun: {
          planPath: null,
          status: "draft",
        },
      },
    });
  });

  it("keeps plan act for a new prompt while the approved run is unfinished", async () => {
    const harness = buildHarness();
    const ctx = buildCtx();
    planModeExtension(harness.api as unknown as ExtensionAPI);
    await harness.emit("session_start", {}, ctx);

    await startApprovedDemoRun(harness, ctx);

    await sendAgentPrompt(harness, ctx, "go ahead");

    await expect(
      harness.runToolCall("write", { path: "x.ts" }, ctx),
    ).resolves.toBeUndefined();
  });

  it("does not restore approved act context while fixing approved artifact policy", async () => {
    const { harness, ctx } = await startPlanModeSession();

    await completeApprovedDemoRun(harness, ctx);

    await sendAgentPrompt(harness, ctx, approvedPlanPolicyFixPrompt);

    const result = await harness.runTool(
      PLAN_MODE_TODO_TOOL,
      {
        action: "set",
        items: [
          {
            text: "修正已批准计划的 Review 段",
            status: "in_progress",
          },
        ],
      },
      ctx,
    );

    expect(result).toMatchObject({
      details: {
        activeRun: {
          planPath: null,
          status: "draft",
        },
      },
    });
    await expect(
      harness.runToolCall("write", { path: "x.ts" }, ctx),
    ).resolves.toMatchObject({ block: true });
  });

  it("uses the submitted path when approved review details omit the path", async () => {
    const harness = buildHarness();
    const ctx = buildCtx();
    planModeExtension(harness.api as unknown as ExtensionAPI);
    await harness.emit("session_start", {}, ctx);

    await harness.emit(
      "tool_result",
      {
        toolName: PLANNOTATOR_REVIEW_TOOL,
        isError: false,
        input: { path: ".pi/plans/pi-kit/plan/2026-05-08-demo.md" },
        content: [{ type: "text", text: "Review approved." }],
        details: { status: "approved" },
      },
      ctx,
    );

    await expect(
      harness.runToolCall("write", { path: "x.ts" }, ctx),
    ).resolves.toBeUndefined();
  });

  it("requires review again after an approved run is aborted without edits", async () => {
    await withTempCtx(async (ctx) => {
      writePlanArtifact(ctx.cwd, demoPlanPath, validPlanContent);
      const harness = buildHarness();
      planModeExtension(harness.api as unknown as ExtensionAPI);
      await harness.emit("session_start", {}, ctx);
      await startApprovedDemoRun(harness, ctx);

      await emitAbortedAgentEnd(harness, ctx);

      expect(harness.api.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining("approved execution was aborted"),
        { deliverAs: "followUp" },
      );
      expect(lastPersistedPlanModeSnapshot(harness)).toMatchObject({
        mode: "act",
        phase: "plan",
        activePlanPath: null,
        latestReviewArtifactPath: demoPlanPath,
        reviewApprovedPlanPaths: [],
        activeRun: {
          status: "draft",
          planPath: demoPlanPath,
        },
      });
    });
  });

  it("does not require review again after an executing approved run edits its artifact", async () => {
    await withTempCtx(async (ctx) => {
      writePlanArtifact(ctx.cwd, demoPlanPath, validPlanContent);
      const harness = buildHarness();
      planModeExtension(harness.api as unknown as ExtensionAPI);
      await harness.emit("session_start", {}, ctx);
      await startApprovedDemoRun(harness, ctx);
      await emitReviewArtifactWrite(harness, ctx, demoPlanPath);

      await harness.emit("agent_end", { messages: [] }, ctx);

      expectNoApprovedArtifactChangedFollowUp(harness);
      expect(lastPersistedPlanModeSnapshot(harness)).toMatchObject({
        mode: "act",
        phase: "act",
        activePlanPath: demoPlanPath,
        latestReviewArtifactPath: demoPlanPath,
        reviewApprovedPlanPaths: [demoPlanPath],
        activeRun: {
          status: "executing",
          planPath: demoPlanPath,
        },
      });
    });
  });

  it("does not require review again after a completed approved run edits its artifact", async () => {
    await withTempCtx(async (ctx) => {
      writePlanArtifact(ctx.cwd, demoPlanPath, validPlanContent);
      const harness = buildHarness();
      planModeExtension(harness.api as unknown as ExtensionAPI);
      await harness.emit("session_start", {}, ctx);
      await completeApprovedDemoRun(harness, ctx);
      await emitReviewArtifactWrite(harness, ctx, demoPlanPath);

      await harness.emit("agent_end", { messages: [] }, ctx);

      expectNoApprovedArtifactChangedFollowUp(harness);
      expect(lastPersistedPlanModeSnapshot(harness)).toMatchObject({
        mode: "act",
        phase: "act",
        activePlanPath: demoPlanPath,
        latestReviewArtifactPath: demoPlanPath,
        reviewApprovedPlanPaths: [demoPlanPath],
        activeRun: {
          status: "completed",
          planPath: demoPlanPath,
        },
      });
    });
  });

  it("requires review again after an aborted run even if it rewrites an approved artifact", async () => {
    await withTempCtx(async (ctx) => {
      writePlanArtifact(ctx.cwd, demoPlanPath, validPlanContent);
      const harness = buildHarness();
      planModeExtension(harness.api as unknown as ExtensionAPI);
      await harness.emit("session_start", {}, ctx);
      await startApprovedDemoRun(harness, ctx);
      await emitReviewArtifactWrite(harness, ctx, demoPlanPath);

      await emitAbortedAgentEnd(harness, ctx);

      expect(harness.api.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining("approved execution was aborted"),
        { deliverAs: "followUp" },
      );
      expect(lastPersistedPlanModeSnapshot(harness)).toMatchObject({
        mode: "act",
        phase: "plan",
        activePlanPath: null,
        latestReviewArtifactPath: demoPlanPath,
        reviewApprovedPlanPaths: [],
        activeRun: {
          status: "draft",
          planPath: demoPlanPath,
        },
      });
    });
  });

  it("requires review again after a newer plan artifact is written", async () => {
    await withTempCtx(async (ctx) => {
      const firstPlanPath = ".pi/plans/pi-kit/plan/2026-05-08-first.md";
      const secondPlanPath = ".pi/plans/pi-kit/plan/2026-05-08-second.md";
      writePlanArtifact(ctx.cwd, firstPlanPath, validPlanContent);
      writePlanArtifact(ctx.cwd, secondPlanPath, validPlanContent);
      const harness = buildHarness();
      planModeExtension(harness.api as unknown as ExtensionAPI);

      await harness.emit("session_start", {}, ctx);

      await emitReviewArtifactWrite(harness, ctx, firstPlanPath);
      await emitApprovedReview(harness, ctx, firstPlanPath);
      await harness.runCommand("plan-mode", "plan", ctx);
      await harness.runTool(
        PLAN_MODE_TODO_TOOL,
        {
          action: "set",
          items: [{ text: "实现第二个任务", status: "todo" }],
        },
        ctx,
      );
      await emitReviewArtifactWrite(harness, ctx, secondPlanPath);

      await harness.emit("agent_end", { messages: [] }, ctx);

      expect(harness.api.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining("approved Plannotator plan/spec"),
        { deliverAs: "followUp" },
      );
    });
  });

  it("blocks review submission when a plan artifact violates the policy", async () => {
    await withTempCtx(async (ctx) => {
      const planPath = ".pi/plans/pi-kit/plan/2026-05-08-demo.md";
      writePlanArtifact(ctx.cwd, planPath, invalidPlanContent);
      const { harness } = await startPlanModeSession("act", ctx);

      await expectToolBlocked(
        harness,
        ctx,
        PLANNOTATOR_REVIEW_TOOL,
        { path: planPath },
        {
          block: true,
          reason: expect.stringContaining("Plan Mode artifact policy"),
        },
      );
    });
  });

  it("allows review submission when a plan artifact satisfies the policy", async () => {
    await withTempCtx(async (ctx) => {
      const planPath = ".pi/plans/pi-kit/plan/2026-05-08-demo.md";
      writePlanArtifact(ctx.cwd, planPath, validPlanContent);
      const { harness } = await startPlanModeSession("act", ctx);

      await expectToolAllowed(harness, ctx, PLANNOTATOR_REVIEW_TOOL, {
        path: planPath,
      });
    });
  });

  it("reminds the agent to fix the latest invalid plan artifact", async () => {
    await withTempCtx(async (ctx) => {
      const planPath = ".pi/plans/pi-kit/plan/2026-05-08-demo.md";
      writePlanArtifact(ctx.cwd, planPath, invalidPlanContent);
      const { harness } = await startPlanModeSession("act", ctx);

      await harness.runTool(
        PLAN_MODE_TODO_TOOL,
        {
          action: "set",
          items: [{ text: "修复 plan 格式", status: "todo" }],
        },
        ctx,
      );
      await emitReviewArtifactWrite(harness, ctx, planPath);

      await harness.emit("agent_end", { messages: [] }, ctx);

      const [[message, options]] = harness.api.sendUserMessage.mock.calls;
      expect(message).toEqual(
        expect.stringContaining("Plan Mode artifact policy"),
      );
      expect(message).toEqual(
        expect.stringContaining("plannotator_auto_submit_review"),
      );
      expect(options).toEqual({ deliverAs: "followUp" });
    });
  });

  it("does not ask to resubmit review for an approved invalid plan artifact", async () => {
    await withTempCtx(async (ctx) => {
      const planPath = ".pi/plans/pi-kit/plan/2026-05-08-demo.md";
      writePlanArtifact(ctx.cwd, planPath, invalidPlanContent);
      const { harness } = await startPlanModeSession("act", ctx);

      await harness.runTool(
        PLAN_MODE_TODO_TOOL,
        {
          action: "set",
          items: [{ text: "修复已批准 plan 格式", status: "todo" }],
        },
        ctx,
      );
      await emitApprovedReview(harness, ctx, planPath);

      await harness.emit("agent_end", { messages: [] }, ctx);

      const [[message, options]] = harness.api.sendUserMessage.mock.calls;
      expect(message).toEqual(
        expect.stringContaining("Plan Mode artifact policy"),
      );
      expect(message).not.toContain("plannotator_auto_submit_review");
      expect(options).toEqual({ deliverAs: "followUp" });
    });
  });
});
