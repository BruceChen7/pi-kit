import type { TaskDefinition } from "./types.ts";

/**
 * Define a deferred task with full type safety.
 *
 * Usage:
 * ```ts
 * export default defineTask({
 *   id: "my-task",
 *   every: "24h",
 *   handler: async (exec) => { ... },
 * });
 * ```
 */
export function defineTask(def: TaskDefinition): TaskDefinition {
  return def;
}
