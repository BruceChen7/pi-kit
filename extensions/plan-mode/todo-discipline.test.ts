import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { PLAN_RUN_STATUS_EXECUTING } from "./constants.js";
import {
  buildTodoDisciplineReminder,
  clearTodoDisciplineMarkersForRun,
  decideTodoDisciplineReminders,
  TODO_DISCIPLINE_REMINDER_LIMIT,
  type TodoDoneFlip,
} from "./controller-decisions.js";
import { PlanModeState } from "./state.js";
import {
  ACT_MODE_TODO_TOOL,
  approveDemoPlan,
  buildCtx,
  buildHarness,
  demoPlanPath,
  emitAbortedAgentEnd,
  plainWidgetText,
  planModeExtension,
  planModeStateEntry,
  startPlanModeSession,
} from "./test-harness.js";
import type { PlanRun } from "./types.js";
import { formatRelativeTime } from "./ui.js";

// ── helpers ───────────────────────────────────────────────────

const executingRun = (todos: Array<{ status: string }>): PlanRun => ({
  id: "run-1",
  status: PLAN_RUN_STATUS_EXECUTING,
  planPath: demoPlanPath,
  nextTodoId: 1,
  createdAt: new Date(0).toISOString(),
  todos: todos.map((todo, index) => ({
    id: index + 1,
    text: `步骤${index + 1}`,
    status: todo.status as PlanRun["todos"][number]["status"],
  })),
});

const flip = (id: number, everInProgress = false): TodoDoneFlip => ({
  id,
  everInProgress,
});

// ── state normalization (①) ───────────────────────────────────

describe("todo discipline: state normalization", () => {
  it("promotes the first todo item to in_progress after set", () => {
    const state = new PlanModeState("act");
    state.replaceTodos([{ text: "a" }, { text: "b" }]);
    expect(state.todos.map((t) => t.status)).toEqual(["in_progress", "todo"]);
    expect(state.todos[0].everInProgress).toBe(true);
    expect(state.todos[1].everInProgress).toBeUndefined();
  });

  it("does not promote when an item is already in_progress", () => {
    const state = new PlanModeState("act");
    state.replaceTodos([{ text: "a", status: "in_progress" }, { text: "b" }]);
    expect(state.todos[0].status).toBe("in_progress");
    expect(state.todos[1].status).toBe("todo");
  });

  it("does not promote when any item is blocked", () => {
    const state = new PlanModeState("act");
    state.replaceTodos([{ text: "a", status: "blocked" }, { text: "b" }]);
    expect(state.todos.map((t) => t.status)).toEqual(["blocked", "todo"]);
  });

  it("does not promote when all items are done (run completes)", () => {
    const state = new PlanModeState("act");
    state.replaceTodos([
      { text: "a", status: "done" },
      { text: "b", status: "done" },
    ]);
    expect(state.todos.map((t) => t.status)).toEqual(["done", "done"]);
    expect(state.activeRun?.status).toBe("completed");
  });

  it("promotes the next item when the current step is marked done", () => {
    const state = new PlanModeState("act");
    state.replaceTodos([{ text: "a" }, { text: "b" }, { text: "c" }]);
    state.updateTodo(1, { status: "done" });
    expect(state.todos.map((t) => t.status)).toEqual([
      "done",
      "in_progress",
      "todo",
    ]);
    expect(state.todos[1].everInProgress).toBe(true);
  });

  it("promotes the first remaining item after remove of the in_progress item", () => {
    const state = new PlanModeState("act");
    state.replaceTodos([{ text: "a" }, { text: "b" }]);
    state.removeTodo(1);
    expect(state.todos.map((t) => t.status)).toEqual(["in_progress"]);
  });

  it("resets everInProgress for a fresh run on replaceTodos", () => {
    const state = new PlanModeState("act");
    state.replaceTodos([{ text: "a" }, { text: "b" }]);
    state.updateTodo(1, { status: "done" });
    expect(state.todos[0].everInProgress).toBe(true);
    state.replaceTodos([{ text: "x" }]);
    expect(state.todos[0].everInProgress).toBe(true); // fresh promotion sets it again
    expect(state.todos[0].id).toBe(1);
  });

  it("records lastTodoUpdateAt on every mutation path", () => {
    const state = new PlanModeState("act");
    state.replaceTodos([{ text: "a" }, { text: "b" }]);
    expect(state.activeRun?.lastTodoUpdateAt).toBeDefined();
    state.updateTodo(1, { status: "done" });
    expect(state.activeRun?.lastTodoUpdateAt).toBeDefined();
    state.addTodo("c");
    expect(state.activeRun?.lastTodoUpdateAt).toBeDefined();
    state.removeTodo(3);
    expect(state.activeRun?.lastTodoUpdateAt).toBeDefined();
  });
});

