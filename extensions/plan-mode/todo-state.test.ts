import { describe, expect, it } from "vitest";
import { PlanModeState } from "./state.js";
import {
  ACT_MODE_TODO_TOOL,
  plainWidgetText,
  startPlanModeSession,
} from "./test-harness.js";
import type { PlanRunStatus } from "./types.js";
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

describe("todo state: approval switches runs", () => {
  it("archives the list that produced the plan and starts an empty bound run", () => {
    const state = new PlanModeState("plan");
    state.replaceTodos([
      { text: "写方案" },
      { text: "提交评审", status: "in_progress" },
    ]);

    state.beginApprovedExecutionRun("plan.md");

    expect(state.todos).toEqual([]);
    expect(state.activeRun?.planPath).toBe("plan.md");
    expect(state.activeRun?.status).toBe("executing");
    expect(state.recentRuns).toHaveLength(1);
    expect(state.recentRuns[0].status).toBe("archived");
    expect(state.recentRuns[0].todos.map((todo) => todo.text)).toEqual([
      "写方案",
      "提交评审",
    ]);
  });

  it("drops a run that never carried a list instead of archiving it", () => {
    const state = new PlanModeState("plan");
    state.replaceTodos([]);

    state.beginApprovedExecutionRun("plan.md");

    expect(state.recentRuns).toHaveLength(0);
    expect(state.activeRun?.planPath).toBe("plan.md");
  });

  it("leaves the list alone when the run already follows the plan", () => {
    const state = new PlanModeState("plan");
    state.beginApprovedExecutionRun("plan.md");
    state.addTodo("执行第一步");

    state.beginApprovedExecutionRun("plan.md");

    expect(state.todos.map((todo) => todo.text)).toEqual(["执行第一步"]);
    expect(state.recentRuns).toHaveLength(0);
  });

  it("restores the approval when the same plan is approved again after a rejection", () => {
    const state = new PlanModeState("plan");
    state.switchApprovedPlanToAct();
    state.beginApprovedExecutionRun("plan.md");
    state.addTodo("执行第一步");
    // A rejected review returns the run to draft with its list intact.
    state.returnApprovedRunToDraftForEditedArtifact("plan.md");

    state.beginApprovedExecutionRun("plan.md");

    expect(state.todos.map((todo) => todo.text)).toEqual(["执行第一步"]);
    expect(state.activeRun?.status).toBe("executing");
    expect(state.activeRun?.approvedAt).toBeDefined();
    expect(state.recentRuns).toHaveLength(0);
  });
});
