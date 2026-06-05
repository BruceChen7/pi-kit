import { getDueTaskIds } from "./due-tasks.ts";
import { parseDuration } from "./duration.ts";
import { FileLock } from "./file-lock.ts";
import { createExecContext } from "./handler-registry.ts";
import { log } from "./logger.ts";
import { Persister } from "./persister.ts";
import type { ExecContext, QueueConfig, TaskDefinition } from "./types.ts";

/**
 * Deferred Queue — a natural-time-interval task scheduler.
 *
 * Tasks are defined programmatically (TypeScript) and scheduled to run
 * based on wall-clock time, independent of Pi session lifecycle.
 *
 * Key design:
 * - Tasks are `every(duration)` only (no cron expressions).
 * - Execution is driven by a periodic check loop (setTimeout, unref'd).
 * - Last-run timestamps are persisted to a JSON file.
 * - Tasks do NOT run on first registration; only on subsequent intervals.
 */
export class Queue {
  private readonly tasks: Map<string, TaskDefinition> = new Map();
  private readonly config: QueueConfig;
  private readonly persister: Persister;
  private readonly checkIntervalMs: number;
  private readonly execContext: ExecContext;
  private readonly fileLock: FileLock;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(config: QueueConfig) {
    this.config = config;
    this.persister = new Persister(config.persistPath);
    this.checkIntervalMs = config.checkIntervalMs ?? 60_000;
    this.execContext = createExecContext();
    this.fileLock = new FileLock(config.persistPath);
    log.info("queue created", {
      persistPath: config.persistPath,
      checkIntervalMs: this.checkIntervalMs,
    });
  }

  /**
   * Register a task into the queue.
   * If the task has never run, set lastRunAt to now (do NOT run immediately).
   */
  add(task: TaskDefinition): void {
    if (this.tasks.has(task.id)) {
      throw new Error(`Task "${task.id}" is already registered.`);
    }

    parseDuration(task.every);
    this.tasks.set(task.id, task);
    log.info("task registered", { id: task.id, every: task.every });

    // First registration: record current time as lastRunAt so it won't fire immediately
    const lastRunAt = this.persister.getLastRunAt(task.id);
    if (lastRunAt === null) {
      const now = Date.now();
      this.persister.setLastRunAt(task.id, now);
      this.persister.setLastResult(task.id, "ok");
      this.persister.flush();
      log.info("task first registration — recording lastRunAt", {
        id: task.id,
        lastRunAt: new Date(now).toISOString(),
      });
    } else {
      log.info("task re-registered from persisted state", {
        id: task.id,
        lastRunAt: new Date(lastRunAt).toISOString(),
      });
    }
  }

  /**
   * Remove a registered task.
   */
  remove(taskId: string): boolean {
    const removed = this.tasks.delete(taskId);
    log.info("task removed", { id: taskId, removed });
    return removed;
  }

  /**
   * Set the last run time for a task (persisted immediately).
   * Public for external seeding (tests, admin commands).
   */
  setTaskLastRunAt(taskId: string, timestamp: number): void {
    this.persister.setLastRunAt(taskId, timestamp);
    this.persister.flush();
  }

  /**
   * Get the last run time for a task, or null if never run.
   */
  getTaskLastRunAt(taskId: string): number | null {
    return this.persister.getLastRunAt(taskId);
  }

  /**
   * Whether the queue check loop is active.
   */
  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Get the list of registered task IDs.
   */
  list(): string[] {
    return Array.from(this.tasks.keys());
  }

  /**
   * Start the check loop.
   * Does nothing if already running.
   */
  start(): void {
    if (this.running) {
      log.debug("queue already running, skipping start");
      return;
    }
    this.running = true;
    log.info("queue started", { registeredTasks: this.tasks.size });
    this.scheduleNext();
  }

  /**
   * Stop the check loop.
   */
  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.persister.flush();
    log.info("queue stopped");
  }

  /**
   * Run one check cycle: iterate all tasks, execute due ones.
   * Returns the number of tasks that were executed.
   */
  async runCheck(): Promise<number> {
    const now = Date.now();

    log.debug("runCheck cycle started", { taskCount: this.tasks.size });

    // ── 1. IO: read persisted last-run state ──────────────────
    const lastRunAt: Record<string, number> = {};
    for (const [id] of this.tasks) {
      lastRunAt[id] = this.persister.getLastRunAt(id) ?? now;
    }

    // ── 2. Pure: decide which tasks are due ────────────────────
    const dueIds = getDueTaskIds(this.tasks, lastRunAt, now);
    let executed = 0;

    if (dueIds.length > 0) {
      log.debug("tasks due for execution", { dueIds, count: dueIds.length });
    }

    // ── 3. Shell: execute each due task ────────────────────────
    for (const id of dueIds) {
      const task = this.tasks.get(id);
      if (!task) {
        log.warn("task definition not found, skipping", { id });
        continue;
      }

      // Try to acquire exclusive lock to prevent duplicate execution
      // across multiple Pi processes
      if (!this.fileLock.tryLock()) {
        log.debug("task skipped — lock held by another process", { id });
        continue;
      }

      try {
        executed++;
        this.persister.setLastRunAt(id, now);
        this.persister.flush();
        log.info("task executing", { id });
        this.config.onTaskStatus?.(id, "running");

        try {
          await task.handler(this.execContext);
          this.persister.setLastResult(id, "ok");
          log.info("task completed successfully", { id });
          this.config.onTaskStatus?.(id, "completed");
        } catch (_error) {
          this.persister.setLastResult(id, "error");
          log.warn("task failed", {
            id,
            error: _error instanceof Error ? _error.message : String(_error),
          });
          this.config.onTaskStatus?.(id, "failed");
        } finally {
          this.persister.flush();
        }
      } finally {
        this.fileLock.unlock();
      }
    }

    log.debug("runCheck cycle finished", { executed, total: this.tasks.size });
    return executed;
  }

  /**
   * Schedule the next check cycle.
   */
  private scheduleNext(): void {
    if (!this.running) return;

    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.running) return;

      void this.runCheck().finally(() => {
        this.scheduleNext();
      });
    }, this.checkIntervalMs);

    if (this.timer && typeof this.timer === "object" && "unref" in this.timer) {
      this.timer.unref();
    }
  }
}

/**
 * Create and start a Queue with the given config.
 * Convenience factory for use in extension entry points.
 */
export function createQueue(config: QueueConfig): Queue {
  const queue = new Queue(config);
  queue.start();
  return queue;
}
