import { describe, expect, it } from "vitest";
import { PlanModeState, todoListSignature } from "./state.js";
import {
  ACT_MODE_TODO_TOOL,
  plainWidgetText,
  startPlanModeSession,
} from "./test-harness.js";
import type { PlanRunStatus, TodoStatus } from "./types.js";
import { formatRelativeTime } from "./ui.js";

// ── state: statuses are written only by the tool ──────────────

describe("todo state: no implicit status writes", () => {
  it("keeps every item as todo after set", () => {
    const state = new PlanModeState("act");
    state.replaceTodos([{ text: "a" }, { text: "b" }]);
    expect(state.todos.map((t) => t.status)).toEqual(["todo", "todo"]);
  });

  it("leaves the next item as todo when the current step is marked done", () => {
    const state = new PlanModeState("act");
    state.replaceTodos([{ text: "a" }, { text: "b" }, { text: "c" }]);
    state.updateTodo(1, { status: "done" });
    expect(state.todos.map((t) => t.status)).toEqual(["done", "todo", "todo"]);
  });

  it("does not promote the first remaining item after remove", () => {
    const state = new PlanModeState("act");
    state.replaceTodos([{ text: "a" }, { text: "b" }]);
    state.removeTodo(1);
    expect(state.todos.map((t) => t.status)).toEqual(["todo"]);
  });

  it("completes the run only when every item is done", () => {
    const state = new PlanModeState("act");
    state.replaceTodos([
      { text: "a", status: "done" },
      { text: "b", status: "done" },
    ]);
    expect(state.todos.map((t) => t.status)).toEqual(["done", "done"]);
    expect(state.activeRun?.status).toBe("completed");
  });

  it("starts a fresh run without inheriting the previous run's statuses", () => {
    const state = new PlanModeState("act");
    state.replaceTodos([{ text: "a" }, { text: "b" }]);
    state.updateTodo(1, { status: "done" });
    expect(state.todos[0].status).toBe("done");
    state.replaceTodos([{ text: "x", status: "done" }]);
    expect(state.todos[0].status).toBe("done");
    state.replaceTodos([{ text: "y" }]);
    expect(state.todos[0].status).toBe("todo");
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

// ── plan binding: only a live approval is inheritable ────────

describe("todo state: a run lends its plan only while that approval is live", () => {
  const plan = ".pi/plans/pi-kit/plan/2026-10-28-demo.md";

  const boundRun = (
    status: PlanRunStatus,
    approved: boolean,
  ): PlanModeState => {
    const state = new PlanModeState("act");
    state.replaceTodos([{ text: "a" }], plan);
    const run = state.activeRun;
    if (!run) {
      throw new Error("replaceTodos must create a run");
    }
    run.status = status;
    if (approved) {
      state.reviewApprovedPlanPaths.add(plan);
    }
    return state;
  };

  it.each([
    { status: "executing" as const, approved: true, expected: plan },
    { status: "executing" as const, approved: false, expected: null },
    { status: "draft" as const, approved: true, expected: null },
    { status: "draft" as const, approved: false, expected: null },
    { status: "completed" as const, approved: true, expected: null },
  ])(
    "run=$status approved=$approved lends $expected",
    ({ status, approved, expected }) => {
      expect(
        boundRun(status, approved).getApprovedUnfinishedRunPlanPath(),
      ).toBe(expected);
    },
  );

  it("drops the previous review artifact when an act run starts without a plan", () => {
    const state = boundRun("executing", true);
    state.latestReviewArtifactPath = plan;

    state.replaceTodos([{ text: "另一个任务" }], null);

    expect(state.latestReviewArtifactPath).toBeNull();
    expect(state.phase).toBe("act");
    expect(state.activeRun?.planPath).toBeNull();
  });

  it("keeps a draft written before any run existed, which the user may still approve", () => {
    const state = new PlanModeState("act");
    state.latestReviewArtifactPath = plan;

    state.replaceTodos([{ text: "新任务" }], null);

    expect(state.latestReviewArtifactPath).toBe(plan);
  });

  it("keeps the review artifact in plan mode, where a plan is still required", () => {
    const state = new PlanModeState("plan");
    state.latestReviewArtifactPath = plan;

    state.replaceTodos([{ text: "重写清单" }], null);

    expect(state.latestReviewArtifactPath).toBe(plan);
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
    // No item was started, so the heading must not claim progress.
    expect(widget).toContain("下一步 #1/2");
    expect(widget).not.toContain("进行中");
  });
});
