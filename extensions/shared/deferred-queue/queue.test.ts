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
});
