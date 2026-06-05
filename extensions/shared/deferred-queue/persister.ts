import fs from "node:fs";
import path from "node:path";
import { log } from "./logger.ts";
import type { PersistenceFile, TaskPersistenceRecord } from "./types.ts";

const CURRENT_VERSION = 1 as const;

/**
 * Reads and writes lastRunAt timestamps for tasks.
 * Persists to a single JSON file at a configurable path.
 */
export class Persister {
  private readonly filePath: string;
  private data: PersistenceFile;
  private dirty = false;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.data = this.readFile();
    log.info("persister loaded", {
      filePath,
      taskCount: Object.keys(this.data.tasks).length,
    });
  }

  /** Get lastRunAt for a task (epoch ms), or null if never run. */
  getLastRunAt(taskId: string): number | null {
    return this.data.tasks[taskId]?.lastRunAt ?? null;
  }

  /** Set lastRunAt and mark as dirty. */
  setLastRunAt(taskId: string, timestamp: number): void {
    const existing = this.data.tasks[taskId];
    this.data.tasks[taskId] = {
      lastRunAt: timestamp,
      lastResult: existing?.lastResult,
    };
    this.dirty = true;
  }

  /** Update the last result status. */
  setLastResult(
    taskId: string,
    result: TaskPersistenceRecord["lastResult"],
  ): void {
    const existing = this.data.tasks[taskId] ?? { lastRunAt: Date.now() };
    this.data.tasks[taskId] = {
      lastRunAt: existing.lastRunAt,
      lastResult: result,
    };
    this.dirty = true;
  }

  /** Flush to disk if dirty. */
  flush(): void {
    if (!this.dirty) return;
    log.debug("persister: flushing to disk", {
      taskCount: Object.keys(this.data.tasks).length,
    });
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(
      this.filePath,
      `${JSON.stringify(this.data, null, 2)}\n`,
      "utf-8",
    );
    this.dirty = false;
  }

  private readFile(): PersistenceFile {
    try {
      if (!fs.existsSync(this.filePath)) {
        log.debug("persister: no existing file, starting fresh");
        return { version: CURRENT_VERSION, tasks: {} };
      }
      const content = fs.readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(content) as PersistenceFile;
      if (parsed.version !== CURRENT_VERSION) {
        log.warn("persister: schema version mismatch, resetting", {
          fileVersion: parsed.version,
          expectedVersion: CURRENT_VERSION,
        });
        return { version: CURRENT_VERSION, tasks: {} };
      }
      log.debug("persister: loaded from file", {
        taskCount: Object.keys(parsed.tasks).length,
      });
      return parsed;
    } catch (err) {
      log.warn("persister: failed to read file, starting fresh", {
        error: err instanceof Error ? err.message : String(err),
      });
      return { version: CURRENT_VERSION, tasks: {} };
    }
  }
}
