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
  /** True when output exceeded the collection cap and was dropped. */
  truncated?: boolean;
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
  /**
   * Optional list of prompt template paths to load via --prompt-template.
   * Pi's native mechanism for loading reusable prompt instructions.
   */
  promptTemplatePaths?: string[];
  /**
   * Explicit model pattern passed via `--models` (e.g. "opencode-go/deepseek-v4-flash").
   *
   * When set, pi resolves this pattern instead of the global `enabledModels`
   * from settings. That avoids "No models match pattern" warnings for
   * enabled models whose provider extension is not loaded in the subagent
   * (it runs with `--no-extensions`), and pins the subagent to a known
   * working model.
   */
  model?: string;
  /**
   * Pi output mode for the subagent process.
   *
   * - `json` (default): newline-delimited session event stream (thinking
   *   deltas, tool I/O, messages). Structured, but verbose — long-running
   *   tool-heavy tasks can exceed the stdout cap in under a minute.
   * - `text`: stdout carries only the final reply text. Orders of magnitude
   *   smaller; `summary` is the trimmed stdout itself. Tool output and
   *   thinking are not surfaced.
   *
   * Prefer `text` for long-running tasks (e.g. wiki-summarize batches);
   * keep `json` where callers rely on the event stream.
   */
  outputMode?: "json" | "text";
  /**
   * Optional stdout collection cap in characters for this call.
   * Defaults to MAX_SUBAGENT_STDOUT_CHARS (16MB).
   *
   * Escape hatch: currently no caller sets it — the wiki task switched to
   * text mode, whose stdout is KB-scale. It exists for future long-running
   * `json`-mode tasks, which can still emit 20+ MB event streams in 10
   * minutes. Remove if unused for a long stretch.
   */
  maxStdoutChars?: number;
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
  /** True when output exceeded the collection cap and was dropped. */
  truncated?: boolean;
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
