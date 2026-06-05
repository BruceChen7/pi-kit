import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Persister } from "./persister.ts";

function withPersister(fn: (p: Persister, path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "dq-test-"));
  const filePath = join(dir, "persist.json");
  try {
    const p = new Persister(filePath);
    fn(p, filePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("Persister", () => {
  it("returns null for unknown tasks", () => {
    withPersister((p) => {
      expect(p.getLastRunAt("nonexistent")).toBeNull();
    });
  });

  it("stores and retrieves lastRunAt", () => {
    withPersister((p) => {
      p.setLastRunAt("task-1", 1000);
      expect(p.getLastRunAt("task-1")).toBe(1000);
    });
  });

  it("overwrites existing lastRunAt", () => {
    withPersister((p) => {
      p.setLastRunAt("task-1", 1000);
      p.setLastRunAt("task-1", 2000);
      expect(p.getLastRunAt("task-1")).toBe(2000);
    });
  });

  it("persists to disk on flush", () => {
    withPersister((p, filePath) => {
      p.setLastRunAt("task-a", 42);
      p.setLastResult("task-a", "ok");
      p.flush();

      expect(existsSync(filePath)).toBe(true);
      const content = readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.tasks["task-a"].lastRunAt).toBe(42);
      expect(parsed.tasks["task-a"].lastResult).toBe("ok");
    });
  });

  it("recovers persisted state on reload", () => {
    const dir = mkdtempSync(join(tmpdir(), "dq-test-"));
    const filePath = join(dir, "persist.json");
    try {
      const p1 = new Persister(filePath);
      p1.setLastRunAt("task-x", 999);
      p1.flush();

      const p2 = new Persister(filePath);
      expect(p2.getLastRunAt("task-x")).toBe(999);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resets on schema version mismatch", () => {
    const dir = mkdtempSync(join(tmpdir(), "dq-test-"));
    const filePath = join(dir, "persist.json");
    try {
      // Write an old-format file
      const oldContent = {
        version: 0,
        tasks: { "old-task": { lastRunAt: 123 } },
      };
      writeFileSync(filePath, JSON.stringify(oldContent), "utf-8");

      const p = new Persister(filePath);
      expect(p.getLastRunAt("old-task")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles missing file gracefully", () => {
    const p = new Persister("/nonexistent/path/queue.json");
    expect(p.getLastRunAt("any")).toBeNull();
  });

  it("sets lastResult", () => {
    withPersister((p, filePath) => {
      p.setLastRunAt("t", 100);
      p.setLastResult("t", "error");
      p.flush();
      const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
      expect(parsed.tasks.t.lastRunAt).toBe(100);
      expect(parsed.tasks.t.lastResult).toBe("error");
    });
  });
});
