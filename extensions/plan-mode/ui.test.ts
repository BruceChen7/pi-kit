import { describe, expect, it } from "vitest";
import { PlanModeState } from "./state.js";
import { formatPlanModeStatusLine } from "./ui.js";

/**
 * `formatPlanModeStatusLine` 是 pi-web 常驻状态行的唯一来源（纯函数）。
 * 这里钉住三条边界：普通 act 会话不发、plan 阶段发模式、执行阶段带当前步骤与计数。
 */
describe("formatPlanModeStatusLine", () => {
  it("stays silent for a plain act session", () => {
    const state = new PlanModeState("act");
    expect(formatPlanModeStatusLine(state)).toBeUndefined();
  });

  it("announces the plan mode before any todo exists", () => {
    const state = new PlanModeState("plan");
    expect(formatPlanModeStatusLine(state)).toBe("Plan Mode: Plan · Planning");
  });

  it("carries the current step and the counts while executing", () => {
    const state = new PlanModeState("act");
    state.replaceTodos([
      { text: "实现状态机", status: "in_progress" },
      { text: "补充 README", status: "todo" },
      { text: "补测试", status: "todo" },
      { text: "提交", status: "todo" },
    ]);

    expect(formatPlanModeStatusLine(state)).toBe(
      "Plan Mode: Act · #1/4 实现状态机 · 0/4 已完成",
    );
  });

  it("reports a finished list without a current step", () => {
    const state = new PlanModeState("act");
    state.replaceTodos([
      { text: "编写测试", status: "done" },
      { text: "实现改动", status: "done" },
    ]);

    expect(formatPlanModeStatusLine(state)).toBe(
      "Plan Mode: Act · Completed · 2/2 已完成",
    );
  });

  it("keeps the mode and the run status apart when they differ", () => {
    const state = new PlanModeState("plan");
    state.replaceTodos([{ text: "等待评审", status: "in_progress" }]);

    expect(formatPlanModeStatusLine(state)).toBe(
      "Plan Mode: Plan · Waiting for review · #1/1 等待评审 · 0/1 已完成",
    );
  });
});