// ── decision function (②③) ───────────────────────────────────

describe("todo discipline: decideTodoDisciplineReminders", () => {
  const base = {
    run: executingRun([{ status: "in_progress" }, { status: "todo" }]),
    turnDoneFlips: [] as TodoDoneFlip[],
    reminderMarkers: new Set<string>(),
    reminderCounts: {} as Record<string, number>,
  };

  it("returns no reasons for a compliant turn", () => {
    const decision = decideTodoDisciplineReminders(base);
    expect(decision.reasons).toEqual([]);
    expect(decision.offenses).toEqual([]);
  });

  it("fires no-in-progress for an executing run without in_progress/blocked", () => {
    const decision = decideTodoDisciplineReminders({
      ...base,
      run: executingRun([{ status: "todo" }, { status: "todo" }]),
    });
    expect(decision.reasons).toEqual(["no-in-progress"]);
    expect(decision.offenses).toEqual(["no-in-progress"]);
  });

  it("does not fire no-in-progress when anything is blocked", () => {
    const decision = decideTodoDisciplineReminders({
      ...base,
      run: executingRun([{ status: "blocked" }, { status: "todo" }]),
    });
    expect(decision.reasons).toEqual([]);
  });

  it("does not fire no-in-progress for a non-executing run", () => {
    const decision = decideTodoDisciplineReminders({
      ...base,
      run: { ...executingRun([{ status: "todo" }]), status: "draft" },
    });
    expect(decision.reasons).toEqual([]);
  });

  it("does not fire batch-done for a single flip", () => {
    const decision = decideTodoDisciplineReminders({
      ...base,
      turnDoneFlips: [flip(2)],
    });
    expect(decision.reasons).toEqual([]);
  });

  it("fires batch-done for two never-in_progress flips in one turn", () => {
    const decision = decideTodoDisciplineReminders({
      ...base,
      turnDoneFlips: [flip(2), flip(3)],
    });
    expect(decision.reasons).toEqual(["batch-done"]);
  });

  it("exempts flips whose item was ever in_progress", () => {
    const decision = decideTodoDisciplineReminders({
      ...base,
      turnDoneFlips: [flip(2, true), flip(3, true)],
    });
    expect(decision.reasons).toEqual([]);
  });

  it("mixes a qualifying flip with an exempt one", () => {
    const decision = decideTodoDisciplineReminders({
      ...base,
      turnDoneFlips: [flip(2, true), flip(3)],
    });
    expect(decision.reasons).toEqual([]); // only one qualifying flip
  });

  it("suppresses a repeat offense via marker and keeps the marker", () => {
    const markers = new Set(["run-1:batch-done"]);
    const decision = decideTodoDisciplineReminders({
      ...base,
      turnDoneFlips: [flip(2), flip(3)],
      reminderMarkers: markers,
    });
    expect(decision.reasons).toEqual([]);
    expect(decision.offenses).toEqual(["batch-done"]);
    expect(decision.nextMarkers.has("run-1:batch-done")).toBe(true);
  });

  it("re-fires after the marker is cleared (re-arm) until the cap", () => {
    const decision = decideTodoDisciplineReminders({
      ...base,
      turnDoneFlips: [flip(2), flip(3)],
      reminderMarkers: new Set(),
      reminderCounts: { "run-1:batch-done": 1 },
    });
    expect(decision.reasons).toEqual(["batch-done"]);
    expect(decision.nextCounts["run-1:batch-done"]).toBe(2);
  });

  it("respects the per-run per-reason cap", () => {
    const decision = decideTodoDisciplineReminders({
      ...base,
      turnDoneFlips: [flip(2), flip(3)],
      reminderMarkers: new Set(),
      reminderCounts: {
        "run-1:batch-done": TODO_DISCIPLINE_REMINDER_LIMIT,
      },
    });
    expect(decision.reasons).toEqual([]);
    expect(decision.offenses).toEqual(["batch-done"]);
  });

  it("returns no reasons when there is no run", () => {
    const decision = decideTodoDisciplineReminders({ ...base, run: null });
    expect(decision.reasons).toEqual([]);
    expect(decision.offenses).toEqual([]);
  });
});

