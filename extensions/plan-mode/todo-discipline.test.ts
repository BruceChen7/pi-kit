import { describe, expect, it } from "vitest";
import { nextTodoToPromoteIndex, PlanModeState } from "./state.js";
import {
  ACT_MODE_TODO_TOOL,
  plainWidgetText,
  startPlanModeSession,
} from "./test-harness.js";
import type { TodoStatus } from "./types.js";
import { formatRelativeTime } from "./ui.js";

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
    // A fresh run's done item is never promoted, so the flag must not leak
    // from the previous run's objects.
    state.replaceTodos([{ text: "x", status: "done" }]);
    expect(state.todos[0].everInProgress).toBeUndefined();
    expect(state.todos[0].status).toBe("done");
    // A fresh pending item still gets promoted on the new run.
    state.replaceTodos([{ text: "y" }]);
    expect(state.todos[0].everInProgress).toBe(true);
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

// ── pure decision: nextTodoToPromoteIndex (①) ─────────────────

describe("todo discipline: nextTodoToPromoteIndex", () => {
  const todo = (id: number, status: string) => ({
    id,
    text: `步骤${id}`,
    status: status as TodoStatus,
  });

  it("promotes the first pending todo item", () => {
    expect(nextTodoToPromoteIndex([todo(1, "todo"), todo(2, "todo")])).toBe(0);
  });

  it("returns -1 when an item is already in_progress", () => {
    expect(
      nextTodoToPromoteIndex([
        todo(1, "todo"),
        todo(2, "in_progress"),
        todo(3, "todo"),
      ]),
    ).toBe(-1);
  });

  it("returns -1 when any item is blocked", () => {
    expect(nextTodoToPromoteIndex([todo(1, "blocked"), todo(2, "todo")])).toBe(
      -1,
    );
  });

  it("returns -1 when nothing is pending (all done or empty)", () => {
    expect(nextTodoToPromoteIndex([todo(1, "done"), todo(2, "done")])).toBe(-1);
    expect(nextTodoToPromoteIndex([])).toBe(-1);
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
