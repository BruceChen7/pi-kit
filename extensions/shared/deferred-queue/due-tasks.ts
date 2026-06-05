import { parseDuration } from "./duration.ts";
import type { TaskDefinition } from "./types.ts";

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
    if (now - lastRun >= parseDuration(task.every)) {
      due.push(id);
    }
  }
  return due;
}
