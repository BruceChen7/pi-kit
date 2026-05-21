import { describe, expect, it } from "vitest";
import {
  buildCtx,
  buildHarness,
  commitWithoutBranchPrompt,
  emitAbortedAgentEnd,
  expectPromptContract,
  lastPersistedPlanModeSnapshot,
  PLAN_MODE_TODO_TOOL,
  planModeExtension,
  sendAgentPrompt,
  sendInput,
  startPlanModeSession,
} from "./test-harness.js";

describe("plan-mode extension: prompt guards and reminders", () => {
  it("injects architecture testing guidance into act prompts", async () => {
    const { harness, ctx } = await startPlanModeSession("act");

    const result = await sendAgentPrompt(
      harness,
      ctx,
      "implement the guard bug fix",
    );

    expectPromptContract(result.systemPrompt, [
      "写测试",
      "Module",
      "Interface",
      "test surface",
    ]);
  });

  it("injects mandatory diagrams guidance into plan prompts", async () => {
    const { harness, ctx } = await startPlanModeSession();

    const result = await sendAgentPrompt(
      harness,
      ctx,
      "implement the guard bug fix",
    );

    expectPromptContract(result.systemPrompt, ["流程变更", "变更前后"]);
  });

  it("requires color-coded diagram changes in plan prompts", async () => {
    const { harness, ctx } = await startPlanModeSession();

    const result = await sendAgentPrompt(
      harness,
      ctx,
      "implement the guard bug fix",
    );

    expectPromptContract(result.systemPrompt, [
      "颜色",
      "数据变更",
      "逻辑变更",
      "新增",
      "删除",
      "修改",
    ]);
  });

  it("requires key code sketches in plan prompts", async () => {
    const { harness, ctx } = await startPlanModeSession();
    const result = await sendAgentPrompt(
      harness,
      ctx,
      "implement the guard bug fix",
    );

    expectPromptContract(result.systemPrompt, [
      "关键代码草案",
      "类型",
      "函数签名",
      "条件判断",
      "状态迁移",
      "测试断言",
      "## Context",
      "不能新增顶层章节",
    ]);
  });

  it("still requires a TODO for user implementation prompts in plan mode", async () => {
    const { harness, ctx } = await startPlanModeSession();

    await sendInput(harness, ctx, "fix the plan mode guard bug", "interactive");
    await sendAgentPrompt(harness, ctx, "fix the plan mode guard bug");
    await harness.emit("agent_end", { messages: [] }, ctx);

    expect(harness.api.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("plan_mode_todo"),
      { deliverAs: "followUp" },
    );
    expect(harness.api.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("plan mode requires a reviewed plan/spec"),
      { deliverAs: "followUp" },
    );
  });

  it("does not require plan review for extension-sourced implementation prompts", async () => {
    const { harness, ctx } = await startPlanModeSession();

    await sendInput(harness, ctx, "refactor the modified code", "extension");
    await sendAgentPrompt(harness, ctx, "refactor the modified code");
    await harness.emit("agent_end", { messages: [] }, ctx);

    expect(harness.api.sendUserMessage).not.toHaveBeenCalledWith(
      expect.stringContaining("plan_mode_todo"),
      expect.anything(),
    );
    expect(harness.api.sendUserMessage).not.toHaveBeenCalledWith(
      expect.stringContaining("approved Plannotator plan/spec"),
      expect.anything(),
    );
  });

  it("allows any tool during extension-sourced implementation prompts", async () => {
    const { harness, ctx } = await startPlanModeSession();

    await sendInput(harness, ctx, "refactor the modified code", "extension");
    await sendAgentPrompt(harness, ctx, "refactor the modified code");

    await expect(
      harness.runToolCall("bash", { command: "rm -rf src" }, ctx),
    ).resolves.toBeUndefined();
    await expect(
      harness.runToolCall("write", { path: "src/demo.ts" }, ctx),
    ).resolves.toBeUndefined();
  });

  it("explains why plan mode is waiting for approved review", async () => {
    const { harness, ctx } = await startPlanModeSession();

    await sendAgentPrompt(
      harness,
      ctx,
      "why is this workflow asking for TODOs?",
    );
    await harness.runTool(
      PLAN_MODE_TODO_TOOL,
      {
        action: "set",
        items: [{ text: "记录诊断结论", status: "todo" }],
      },
      ctx,
    );
    await harness.emit("agent_end", { messages: [] }, ctx);

    expect(harness.api.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("approved Plannotator plan/spec"),
      { deliverAs: "followUp" },
    );
    expect(harness.api.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining(
        "Reason: active TODO run has no approved plan/spec artifact",
      ),
      { deliverAs: "followUp" },
    );
  });

  it("keeps plan mode guarded even when workflow feedback is provided", async () => {
    const { harness, ctx } = await startPlanModeSession();

    const result = await sendAgentPrompt(harness, ctx, "提交当前改动", {
      kind: "workflow_only",
      confidence: 0.9,
      reason: "User requested only an operational workflow.",
      evidence: ["commit existing changes"],
      requestedOperations: ["git status", "git commit"],
    });

    expect(result).toMatchObject({
      systemPrompt: expect.stringContaining("Current workflow: Plan."),
    });
    await expect(
      harness.runToolCall("bash", { command: "git status --short" }, ctx),
    ).resolves.toMatchObject({ block: true });
  });

  it("keeps commit-only prompts in normal plan mode", async () => {
    const { harness, ctx } = await startPlanModeSession();

    await sendAgentPrompt(harness, ctx, commitWithoutBranchPrompt);

    expect(lastPersistedPlanModeSnapshot(harness)).toMatchObject({
      mode: "plan",
      phase: "plan",
    });
    await expect(
      harness.runToolCall("bash", { command: "git status --short" }, ctx),
    ).resolves.toMatchObject({ block: true });
  });

  it("keeps implementation prompts in normal plan mode", async () => {
    const { harness, ctx } = await startPlanModeSession();

    await sendAgentPrompt(harness, ctx, "fix the bug and commit");

    await expect(
      harness.runToolCall("bash", { command: "git status --short" }, ctx),
    ).resolves.toMatchObject({ block: true });
  });

  it("skips plan reminders after an aborted assistant turn", async () => {
    const harness = buildHarness();
    const ctx = buildCtx();
    planModeExtension(harness.api as unknown as ExtensionAPI);
    await harness.emit("session_start", {}, ctx);
    await harness.runCommand("plan-mode", "plan", ctx);

    await emitAbortedAgentEnd(harness, ctx);

    expect(harness.api.sendUserMessage).not.toHaveBeenCalled();
  });

  it("skips plan reminders when the runtime signal was aborted", async () => {
    const harness = buildHarness();
    const abortController = new AbortController();
    abortController.abort();
    const ctx = { ...buildCtx(), signal: abortController.signal };
    planModeExtension(harness.api as unknown as ExtensionAPI);
    await harness.emit("session_start", {}, ctx);
    await harness.runCommand("plan-mode", "plan", ctx);

    await harness.emit("agent_end", { messages: [] }, ctx);

    expect(harness.api.sendUserMessage).not.toHaveBeenCalled();
  });
});
