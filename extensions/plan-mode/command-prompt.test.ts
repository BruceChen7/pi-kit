import { describe, expect, it } from "vitest";
import {
  ACT_MODE_TODO_TOOL,
  directActTodoGuidance,
  expectPromptContract,
  getPlanModeArgumentCompletions,
  lastModeWidgetCall,
  lastPersistedPlanModeSnapshot,
  PLAN_MODE_CURRENT_MODE_WIDGET,
  PLAN_MODE_TODO_TOOL,
  parsePlanModeCommand,
  sendAgentPrompt,
  sendInput,
  startPlanModeSession,
} from "./test-harness.js";

describe("plan-mode extension: commands and prompt basics", () => {
  it("defaults new sessions to act mode", async () => {
    const { harness, ctx } = await startPlanModeSession("act");

    const result = await sendAgentPrompt(harness, ctx, "answer directly");

    expect(result).toMatchObject({
      systemPrompt: expect.stringContaining("Current workflow: Act."),
    });
    expect(result.systemPrompt).toContain("Use act_mode_todo");
    expect(result.systemPrompt).not.toContain("Use plan_mode_todo");
    expect(harness.api.setActiveTools).toHaveBeenLastCalledWith(
      expect.arrayContaining([ACT_MODE_TODO_TOOL]),
    );
  });

  it("uses plan_mode_todo in plan mode", async () => {
    const { harness, ctx } = await startPlanModeSession("act");

    await harness.runCommand("plan-mode", "plan", ctx);
    const result = await sendAgentPrompt(harness, ctx, "plan this change");

    expect(result.systemPrompt).toContain("Use plan_mode_todo");
    expect(result.systemPrompt).not.toContain("Use act_mode_todo");
    expect(harness.api.setActiveTools).toHaveBeenLastCalledWith(
      expect.arrayContaining([PLAN_MODE_TODO_TOOL]),
    );
  });

  it("keeps review placeholder details in plan artifact guidance", async () => {
    const { harness, ctx } = await startPlanModeSession("act");

    await harness.runCommand("plan-mode", "plan", ctx);
    const result = await sendAgentPrompt(harness, ctx, "plan this change");

    expectPromptContract(result.systemPrompt, [
      "## Review",
      "改动点",
      "验证结果",
      "剩余风险",
      "根因原因",
    ]);
  });

  it("keeps act prompts focused on execution guidance", async () => {
    const { harness, ctx } = await startPlanModeSession("act");

    const result = await sendAgentPrompt(harness, ctx, "implement this change");

    expect(result.systemPrompt).toContain("Module 的 Interface");
    expect(result.systemPrompt).not.toContain("## Review 占位内容必须说明");
    expect(result.systemPrompt).not.toContain("关键代码草案");
    expect(result.systemPrompt).not.toContain("必须包含变更前后");
  });

  it("completes format arguments from pure command values", () => {
    const completionValues = (prefix: string) =>
      getPlanModeArgumentCompletions(prefix).map(
        (completion) => completion.value,
      );

    expect(completionValues("")).toEqual(["act", "plan", "status", "format"]);
    expect(completionValues("h")).toEqual([]);
    expect(completionValues("format ")).toEqual([
      "format html",
      "format markdown",
    ]);
    expect(completionValues("format h")).toEqual(["format html"]);
  });

  it("parses plan-mode command arguments as value decisions", () => {
    expect(parsePlanModeCommand("")).toEqual({ kind: "status" });
    expect(parsePlanModeCommand("status")).toEqual({ kind: "status" });
    expect(parsePlanModeCommand("format html")).toEqual({
      kind: "format",
      value: "html",
    });
    expect(parsePlanModeCommand("plan")).toEqual({
      kind: "mode",
      value: "plan",
    });
    expect(parsePlanModeCommand("format pdf")).toEqual({
      kind: "invalid-format",
    });
    expect(parsePlanModeCommand("auto")).toEqual({
      kind: "invalid-mode",
      value: "auto",
    });
  });

  it("requires concrete todos before direct act-mode task execution", async () => {
    const { harness, ctx } = await startPlanModeSession("act");

    const result = await sendAgentPrompt(
      harness,
      ctx,
      "commit all the changes",
    );

    expect(result.systemPrompt).toContain(directActTodoGuidance);
  });

  it("toggles plan mode with alt zero shortcut", async () => {
    const { harness, ctx } = await startPlanModeSession("act");

    await harness.runShortcut("alt+0", ctx);
    expect(lastPersistedPlanModeSnapshot(harness)).toMatchObject({
      mode: "plan",
      phase: "plan",
    });

    await harness.runShortcut("alt+0", ctx);
    expect(lastPersistedPlanModeSnapshot(harness)).toMatchObject({
      mode: "act",
      phase: "act",
    });
  });

  it("shows current plan mode in a persistent widget above the editor", async () => {
    const { harness, ctx } = await startPlanModeSession("act");

    let [key, lines, options] = lastModeWidgetCall(ctx);
    expect(key).toBe(PLAN_MODE_CURRENT_MODE_WIDGET);
    expect(options).toEqual({ placement: "aboveEditor" });
    expect((lines as string[]).join("\n")).toContain("Plan Mode: Act");

    await harness.runShortcut("alt+0", ctx);

    [key, lines, options] = lastModeWidgetCall(ctx);
    expect(key).toBe(PLAN_MODE_CURRENT_MODE_WIDGET);
    expect(options).toEqual({ placement: "aboveEditor" });
    expect((lines as string[]).join("\n")).toContain("Plan Mode: Plan");
  });

  it("enters plan directly without prompting when the prompt explicitly asks for plan", async () => {
    const { harness, ctx } = await startPlanModeSession();

    await sendInput(harness, ctx, "plan this change", "interactive");
    const result = await sendAgentPrompt(
      harness,
      ctx,
      "please plan this change first",
    );

    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      systemPrompt: expect.stringContaining("Current workflow: Plan."),
    });
  });

  it("rejects removed auto, fast, and review modes", async () => {
    const { harness, ctx } = await startPlanModeSession("act");

    await harness.runCommand("plan-mode", "auto", ctx);
    await harness.runCommand("plan-mode", "fast", ctx);
    await harness.runCommand("plan-mode", "review", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Unknown plan-mode: auto",
      "error",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Unknown plan-mode: fast",
      "error",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Unknown plan-mode: review",
      "error",
    );
  });

  // NOTE: no afterEach needed — no tests use vi.useFakeTimers()
});
