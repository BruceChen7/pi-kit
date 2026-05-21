import { describe, expect, it } from "vitest";
import {
  ACT_MODE_TODO_TOOL,
  buildCtx,
  buildHarness,
  completeApprovedDemoRun,
  demoPlanPath,
  lastModeWidgetCall,
  lastPersistedPlanModeSnapshot,
  lastTodoWidgetCall,
  oneItemCompletedSummary,
  PLAN_MODE_CURRENT_MODE_WIDGET,
  PLAN_MODE_TODO_TOOL,
  PLAN_MODE_TODOS_WIDGET,
  PLANNOTATOR_REVIEW_TOOL,
  plainWidgetText,
  planModeExtension,
  planModeStateEntry,
  registeredTool,
  sendAgentPrompt,
  sendInput,
  startPlanModeSession,
} from "./test-harness.js";

describe("plan-mode extension: todo state and widgets", () => {
  it("updates the act widget with the current in-progress step and completion counts", async () => {
    const harness = buildHarness();
    const ctx = buildCtx();
    planModeExtension(harness.api as unknown as ExtensionAPI);
    await harness.emit("session_start", {}, ctx);
    await harness.runCommand("plan-mode", "act", ctx);

    await harness.runTool(
      PLAN_MODE_TODO_TOOL,
      {
        action: "set",
        items: [
          { text: "实现状态机", status: "in_progress" },
          { text: "补充 README", status: "todo" },
        ],
      },
      ctx,
    );

    const widgetText = plainWidgetText(ctx);
    expect(widgetText).toContain("Act");
    expect(widgetText).toContain("实现状态机");
    expect(widgetText).toContain("0/2");
    expect(widgetText).toContain("#1 [~]");
    expect(ctx.ui.theme.fg).toHaveBeenCalledWith(
      "accent",
      expect.stringContaining("实现状态机"),
    );
  });

  it("keeps completed todo details below the editor", async () => {
    const harness = buildHarness();
    const ctx = buildCtx();
    planModeExtension(harness.api as unknown as ExtensionAPI);
    await harness.emit("session_start", {}, ctx);

    await harness.emit(
      "tool_result",
      {
        toolName: PLANNOTATOR_REVIEW_TOOL,
        isError: false,
        content: [
          {
            type: "text",
            text: "Review approved for .pi/plans/pi-kit/plan/2026-05-08-demo.md.",
          },
        ],
      },
      ctx,
    );
    await harness.runTool(
      PLAN_MODE_TODO_TOOL,
      {
        action: "set",
        items: [
          { text: "编写测试", status: "done" },
          { text: "实现改动", status: "done" },
          { text: "验证结果", status: "done" },
        ],
      },
      ctx,
    );

    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("plan-mode", undefined);
    expect(ctx.ui.setStatus).not.toHaveBeenCalledWith(
      "plan-mode",
      expect.stringContaining("review:act 3/3"),
    );
    const widgetText = plainWidgetText(ctx);
    expect(widgetText).toContain("completed");
    expect(widgetText).toContain("3/3");
    expect(widgetText).toContain("编写测试");
    expect(widgetText).toContain("实现改动");
    expect(widgetText).toContain("验证结果");
    expect(lastTodoWidgetCall(ctx)[2]).toEqual({ placement: "belowEditor" });
  });

  it("replaces a completed summary when a new todo list starts", async () => {
    const harness = buildHarness();
    const ctx = buildCtx();
    planModeExtension(harness.api as unknown as ExtensionAPI);
    await harness.emit("session_start", {}, ctx);
    await harness.runCommand("plan-mode", "act", ctx);

    await harness.runTool(
      PLAN_MODE_TODO_TOOL,
      {
        action: "set",
        items: [{ text: "完成第一批任务", status: "done" }],
      },
      ctx,
    );
    expect(plainWidgetText(ctx)).toContain("完成第一批任务");

    await harness.runTool(
      PLAN_MODE_TODO_TOOL,
      {
        action: "set",
        items: [{ text: "继续处理新任务", status: "todo" }],
      },
      ctx,
    );
    const widget = plainWidgetText(ctx);
    expect(widget).toContain("继续处理新任务");
    expect(widget).toContain("已完成 0/1 · 剩余 1 项");
  });

  it("hides a completed summary when the next user turn starts", async () => {
    const harness = buildHarness();
    const ctx = buildCtx();
    planModeExtension(harness.api as unknown as ExtensionAPI);
    await harness.emit("session_start", {}, ctx);
    await harness.runCommand("plan-mode", "act", ctx);

    await harness.runTool(
      PLAN_MODE_TODO_TOOL,
      {
        action: "set",
        items: [{ text: "完成第一批任务", status: "done" }],
      },
      ctx,
    );
    expect(plainWidgetText(ctx)).toContain("完成第一批任务");

    await sendInput(harness, ctx, "继续下一个需求", "interactive");
    await sendAgentPrompt(harness, ctx, "继续下一个需求");

    expect(lastTodoWidgetCall(ctx)).toEqual([
      PLAN_MODE_TODOS_WIDGET,
      undefined,
    ]);
    expect(lastPersistedPlanModeSnapshot(harness)).toMatchObject({
      todos: [],
      activeRun: null,
      recentRuns: [{ status: "archived" }],
    });
  });

  it("hides the completed summary when todos are cleared", async () => {
    const { harness, ctx } = await startPlanModeSession();

    await harness.runTool(
      PLAN_MODE_TODO_TOOL,
      {
        action: "set",
        items: [{ text: "完成后清理", status: "done" }],
      },
      ctx,
    );
    expect(plainWidgetText(ctx)).toContain("完成后清理");

    await harness.runTool(PLAN_MODE_TODO_TOOL, { action: "clear" }, ctx);

    expect(lastTodoWidgetCall(ctx)).toEqual([
      PLAN_MODE_TODOS_WIDGET,
      undefined,
    ]);
  });

  it("clears plan-mode UI on session shutdown after completed todos", async () => {
    const { harness, ctx } = await startPlanModeSession();

    await harness.runTool(
      PLAN_MODE_TODO_TOOL,
      {
        action: "set",
        items: [{ text: "完成后关闭 session", status: "done" }],
      },
      ctx,
    );
    expect(plainWidgetText(ctx)).toContain("完成后关闭 session");

    await expect(
      harness.emit("session_shutdown", {}, ctx),
    ).resolves.toBeUndefined();

    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("plan-mode", undefined);
    expect(lastModeWidgetCall(ctx)).toEqual([
      PLAN_MODE_CURRENT_MODE_WIDGET,
      undefined,
    ]);
    expect(lastTodoWidgetCall(ctx)).toEqual([
      PLAN_MODE_TODOS_WIDGET,
      undefined,
    ]);
  });

  it("marks the active plan run completed when all todos are done", async () => {
    const { harness, ctx } = await startPlanModeSession();

    const result = await harness.runTool(
      PLAN_MODE_TODO_TOOL,
      {
        action: "set",
        items: [{ text: "完成生命周期", status: "done" }],
      },
      ctx,
    );

    expect(result).toMatchObject({
      details: { activeRun: { status: "completed" } },
    });
    expect(plainWidgetText(ctx)).toContain(oneItemCompletedSummary);
  });

  it("archives completed runs before starting a new todo list", async () => {
    const { harness, ctx } = await startPlanModeSession();

    await harness.runTool(
      PLAN_MODE_TODO_TOOL,
      {
        action: "set",
        items: [{ text: "完成旧计划", status: "done" }],
      },
      ctx,
    );
    const result = await harness.runTool(
      PLAN_MODE_TODO_TOOL,
      {
        action: "set",
        items: [{ text: "开始新计划", status: "todo" }],
      },
      ctx,
    );

    expect(result).toMatchObject({
      details: {
        activeRun: { status: "draft", planPath: null },
        recentRuns: [{ status: "archived" }],
      },
    });
    expect(plainWidgetText(ctx)).toContain("开始新计划");
  });

  it("does not carry an old approved plan name into unrelated completed work", async () => {
    const { harness, ctx } = await startPlanModeSession();

    await completeApprovedDemoRun(harness, ctx);
    await harness.runCommand("plan-mode", "act", ctx);

    const started = await harness.runTool(
      PLAN_MODE_TODO_TOOL,
      {
        action: "set",
        items: [{ text: "补测试覆盖新的默认 prompt", status: "in_progress" }],
      },
      ctx,
    );

    expect(started).toMatchObject({
      details: { activeRun: { planPath: null, status: "draft" } },
    });

    await harness.runTool(
      PLAN_MODE_TODO_TOOL,
      { action: "update", id: 1, status: "done" },
      ctx,
    );

    const widget = plainWidgetText(ctx);
    expect(widget).toContain("completed");
    expect(widget).toContain("补测试覆盖新的默认 prompt");
    expect(widget).not.toContain("demo");
  });

  it("restores plan-mode state from the active session branch", async () => {
    const staleCompletedEntry = planModeStateEntry({
      mode: "act",
      phase: "act",
      todos: [{ id: 1, text: "旧分支任务", status: "done" }],
      nextTodoId: 2,
      activeRun: {
        id: "run-stale",
        status: "completed",
        planPath: demoPlanPath,
        todos: [{ id: 1, text: "旧分支任务", status: "done" }],
        nextTodoId: 2,
        createdAt: new Date(0).toISOString(),
      },
      readFiles: [],
      activePlanPath: demoPlanPath,
      reviewApprovedPlanPaths: [demoPlanPath],
      endConversationRequested: false,
    });
    const activeBranchEntry = planModeStateEntry({
      mode: "act",
      phase: "act",
      todos: [{ id: 1, text: "当前分支任务", status: "in_progress" }],
      nextTodoId: 2,
      activeRun: null,
      readFiles: [],
      activePlanPath: null,
      reviewApprovedPlanPaths: [],
      endConversationRequested: false,
    });
    const harness = buildHarness();
    const ctx = buildCtx(
      [activeBranchEntry, staleCompletedEntry],
      [activeBranchEntry],
    );
    planModeExtension(harness.api as unknown as ExtensionAPI);

    await harness.emit("session_start", {}, ctx);

    const widget = plainWidgetText(ctx);
    expect(widget).toContain("当前分支任务");
    expect(widget).not.toContain("demo");
  });

  it("shows user-facing run state in plan-mode status", async () => {
    const { harness, ctx } = await startPlanModeSession();

    await harness.runTool(
      PLAN_MODE_TODO_TOOL,
      {
        action: "set",
        items: [{ text: "查看状态", status: "todo" }],
      },
      ctx,
    );
    await harness.runCommand("plan-mode", "status", ctx);

    expect(ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("status: Waiting for review"),
      "info",
    );
  });

  it("toggles plan artifact format for the current session", async () => {
    const { harness, ctx } = await startPlanModeSession();

    await harness.runCommand("plan-mode", "format html", ctx);
    await harness.runCommand("plan-mode", "status", ctx);

    expect(ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("planArtifactFormat: html"),
      "info",
    );
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("formatSource: session"),
      "info",
    );
    expect(lastPersistedPlanModeSnapshot(harness)).toMatchObject({
      planArtifactFormatOverride: "html",
    });
  });

  it("normalizes pending todo input to todo", async () => {
    const harness = buildHarness();
    const ctx = buildCtx();
    planModeExtension(harness.api as unknown as ExtensionAPI);
    await harness.emit("session_start", {}, ctx);

    const result = await harness.runTool(
      PLAN_MODE_TODO_TOOL,
      {
        action: "set",
        items: [{ text: "确认需求", status: "pending" }],
      },
      ctx,
    );

    expect(result).toMatchObject({
      details: { todos: [{ text: "确认需求", status: "todo" }] },
    });
    expect(plainWidgetText(ctx)).toContain("#1 [ ] 确认需求");
  });

  it("guides agents to use set or add instead of create for TODOs", () => {
    const harness = buildHarness();
    planModeExtension(harness.api as unknown as ExtensionAPI);

    const todoTool = registeredTool(harness, PLAN_MODE_TODO_TOOL);
    const promptGuidance = todoTool.promptGuidelines?.join("\n") ?? "";

    expect(promptGuidance).toContain('Use action "set"');
    expect(promptGuidance).toContain('action "add"');
    expect(promptGuidance).toContain('Do not use action "create"');
  });

  it("registers act_mode_todo with act-specific guidance", async () => {
    const harness = buildHarness();
    const ctx = buildCtx();
    planModeExtension(harness.api as unknown as ExtensionAPI);

    await harness.emit("session_start", {}, ctx);
    const result = await harness.runTool(
      ACT_MODE_TODO_TOOL,
      {
        action: "set",
        items: [{ text: "直接执行", status: "todo" }],
      },
      ctx,
    );
    const todoTool = registeredTool(harness, ACT_MODE_TODO_TOOL);
    const promptGuidance = todoTool.promptGuidelines?.join("\n") ?? "";

    expect(todoTool.label).toBe("Act Mode TODO");
    expect(promptGuidance).toContain("Use act_mode_todo");
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("Current Act Mode TODO list"),
    });
  });

  it("restores mode and todos from the latest session snapshot", async () => {
    const restoredEntries: CustomEntry[] = [
      planModeStateEntry({
        mode: "act",
        phase: "act",
        todos: [{ id: 1, text: "恢复后的当前步骤", status: "in_progress" }],
        nextTodoId: 2,
        readFiles: [],
        activePlanPath: null,
        reviewApprovedPlanPaths: [],
        endConversationRequested: false,
      }),
    ];
    const harness = buildHarness();
    const ctx = buildCtx(restoredEntries);
    planModeExtension(harness.api as unknown as ExtensionAPI);

    await harness.emit("session_start", {}, ctx);

    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("plan-mode", undefined);
    expect(plainWidgetText(ctx)).toContain("恢复后的当前步骤");
  });

  it("reminds the agent to create a TODO before ending plan mode", async () => {
    const harness = buildHarness();
    const ctx = buildCtx();
    planModeExtension(harness.api as unknown as ExtensionAPI);
    await harness.emit("session_start", {}, ctx);
    await harness.runCommand("plan-mode", "plan", ctx);

    await harness.emit("agent_end", { messages: [] }, ctx);

    expect(harness.api.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("plan_mode_todo"),
      { deliverAs: "followUp" },
    );
  });

  it("requires a TODO for plan mode turns even when read-only feedback is provided", async () => {
    const { harness, ctx } = await startPlanModeSession();

    await sendAgentPrompt(
      harness,
      ctx,
      "why does the todo widget keep showing?",
    );
    await harness.emit("agent_end", { messages: [] }, ctx);

    expect(harness.api.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("plan_mode_todo"),
      { deliverAs: "followUp" },
    );
  });
});
