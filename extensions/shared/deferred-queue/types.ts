import type { SpawnOptions } from "node:child_process";

/**
 * Human-readable duration string.
 * Supported formats: 30m, 2h, 7d
 */
export type Duration = `${number}m` | `${number}h` | `${number}d`;

/**
 * Result of a CLI command execution (exec).
 */
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Options for spawning an isolated Pi subagent.
 */
export interface SubagentOptions {
  /** The prompt / instruction for the subagent. */
  prompt: string;
  /**
   * Optional list of extension paths to load in the subagent.
   * If empty, the subagent runs with minimal extensions (--no-extensions).
   */
  extensionPaths?: string[];
  /** Optional spawn options override. */
  spawnOptions?: Partial<SpawnOptions>;
  /** Timeout in ms (default: 30_000). */
  timeoutMs?: number;
}

/**
 * Result of a subagent execution.
 */
export interface SubagentResult {
  /** The final output text from the subagent. */
  stdout: string;
  /** Any stderr output. */
  stderr: string;
  /** Exit code of the subagent process. */
  exitCode: number;
  /** Optional structured summary (extracted from JSON output). */
  summary?: string;
}

/**
 * Execution context injected into every task handler.
 *
 * Methods:
 * - `exec()` — run a CLI command directly via execFile (lightweight, no Pi dependency)
 * - `subagent()` — run a task in an isolated Pi subprocess (librarian-style)
 * - `notify()` — send a desktop notification
 */
export interface ExecContext {
  /** Execute a CLI command directly (execFile). */
  exec: (command: string, args?: string[]) => Promise<ExecResult>;
  /** Execute in an isolated Pi subagent (spawns a separate Pi process). */
  subagent: (options: SubagentOptions) => Promise<SubagentResult>;
  /** Send a desktop notification. */
  notify: (title: string, body: string) => void;
}

/**
 * A task definition written by plugin authors.
 * Each file under `tasks/` should default-export one of these.
 */
export interface TaskDefinition {
  /** Unique task identifier. */
  id: string;
  /** How often to run (natural time interval). */
  every: Duration;
  /** The async handler called when the task is due. */
  handler: (ctx: ExecContext) => Promise<void>;
  /** Optional human-readable description. */
  description?: string;
}

/**
 * Task execution status reported to the host.
 */
export type TaskStatus = "running" | "completed" | "failed";

/**
 * Queue engine configuration.
 */
export interface QueueConfig {
  /** Absolute path to the persistence JSON file. */
  persistPath: string;
  /** Absolute path to the tasks directory (for auto-discovery in extensions). */
  tasksDir?: string;
  /** Check interval in ms (default: 60_000 = 1 minute). */
  checkIntervalMs?: number;
  /** Called when a task's execution status changes. */
  onTaskStatus?: (taskId: string, status: TaskStatus) => void;
}

/**
 * Persistence record stored per task.
 */
export interface TaskPersistenceRecord {
  lastRunAt: number;
  lastResult?: "ok" | "error";
  triggeredBy?: "auto" | "manual";
}

/**
 * Full persistence file shape.
 */
export interface PersistenceFile {
  version: 1;
  tasks: Record<string, TaskPersistenceRecord>;
}
