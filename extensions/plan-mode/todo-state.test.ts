import { describe, expect, it } from "vitest";
import {
  nextTodoToPromoteIndex,
  PlanModeState,
  todoListSignature,
} from "./state.js";
import {
  ACT_MODE_TODO_TOOL,
  plainWidgetText,
  startPlanModeSession,
} from "./test-harness.js";
import type { TodoStatus } from "./types.js";
import { formatRelativeTime } from "./ui.js";

// ── state normalization ───────────────────────────────────────

describe("todo state: normalization", () => {
  it("promotes the first todo item to in_progress after set", () => {
    const state = new PlanModeState("act");
    state.replaceTodos([{ text: "a" }, { text: "b" }]);
    expect(state.todos.map((t) => t.status)).toEqual(["in_progress", "todo"]);
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
  });

  it("promotes the first remaining item after remove of the in_progress item", () => {
    const state = new PlanModeState("act");
    state.replaceTodos([{ text: "a" }, { text: "b" }]);
    state.removeTodo(1);
    expect(state.todos.map((t) => t.status)).toEqual(["in_progress"]);
  });

  it("starts a fresh run without inheriting the previous run's statuses", () => {
    const state = new PlanModeState("act");
    state.replaceTodos([{ text: "a" }, { text: "b" }]);
    state.updateTodo(1, { status: "done" });
    expect(state.todos[0].status).toBe("done");
    // A fresh run's done item is never promoted.
    state.replaceTodos([{ text: "x", status: "done" }]);
    expect(state.todos[0].status).toBe("done");
    // A fresh pending item still gets promoted on the new run.
    state.replaceTodos([{ text: "y" }]);
    expect(state.todos[0].status).toBe("in_progress");
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

// ── pure decision: todoListSignature ──────────────────────────

describe("todo state: todoListSignature", () => {
  const item = (
    id: number,
    text: string,
    status: TodoStatus = "todo",
    notes?: string,
  ) => ({ id, text, status, ...(notes ? { notes } : {}) });

  it("ignores status and notes changes", () => {
    const before = [item(1, "第一步", "todo"), item(2, "第二步", "todo")];
    const after = [
      item(1, "第一步", "in_progress", "正在做"),
      item(2, "第二步", "blocked"),
    ];
    expect(todoListSignature(after)).toBe(todoListSignature(before));
  });

  it("changes when items are replaced (reconcile to a new plan)", () => {
    const before = [item(1, "写移植 spec")];
    const after = [item(1, "移植 picker 纯核"), item(2, "移植 quiz")];
    expect(todoListSignature(after)).not.toBe(todoListSignature(before));
  });

  it("changes when item text or id changes", () => {
    const base = [item(1, "第一步")];
    expect(todoListSignature([item(1, "改写后的第一步")])).not.toBe(
      todoListSignature(base),
    );
    expect(todoListSignature([item(2, "第一步")])).not.toBe(
      todoListSignature(base),
    );
  });

  it("is order sensitive and stable for repeated calls", () => {
    const first = [item(1, "a"), item(2, "b")];
    const swapped = [item(2, "b"), item(1, "a")];
    expect(todoListSignature(swapped)).not.toBe(todoListSignature(first));
    expect(todoListSignature(first)).toBe(todoListSignature(first));
    expect(todoListSignature([])).toBe("[]");
  });
});

// ── pure decision: nextTodoToPromoteIndex ─────────────────────

describe("todo state: nextTodoToPromoteIndex", () => {
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

describe("todo state: widget last-update hint", () => {
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
