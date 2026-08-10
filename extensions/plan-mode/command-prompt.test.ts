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

  it("treats extension-injected prompts as direct act turns", async () => {
    const { harness, ctx } = await startPlanModeSession("act");

    await harness.runCommand("plan-mode", "plan", ctx);
    await sendInput(harness, ctx, "extension follow-up", "extension");
    const result = await sendAgentPrompt(
      harness,
      ctx,
      "please plan this extension follow-up",
    );

    expect(result.systemPrompt).toContain("Current workflow: Act.");
    expect(result.systemPrompt).toContain("Use act_mode_todo");
    expect(result.systemPrompt).not.toContain("Use plan_mode_todo");
    expect(harness.api.setActiveTools).toHaveBeenLastCalledWith(
      expect.arrayContaining([ACT_MODE_TODO_TOOL]),
    );
  });

  it("restores the selected plan mode tools after extension direct-act turns", async () => {
    const { harness, ctx } = await startPlanModeSession("act");

    await harness.runCommand("plan-mode", "plan", ctx);
    await sendInput(harness, ctx, "extension follow-up", "extension");
    await sendAgentPrompt(harness, ctx, "continue from extension follow-up");
    await harness.emit("agent_end", { messages: [] }, ctx);

    expect(harness.api.setActiveTools).toHaveBeenLastCalledWith(
      expect.arrayContaining([PLAN_MODE_TODO_TOOL]),
    );
  });

  it("keeps flow-tree plan guidance in plan artifact guidance", async () => {
    const { harness, ctx } = await startPlanModeSession("act");

    await harness.runCommand("plan-mode", "plan", ctx);
    const result = await sendAgentPrompt(harness, ctx, "plan this change");

    expectPromptContract(result.systemPrompt, [
      "Goal",
      "Current Flow",
      "Desired Flow",
      "Boundaries",
      "Implementation",
      "Testing",
      "Decisions",
      "Non-goals",
    ]);
    expect(result.systemPrompt).toContain("pre-submit checklist");
    expect(result.systemPrompt).toContain("```mermaid");
    expect(result.systemPrompt).toContain("├─");
  });

  it("keeps act prompts focused on execution guidance", async () => {
    const { harness, ctx } = await startPlanModeSession("act");

    const result = await sendAgentPrompt(harness, ctx, "implement this change");

    expect(result.systemPrompt).toContain("Functional Core, Imperative Shell");
    expect(result.systemPrompt).toContain("Module 的 Interface");
    expect(result.systemPrompt).not.toContain("flow tree");
    expect(result.systemPrompt).not.toContain("sequenceDiagram");
    expect(result.systemPrompt).not.toContain("关键数据结构");
    expect(result.systemPrompt).not.toContain("pre-submit checklist");
  });

  it("tells the agent where to write HTML review artifacts", async () => {
    const { harness, ctx } = await startPlanModeSession("act");

    const result = await sendAgentPrompt(harness, ctx, "make a prototype");

    expect(result.systemPrompt).toContain(
      "HTML review artifacts must be written under",
    );
    expect(result.systemPrompt).toContain("/repo/.pi/html/repo");
    expect(result.systemPrompt).toContain("YYYY-MM-DD-<slug>.html");
    expect(result.systemPrompt).toContain("plannotator_auto_submit_review");
  });

  it("completes plan-mode command arguments from pure command values", () => {
    const completionValues = (prefix: string) =>
      getPlanModeArgumentCompletions(prefix).map(
        (completion) => completion.value,
      );

    expect(completionValues("")).toEqual(["act", "plan", "status"]);
    expect(completionValues("h")).toEqual([]);
    expect(completionValues("format")).toEqual([]);
  });

  it("parses plan-mode command arguments as value decisions", () => {
    expect(parsePlanModeCommand("")).toEqual({ kind: "status" });
    expect(parsePlanModeCommand("status")).toEqual({ kind: "status" });
    expect(parsePlanModeCommand("format html")).toEqual({
      kind: "invalid-mode",
      value: "format html",
    });
    expect(parsePlanModeCommand("plan")).toEqual({
      kind: "mode",
      value: "plan",
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
