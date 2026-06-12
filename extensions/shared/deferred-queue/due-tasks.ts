import { parseDuration } from "./duration.ts";
import type { Duration, TaskDefinition } from "./types.ts";

/**
 * Pure function: determine whether a single interval has elapsed.
 *
 * Pure input: last run timestamp, duration string, current wall clock.
 * Pure output: boolean indicating whether the task is due for execution.
 *
 * No IO, no side effects — fully testable without mocks.
 */
export function isTaskDue(
  lastRunAt: number,
  every: Duration,
  now: number,
): boolean {
  return now - lastRunAt >= parseDuration(every);
}

/**
 * Pure function: determine which task IDs are due for execution.
 *
 * Pure input: task definitions, last-run timestamps, current wall clock.
 * Pure output: array of due task IDs.
 *
 * No IO, no side effects — fully testable without mocks.
 */
export function getDueTaskIds(
  tasks: Map<string, TaskDefinition>,
  lastRunAt: Record<string, number>,
  now: number,
): string[] {
  const due: string[] = [];
  for (const [id, task] of tasks) {
    const lastRun = lastRunAt[id] ?? now;
    if (isTaskDue(lastRun, task.every, now)) {
      due.push(id);
    }
  }
  return due;
}
