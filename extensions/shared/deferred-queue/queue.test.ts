import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Queue } from "./queue.ts";

function _createTempPersistPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "dq-test-"));
  return join(dir, "queue.json");
}

describe("Queue", () => {
  let persistPath: string;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dq-test-"));
    persistPath = join(dir, "queue.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("registers a task", () => {
    const q = new Queue({ persistPath, checkIntervalMs: 10_000 });
    q.add({
      id: "test-task",
      every: "1h",
      handler: async () => {},
    });
    expect(q.list()).toEqual(["test-task"]);
  });

  it("throws on duplicate task id", () => {
    const q = new Queue({ persistPath, checkIntervalMs: 10_000 });
    q.add({ id: "dup", every: "1h", handler: async () => {} });
    expect(() => {
      q.add({ id: "dup", every: "2h", handler: async () => {} });
    }).toThrow('Task "dup" is already registered');
  });

  it("removes a task", () => {
    const q = new Queue({ persistPath, checkIntervalMs: 10_000 });
    q.add({ id: "t1", every: "1h", handler: async () => {} });
    expect(q.list()).toHaveLength(1);
    expect(q.remove("t1")).toBe(true);
    expect(q.list()).toHaveLength(0);
  });

  it("does not run newly-registered tasks immediately (records lastRunAt)", () => {
    const handler = vi.fn();
    const q = new Queue({ persistPath, checkIntervalMs: 10_000 });
    q.add({ id: "immediate", every: "1h", handler });
    q.start();

    // Stop immediately — if the handler fired, something is wrong
    q.stop();
    expect(handler).not.toHaveBeenCalled();
  });

  it("executes a task when interval has elapsed", async () => {
    const handler = vi.fn();
    const q = new Queue({ persistPath, checkIntervalMs: 50_000 });

    // Pre-seed the persister so lastRunAt is far in the past
    q.add({ id: "old-task", every: "1h", handler });
    // Manually set lastRunAt to far past
    const past = Date.now() - 7_200_000; // 2 hours ago
    q.setTaskLastRunAt("old-task", past);

    await q.runCheck();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not execute a task that hasn't elapsed", async () => {
    const handler = vi.fn();
    const q = new Queue({ persistPath, checkIntervalMs: 50_000 });
    q.add({ id: "recent-task", every: "1h", handler });
    // lastRunAt is set to now by add(), so it hasn't elapsed

    await q.runCheck();
    expect(handler).not.toHaveBeenCalled();
  });

  it("executes multiple tasks when all are due", async () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    const q = new Queue({ persistPath, checkIntervalMs: 50_000 });

    q.add({ id: "a", every: "1h", handler: h1 });
    q.add({ id: "b", every: "2h", handler: h2 });
    q.setTaskLastRunAt("a", Date.now() - 7_200_000);
    q.setTaskLastRunAt("b", Date.now() - 14_400_000);

    const count = await q.runCheck();
    expect(count).toBe(2);
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });

  it("handles handler errors gracefully", async () => {
    const handler = vi.fn().mockRejectedValue(new Error("boom"));
    const onTaskStatus = vi.fn();
    const q = new Queue({
      persistPath,
      checkIntervalMs: 50_000,
      onTaskStatus,
    });

    const past = Date.now() - 7_200_000; // 2 hours ago
    q.add({ id: "err-task", every: "1h", handler });
    q.setTaskLastRunAt("err-task", past);

    // Should not throw
    const count = await q.runCheck();
    expect(count).toBe(1);
    expect(handler).toHaveBeenCalledTimes(1);

    // Verify error state was recorded
    expect(onTaskStatus).toHaveBeenCalledWith("err-task", "running");
    expect(onTaskStatus).toHaveBeenCalledWith("err-task", "failed");
    expect(onTaskStatus).not.toHaveBeenCalledWith("err-task", "completed");

    // Verify lastRunAt was updated so task doesn't re-run immediately
    expect(q.getTaskLastRunAt("err-task")).toBeGreaterThan(past);
  });

  it("start() and stop() control the check loop", () => {
    const q = new Queue({ persistPath, checkIntervalMs: 100 });
    q.start();
    expect(q.isRunning).toBe(true);

    q.stop();
    expect(q.isRunning).toBe(false);
  });

  it("validates duration at add time", () => {
    const q = new Queue({ persistPath });
    expect(() => {
      q.add({ id: "bad", every: "30s" as never, handler: async () => {} });
    }).toThrow("Unsupported duration unit");
  });

  it("provides exec context to handlers", async () => {
    let context: unknown = null;
    const q = new Queue({ persistPath, checkIntervalMs: 50_000 });

    q.add({
      id: "ctx-task",
      every: "1h",
      handler: async (exec) => {
        context = exec;
      },
    });
    q.setTaskLastRunAt("ctx-task", Date.now() - 7_200_000);

    await q.runCheck();
    expect(context).not.toBeNull();
    expect(typeof (context as Record<string, unknown>).exec).toBe("function");
    expect(typeof (context as Record<string, unknown>).subagent).toBe(
      "function",
    );
    expect(typeof (context as Record<string, unknown>).notify).toBe("function");
  });

  // ── runNow ────────────────────────────────────────────────

  it("runNow executes a registered task", async () => {
    const handler = vi.fn();
    const q = new Queue({ persistPath, checkIntervalMs: 10_000 });
    q.add({ id: "manual", every: "1h", handler });

    const result = await q.runNow("manual");

    expect(result).toEqual({ executed: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("runNow returns not-found for unknown task", async () => {
    const q = new Queue({ persistPath, checkIntervalMs: 10_000 });
    const result = await q.runNow("nonexistent");

    expect(result).toEqual({
      executed: false,
      reason: 'task "nonexistent" not found',
    });
  });

  it("runNow does not update lastRunAt", async () => {
    const handler = vi.fn();
    const q = new Queue({ persistPath, checkIntervalMs: 10_000 });
    q.add({ id: "manual", every: "1h", handler });
    const before = q.getTaskLastRunAt("manual");

    await q.runNow("manual");

    // lastRunAt should remain unchanged — out-of-band execution
    expect(q.getTaskLastRunAt("manual")).toBe(before);
  });

  it("runNow records triggeredBy: manual", async () => {
    const handler = vi.fn();
    const q = new Queue({ persistPath, checkIntervalMs: 10_000 });
    q.add({ id: "manual", every: "1h", handler });

    await q.runNow("manual");

    const metas = q.listWithMeta();
    const rec = metas.find((m) => m.id === "manual");
    expect(rec?.triggeredBy).toBe("manual");
  });

  it("runNow allows different tasks to execute concurrently", async () => {
    let finishSlowTask!: () => void;
    const slowTaskStarted = Promise.withResolvers<void>();
    const slowHandler = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSlowTask = resolve;
          slowTaskStarted.resolve();
        }),
    );
    const fastHandler = vi.fn();

    const q1 = new Queue({ persistPath, checkIntervalMs: 10_000 });
    const q2 = new Queue({ persistPath, checkIntervalMs: 10_000 });
    for (const q of [q1, q2]) {
      q.add({ id: "slow", every: "1h", handler: slowHandler });
      q.add({ id: "fast", every: "1h", handler: fastHandler });
    }

    const slowRun = q1.runNow("slow");
    await slowTaskStarted.promise;

    const fastRun = await q2.runNow("fast");

    finishSlowTask();
    await slowRun;

    const persisted = new Queue({ persistPath, checkIntervalMs: 10_000 });
    persisted.add({ id: "slow", every: "1h", handler: async () => {} });
    persisted.add({ id: "fast", every: "1h", handler: async () => {} });

    expect(fastRun).toEqual({ executed: true });
    expect(slowHandler).toHaveBeenCalledTimes(1);
    expect(fastHandler).toHaveBeenCalledTimes(1);
    expect(persisted.listWithMeta()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "slow", triggeredBy: "manual" }),
        expect.objectContaining({ id: "fast", triggeredBy: "manual" }),
      ]),
    );
  });

  it("runNow still rejects a duplicate execution of the same task", async () => {
    let finishTask!: () => void;
    const taskStarted = Promise.withResolvers<void>();
    const handler = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishTask = resolve;
          taskStarted.resolve();
        }),
    );

    const q1 = new Queue({ persistPath, checkIntervalMs: 10_000 });
    const q2 = new Queue({ persistPath, checkIntervalMs: 10_000 });
    q1.add({ id: "same", every: "1h", handler });
    q2.add({ id: "same", every: "1h", handler });

    const firstRun = q1.runNow("same");
    await taskStarted.promise;

    const secondRun = await q2.runNow("same");

    finishTask();
    await firstRun;

    expect(secondRun).toEqual({
      executed: false,
      reason: 'task "same" is currently being executed by another process',
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  // ── listWithMeta ──────────────────────────────────────────

  it("listWithMeta returns task metadata", () => {
    const q = new Queue({ persistPath, checkIntervalMs: 10_000 });
    q.add({
      id: "meta-task",
      every: "1h",
      description: "Test task",
      handler: async () => {},
    });

    const metas = q.listWithMeta();
    expect(metas).toHaveLength(1);
    expect(metas[0]).toMatchObject({
      id: "meta-task",
      every: "1h",
      description: "Test task",
    });
    expect(metas[0].lastRunAt).toBeTypeOf("number");
    expect(metas[0].lastResult).toBe("ok");
  });

  it("listWithMeta returns data for multiple tasks", () => {
    const q = new Queue({ persistPath, checkIntervalMs: 10_000 });
    q.add({ id: "a", every: "30m", description: "A", handler: async () => {} });
    q.add({ id: "b", every: "1h", handler: async () => {} });

    const metas = q.listWithMeta();
    expect(metas).toHaveLength(2);
    expect(metas.find((m) => m.id === "a")?.description).toBe("A");
    expect(metas.find((m) => m.id === "b")?.description).toBeUndefined();
  });

  // ── triggeredBy integration ───────────────────────────────

  it("auto execution records triggeredBy: auto", async () => {
    const handler = vi.fn();
    const q = new Queue({ persistPath, checkIntervalMs: 50_000 });
    q.add({ id: "auto-task", every: "1h", handler });
    q.setTaskLastRunAt("auto-task", Date.now() - 7_200_000);

    await q.runCheck();

    const metas = q.listWithMeta();
    const rec = metas.find((m) => m.id === "auto-task");
    expect(rec?.triggeredBy).toBe("auto");
  });

  it("manual triggeredBy does not overwrite auto lastRunAt", async () => {
    const handler = vi.fn();
    const q = new Queue({ persistPath, checkIntervalMs: 10_000 });
    q.add({ id: "combo", every: "1h", handler });

    // Simulate: auto run happened
    await q.runNow("combo");
    q.setTaskLastRunAt("combo", 1000);
    await q.runNow("combo");

    // lastRunAt should still be 1000 (from setTaskLastRunAt), not updated by runNow
    expect(q.getTaskLastRunAt("combo")).toBe(1000);
  });
});