describe("todo discipline: marker helpers and message", () => {
  it("clears markers only for the given run", () => {
    const markers = new Set(["run-1:batch-done", "run-2:batch-done"]);
    const next = clearTodoDisciplineMarkersForRun(markers, "run-1");
    expect(next.has("run-1:batch-done")).toBe(false);
    expect(next.has("run-2:batch-done")).toBe(true);
  });

  it("builds a message naming the violated patterns and the todo tool", () => {
    const message = buildTodoDisciplineReminder(
      ["no-in-progress", "batch-done"],
      "act_mode_todo",
    );
    expect(message).toContain("act_mode_todo");
    expect(message).toContain("in_progress");
    expect(message).toContain("bulk-mark");
  });
});

// ── widget last-update hint ───────────────────────────────────

describe("todo discipline: widget last-update hint", () => {
  it("formats relative time", () => {
    const now = Date.parse("2026-08-05T12:00:00Z");
    expect(formatRelativeTime("2026-08-05T11:59:30Z", now)).toBe("刚刚");
    expect(formatRelativeTime("2026-08-05T11:58:00Z", now)).toBe("2 分钟前");
    expect(formatRelativeTime("2026-08-05T10:00:00Z", now)).toBe("2 小时前");
    expect(formatRelativeTime("2026-08-01T12:00:00Z", now)).toBe("4 天前");
    expect(formatRelativeTime("not-a-date", now)).toBe("");
  });

  it("shows the update time in the widget heading after set", async () => {
    const { harness, ctx } = await startPlanModeSession("act");
    await harness.runTool(
      ACT_MODE_TODO_TOOL,
      { action: "set", items: [{ text: "步骤1" }, { text: "步骤2" }] },
      ctx,
    );
    const widget = plainWidgetText(ctx);
    expect(widget).toContain("更新于 刚刚");
    expect(widget).toContain("进行中 #1/2");
  });
});

// ── controller integration (agent_end reminders) ──────────────

