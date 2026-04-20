import { describe, expect, it } from "vitest";

import { WorktreeLockManager } from "./lock-manager.js";

describe("WorktreeLockManager", () => {
  it("serializes tasks for the same worktree key", async () => {
    const manager = new WorktreeLockManager();
    const order: string[] = [];

    let releaseFirst: (() => void) | null = null;
    const first = manager.run("wt-a", async () => {
      order.push("first-start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push("first-end");
      return "first";
    });

    const second = manager.run("wt-a", async () => {
      order.push("second-start");
      order.push("second-end");
      return "second";
    });

    await Promise.resolve();
    expect(order).toEqual(["first-start"]);

    releaseFirst?.();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toBe("first");
    expect(secondResult).toBe("second");
    expect(order).toEqual([
      "first-start",
      "first-end",
      "second-start",
      "second-end",
    ]);
  });

  it("runs different worktree keys in parallel", async () => {
    const manager = new WorktreeLockManager();
    const order: string[] = [];

    let releaseFirst: (() => void) | null = null;
    const first = manager.run("wt-a", async () => {
      order.push("a-start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push("a-end");
      return "a";
    });

    const second = manager.run("wt-b", async () => {
      order.push("b-start");
      order.push("b-end");
      return "b";
    });

    const secondResult = await second;
    expect(secondResult).toBe("b");
    expect(order).toEqual(["a-start", "b-start", "b-end"]);

    releaseFirst?.();
    const firstResult = await first;
    expect(firstResult).toBe("a");
    expect(order).toEqual(["a-start", "b-start", "b-end", "a-end"]);
  });
});
