import { describe, expect, it } from "vitest";
import { getDueTaskIds } from "./due-tasks.ts";
import type { TaskDefinition } from "./types.ts";

function task(id: string, every: TaskDefinition["every"]): TaskDefinition {
  return { id, every, handler: async () => {} };
}

describe("getDueTaskIds", () => {
  it("returns empty for no tasks", () => {
    const result = getDueTaskIds(new Map(), {}, 1000);
    expect(result).toEqual([]);
  });

  it("returns empty when no task has elapsed", () => {
    const tasks = new Map([["a", task("a", "1h")]]);
    // lastRunAt is right before now — not due
    const result = getDueTaskIds(tasks, { a: 500 }, 1000);
    expect(result).toEqual([]);
  });

  it("returns task when interval has elapsed", () => {
    const tasks = new Map([["a", task("a", "30m")]]);
    // 30m = 1_800_000ms, elapsed = 2_000_000ms → due
    const result = getDueTaskIds(tasks, { a: 0 }, 2_000_000);
    expect(result).toEqual(["a"]);
  });

  it("returns multiple due tasks", () => {
    const tasks = new Map([
      ["a", task("a", "1h")],
      ["b", task("b", "2h")],
      ["c", task("c", "30m")],
    ]);
    // 1h = 3_600_000, 2h = 7_200_000, 30m = 1_800_000
    const result = getDueTaskIds(
      tasks,
      { a: 1_000_000, b: 1_000_000, c: 1_000_000 },
      5_000_000,
    );
    // a: 5M-1M=4M >= 3.6M → due
    // b: 5M-1M=4M < 7.2M → not due
    // c: 5M-1M=4M >= 1.8M → due
    expect(result).toEqual(["a", "c"]);
  });

  it("exactly at boundary is due (elapsed >= interval)", () => {
    const tasks = new Map([["a", task("a", "10m")]]);
    // 10m = 600_000ms, exact boundary
    const result = getDueTaskIds(tasks, { a: 0 }, 600_000);
    expect(result).toEqual(["a"]);
  });

  it("treats unknown task as never-run (lastRunAt=now)", () => {
    const tasks = new Map([["a", task("a", "1h")]]);
    // Task "a" is not in lastRunAt — should use `now` so it's not immediately due
    const result = getDueTaskIds(tasks, {}, 1000);
    expect(result).toEqual([]);
  });

  it("handles different Duration units", () => {
    const tasks = new Map([
      ["m", task("m", "5m")],
      ["h", task("h", "1h")],
      ["d", task("d", "1d")],
    ]);
    const result = getDueTaskIds(tasks, { m: 0, h: 0, d: 0 }, 3_600_000);
    // 5m = 300_000 ≤ 3.6M → due
    // 1h = 3_600_000 ≤ 3.6M → due (boundary)
    // 1d = 86_400_000 > 3.6M → not due
    expect(result).toEqual(["m", "h"]);
  });
});