describe("todo discipline: agent_end reminders", () => {
  const setup = async () => {
    const ctx = buildCtx();
    const harness = buildHarness();
    planModeExtension(harness.api as unknown as ExtensionAPI);
    await harness.emit("session_start", {}, ctx);
    return { harness, ctx };
  };

  it("fires batch-done once when two never-in_progress items flip in one turn", async () => {
    const { harness, ctx } = await setup();
    await harness.runTool(
      ACT_MODE_TODO_TOOL,
      { action: "set", items: [{ text: "a" }, { text: "b" }, { text: "c" }] },
      ctx,
    );
    await approveDemoPlan(harness, ctx);
    await harness.runTool(
      ACT_MODE_TODO_TOOL,
      { action: "update", id: 2, status: "done" },
      ctx,
    );
    await harness.runTool(
      ACT_MODE_TODO_TOOL,
      { action: "update", id: 3, status: "done" },
      ctx,
    );
    await harness.emit("agent_end", { messages: [] }, ctx);

    expect(harness.api.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("bulk-mark"),
      expect.objectContaining({ deliverAs: "followUp" }),
    );
  });

  it("does not fire for a single flip in a turn (turn-scoped flips)", async () => {
    const { harness, ctx } = await setup();
    await harness.runTool(
      ACT_MODE_TODO_TOOL,
      { action: "set", items: [{ text: "a" }, { text: "b" }, { text: "c" }] },
      ctx,
    );
    await approveDemoPlan(harness, ctx);
    await harness.runTool(
      ACT_MODE_TODO_TOOL,
      { action: "update", id: 2, status: "done" },
      ctx,
    );
    await harness.emit("agent_end", { messages: [] }, ctx);
    expect(harness.api.sendUserMessage).not.toHaveBeenCalledWith(
      expect.stringContaining("bulk-mark"),
      expect.anything(),
    );
    // One flip in the next turn still does not accumulate with the previous turn.
    await harness.runTool(
      ACT_MODE_TODO_TOOL,
      { action: "update", id: 3, status: "done" },
      ctx,
    );
    await harness.emit("agent_end", { messages: [] }, ctx);
    expect(harness.api.sendUserMessage).not.toHaveBeenCalledWith(
      expect.stringContaining("bulk-mark"),
      expect.anything(),
    );
  });

  it("re-arms after a todo update and fires again, then respects the cap", async () => {
    const { harness, ctx } = await setup();
    // #1 stays in_progress the whole run (auto-promoted at set), so the
    // other items are never promoted and each fresh done-flip qualifies.
    const items = ["a", "b", "c", "d", "e", "f", "g", "h", "i"].map((text) => ({
      text,
    }));
    await harness.runTool(ACT_MODE_TODO_TOOL, { action: "set", items }, ctx);
    await approveDemoPlan(harness, ctx);

    const flipTwo = async (ids: number[]) => {
      for (const id of ids) {
        await harness.runTool(
          ACT_MODE_TODO_TOOL,
          { action: "update", id, status: "done" },
          ctx,
        );
      }
    };

    const bulkMarkCalls = () =>
      harness.api.sendUserMessage.mock.calls.filter(([message]) =>
        String(message).includes("bulk-mark"),
      ).length;

    // Turn 1: two flips → fire #1.
    await flipTwo([2, 3]);
    await harness.emit("agent_end", { messages: [] }, ctx);
    expect(bulkMarkCalls()).toBe(1);

    // Turn 2: two more flips (todo updates re-arm the marker) → fire #2.
    await flipTwo([4, 5]);
    await harness.emit("agent_end", { messages: [] }, ctx);
    expect(bulkMarkCalls()).toBe(2);

    // Turn 3: two more flips (re-armed again) → fire #3, reaching the cap.
    await flipTwo([6, 7]);
    await harness.emit("agent_end", { messages: [] }, ctx);
    expect(bulkMarkCalls()).toBe(3);

    // Turn 4: a single flip is no offense (and the cap is reached anyway).
    await harness.runTool(
      ACT_MODE_TODO_TOOL,
      { action: "update", id: 8, status: "done" },
      ctx,
    );
    await harness.emit("agent_end", { messages: [] }, ctx);
    expect(bulkMarkCalls()).toBe(3);

    // Turn 5: two fresh flips (re-armed) — cap suppresses any further fire.
    await flipTwo([9, 10]);
    await harness.emit("agent_end", { messages: [] }, ctx);
    expect(bulkMarkCalls()).toBe(3);
  });

  it("fires no-in-progress on the restore anomaly path (unfinished, no in_progress)", async () => {
    const ctx = buildCtx([
      planModeStateEntry({
        mode: "plan",
        phase: "act",
        todos: [
          { id: 1, text: "a", status: "todo" },
          { id: 2, text: "b", status: "todo" },
        ],
        nextTodoId: 3,
        activeRun: {
          id: "run-restored",
          status: "executing",
          planPath: demoPlanPath,
          todos: [
            { id: 1, text: "a", status: "todo" },
            { id: 2, text: "b", status: "todo" },
          ],
          nextTodoId: 3,
          createdAt: new Date(0).toISOString(),
        },
        recentRuns: [],
        readFiles: [],
        freshlyWrittenFiles: [],
        activePlanPath: demoPlanPath,
        latestReviewArtifactPath: demoPlanPath,
        reviewApprovedPlanPaths: [demoPlanPath],
        pendingApprovedPlanContinuationPath: null,
        confirmedApprovedContinuationPath: null,
        resumableApprovedPlanPath: null,
        endConversationRequested: false,
      }),
    ]);
    const harness = buildHarness();
    planModeExtension(harness.api as unknown as ExtensionAPI);
    await harness.emit("session_start", {}, ctx);
    await harness.emit("agent_end", { messages: [] }, ctx);

    expect(harness.api.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("nothing in_progress"),
      expect.objectContaining({ deliverAs: "followUp" }),
    );

    // Persistent offense with no todo updates stays suppressed by the marker.
    await harness.emit("agent_end", { messages: [] }, ctx);
    expect(
      harness.api.sendUserMessage.mock.calls.filter(([message]) =>
        String(message).includes("nothing in_progress"),
      ).length,
    ).toBe(1);
  });

  it("skips discipline reminders on an aborted turn", async () => {
    const { harness, ctx } = await setup();
    await harness.runTool(
      ACT_MODE_TODO_TOOL,
      { action: "set", items: [{ text: "a" }, { text: "b" }, { text: "c" }] },
      ctx,
    );
    await approveDemoPlan(harness, ctx);
    await harness.runTool(
      ACT_MODE_TODO_TOOL,
      { action: "update", id: 2, status: "done" },
      ctx,
    );
    await harness.runTool(
      ACT_MODE_TODO_TOOL,
      { action: "update", id: 3, status: "done" },
      ctx,
    );
    await emitAbortedAgentEnd(harness, ctx);

    expect(harness.api.sendUserMessage).not.toHaveBeenCalledWith(
      expect.stringContaining("bulk-mark"),
      expect.anything(),
    );
  });

  it("restore() resets markers and counts for a new episode", async () => {
    const ctx = buildCtx([
      planModeStateEntry({
        mode: "plan",
        phase: "act",
        todos: [
          { id: 1, text: "a", status: "todo" },
          { id: 2, text: "b", status: "todo" },
        ],
        nextTodoId: 3,
        activeRun: {
          id: "run-restored",
          status: "executing",
          planPath: demoPlanPath,
          todos: [
            { id: 1, text: "a", status: "todo" },
            { id: 2, text: "b", status: "todo" },
          ],
          nextTodoId: 3,
          createdAt: new Date(0).toISOString(),
        },
        recentRuns: [],
        readFiles: [],
        freshlyWrittenFiles: [],
        activePlanPath: demoPlanPath,
        latestReviewArtifactPath: demoPlanPath,
        reviewApprovedPlanPaths: [demoPlanPath],
        pendingApprovedPlanContinuationPath: null,
        confirmedApprovedContinuationPath: null,
        resumableApprovedPlanPath: null,
        endConversationRequested: false,
      }),
    ]);
    const harness = buildHarness();
    planModeExtension(harness.api as unknown as ExtensionAPI);

    // Episode 1: fires once, then the persistent offense is suppressed.
    await harness.emit("session_start", {}, ctx);
    await harness.emit("agent_end", { messages: [] }, ctx);
    expect(harness.api.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("nothing in_progress"),
      expect.anything(),
    );
    await harness.emit("agent_end", { messages: [] }, ctx);
    expect(
      harness.api.sendUserMessage.mock.calls.filter(([message]) =>
        String(message).includes("nothing in_progress"),
      ).length,
    ).toBe(1);

    // Episode 2: a fresh session_start restores and resets the discipline
    // state, so the same run state can remind again.
    await harness.emit("session_start", {}, ctx);
    await harness.emit("agent_end", { messages: [] }, ctx);
    expect(
      harness.api.sendUserMessage.mock.calls.filter(([message]) =>
        String(message).includes("nothing in_progress"),
      ).length,
    ).toBe(2);
  });

  it("does not disturb the normal approved-run completion flow", async () => {
    const { harness, ctx } = await setup();
    await harness.runTool(
      ACT_MODE_TODO_TOOL,
      { action: "set", items: [{ text: "a" }, { text: "b" }] },
      ctx,
    );
    await approveDemoPlan(harness, ctx);
    // Ordered completion: each step was in_progress (auto-promoted), so no
    // batch-done offense, and the run completes cleanly.
    await harness.runTool(
      ACT_MODE_TODO_TOOL,
      { action: "update", id: 1, status: "done" },
      ctx,
    );
    await harness.runTool(
      ACT_MODE_TODO_TOOL,
      { action: "update", id: 2, status: "done" },
      ctx,
    );
    await harness.emit("agent_end", { messages: [] }, ctx);

    expect(harness.api.sendUserMessage).not.toHaveBeenCalledWith(
      expect.stringContaining("bulk-mark"),
      expect.anything(),
    );
    expect(harness.api.sendUserMessage).not.toHaveBeenCalledWith(
      expect.stringContaining("nothing in_progress"),
      expect.anything(),
    );
  });
});
