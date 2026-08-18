/**
 * knowledge-wiki-daily.ts — Daily knowledge base maintenance task.
 *
 * Pipeline:
 *   Step 0:   split-daily-shards — move DailyNotes entries into Wiki/index-<year>.md (idempotent)
 *   Pre-step: run wiki-summary list-stale to get file list
 *   Step 1-3: Pi subagent with --prompt-template prompts/wiki-summarize.md
 *             - Phase 1: list-stale (from prompt)
 *             - Phase 2: AI summary generation
 *             - Phase 3: concept linking + auto-create concept files
 *             - Phase 4: verify
 *   Step 4:   qmd update (full-text reindex)
 *   Step 5:   qmd embed (vector embeddings)
 *
 * Knowledge base root: ~/work/notes
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineTask } from "../../shared/deferred-queue/define-task.ts";
import { log } from "../../shared/deferred-queue/logger.ts";
import type {
  SubagentOptions,
  SubagentResult,
} from "../../shared/deferred-queue/types.ts";
import { escapeHtml, sendTelegramNotification } from "../../shared/telegram.ts";

// ── Paths ──────────────────────────────────────────────────────────────────

const TASK_DIR = realpathSync(dirname(fileURLToPath(import.meta.url)));
const PI_KIT_DIR = resolve(TASK_DIR, "..", "..", "..");
const HOME = homedir();
const KNOWLEDGE_DIR = join(HOME, "work", "notes");

const SUMMARY_SCRIPT = join(
  PI_KIT_DIR,
  "skills",
  "knowledge-wiki",
  "summary",
  "wiki-summary.mjs",
);
const CONCEPT_SCRIPT = join(
  PI_KIT_DIR,
  "skills",
  "knowledge-wiki",
  "concept",
  "wiki-concept.mjs",
);

const INDEX_SCRIPT = join(
  PI_KIT_DIR,
  "skills",
  "knowledge-wiki",
  "state",
  "wiki-index.mjs",
);

const PROMPT_TEMPLATE_PATH = join(PI_KIT_DIR, "prompts", "wiki-summarize.md");

/**
 * Model pattern for the wiki-summarize subagent.
 *
 * Passed explicitly via `--models`. The subagent runs with
 * `--no-extensions`, so the cc-switch-gateway provider is not registered
 * there — without an explicit pattern, pi resolves the global
 * `enabledModels` from settings and emits "No models match pattern"
 * warnings for every cc-switch-gateway entry, then silently falls back.
 * Pin the subagent to the same opencode-go model the main session uses.
 */
const SUBAGENT_MODEL = "opencode-go/deepseek-v4-flash";

/**
 * Subagent output mode.
 *
 * `text` keeps stdout to just the final reply (KB scale). The default
 * `json` mode emits the full session event stream (thinking deltas, tool
 * I/O) — a 10-minute wiki batch produced ~25MB and got SIGTERMed by the
 * stdout cap. Text mode removes that failure mode entirely.
 */
const SUBAGENT_OUTPUT_MODE = "text" as const;

const QMD_EMBED_MODEL =
  "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf";

/**
 * Maximum number of stale files to process in a single subagent call.
 * Smaller batches reduce per-subagent context window pressure,
 * preventing the agent from exhausting its token budget on large workloads.
 * Higher values improve throughput but risk context exhaustion.
 */
const BATCH_SIZE = 3;

/**
 * Maximum number of subagent batches to run concurrently.
 * Each batch spawns its own isolated Pi process; this cap prevents
 * overwhelming the machine / model with too many parallel agents.
 */
const MAX_CONCURRENT_BATCHES = 3;

/**
 * Per-batch subagent timeout (10 minutes).
 * Batches run concurrently (up to MAX_CONCURRENT_BATCHES), so this bounds the
 * worst-case wall-clock time to roughly
 * ceil(batchCount / MAX_CONCURRENT_BATCHES) × 10 min.
 */
const SUBAGENT_TIMEOUT_MS = 600_000;

export interface StageTiming {
  label: string;
  startedAt: number;
  durationMs: number;
  ok: boolean;
}

interface TimedStageResult<T> {
  value: T;
  timing: StageTiming;
}

export function formatStageStartTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, durationMs) / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds.toString().padStart(2, "0")}s`;
}

async function runTimedStage<T>(
  label: string,
  action: () => Promise<T>,
): Promise<TimedStageResult<T>> {
  const startedAt = Date.now();
  const value = await action();
  return {
    value,
    timing: { label, startedAt, durationMs: Date.now() - startedAt, ok: true },
  };
}

// ── Subagent prompt builder ───────────────────────────────────────────────

/**
 * Maximum number of stale files to list individually in the prompt.
 * Beyond this, use a count summary to keep prompt length manageable.
 */
const STALE_FILES_PROMPT_LIMIT = 20;

/**
 * Build the subagent user message (context only).
 *
 * The template itself is loaded by Pi's native --prompt-template mechanism.
 * This message provides the runtime configuration (KB path, script paths, stale file list)
 * that the agent uses to replace <cwd>, <path-to-wiki-summary.mjs>, etc.
 *
 * @param staleFiles - List of stale file paths (relative to knowledge base root)
 *                     from the pre-step `list-stale` scan.
 */
export function buildSubagentPrompt(staleFiles: string[]): string {
  const fileList: string[] = [];

  if (staleFiles.length === 0) {
    fileList.push("No stale files found — nothing to update.");
  } else if (staleFiles.length <= STALE_FILES_PROMPT_LIMIT) {
    fileList.push(...staleFiles.map((f) => `  - ${f}`));
  } else {
    fileList.push(
      `  (${staleFiles.length} stale files — listing first ${STALE_FILES_PROMPT_LIMIT})`,
    );
    for (const f of staleFiles.slice(0, STALE_FILES_PROMPT_LIMIT)) {
      fileList.push(`  - ${f}`);
    }
  }

  return [
    `## Task Configuration`,
    "",
    `Knowledge base root: ${KNOWLEDGE_DIR}`,
    `wiki-summary.mjs path: ${SUMMARY_SCRIPT}`,
    `wiki-concept.mjs path: ${CONCEPT_SCRIPT}`,
    `wiki-index.mjs path: ${INDEX_SCRIPT}`,
    "",
    "Replace `<cwd>` with the knowledge base root above for all `--base-path` arguments.",
    "Replace `<path-to-wiki-summary.mjs>` with the absolute path above when running node commands.",
    "Replace `<path-to-wiki-concept.mjs>` with the absolute path above when running node commands.",
    "Replace `<path-to-wiki-index.mjs>` with the absolute path above when running node commands.",
    "",
    `## Stale Files (${staleFiles.length} total)`,
    "",
    ...fileList,
    "",
    "Proceed through all 4 phases (list-stale → generate summaries → link concepts → verify).",
    "",
    "When complete, output a JSON summary line matching this format:",
    `{"ok": true, "done": "Phase 1: N stale files. Phase 2: N summaries created. Phase 3: N concepts linked.", "summaries": ["Wiki/Summaries/.../file.summary.md", "..."]}`,
    `On failure: {"ok": false, "done": "Phase X failed: <reason>"}`,
    `Include the "summaries" field with the actual relative paths of all summary files created/updated.`,
    "",
    "Begin.",
  ].join("\n");
}

// ── Pure: parse subagent result JSON ──────────────────────────────────────

/**
 * Extract a JSON result block from the subagent's final summary text.
 *
 * The prompt instructs the agent to end with:
 *   { "ok": bool, "done": "..." }
 *
 * Uses balanced brace matching to handle nested JSON if present.
 */
export function parseResultJson(
  summary: string | undefined,
): BatchResult | null {
  if (!summary) return null;

  for (let i = 0; i < summary.length; i++) {
    if (summary[i] !== "{") continue;

    let depth = 0;
    let inString = false;
    let isEscape = false;
    let j = i;

    for (; j < summary.length; j++) {
      const ch = summary[j];
      if (isEscape) {
        isEscape = false;
        continue;
      }
      if (ch === "\\" && inString) {
        isEscape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === "{") depth++;
      if (ch === "}") {
        depth--;
        if (depth === 0) break;
      }
    }

    if (depth !== 0) continue;

    try {
      const parsed = JSON.parse(summary.slice(i, j + 1));
      if (typeof parsed.ok === "boolean") {
        return {
          ok: parsed.ok,
          done: parsed.done,
          summaries: Array.isArray(parsed.summaries)
            ? parsed.summaries
            : undefined,
        };
      }
    } catch {
      // Not valid JSON, try next {
    }
  }

  return null;
}

// ── Stale file listing ────────────────────────────────────────────────────

/**
 * Run `wiki-summary.mjs list-stale` to get the list of stale source files.
 *
 * Returns an array of relative paths (e.g. `["Notes/Foo.md", "Notes/Bar.md"]`).
 * On failure, returns an empty array and logs the error.
 */
async function listStaleFiles(exec: {
  exec: (
    cmd: string,
    args?: string[],
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
}): Promise<string[]> {
  try {
    const result = await exec.exec("node", [
      SUMMARY_SCRIPT,
      "list-stale",
      "--base-path",
      KNOWLEDGE_DIR,
    ]);

    if (result.code !== 0) {
      log.warn("list-stale failed", {
        exitCode: result.code,
        stderr: result.stderr.slice(0, 500),
      });
      return [];
    }

    const parsed = JSON.parse(result.stdout) as { sources?: string[] };
    if (!Array.isArray(parsed?.sources)) {
      log.warn("list-stale returned unexpected format", {
        stdout: result.stdout.slice(0, 500),
      });
      return [];
    }

    return parsed.sources;
  } catch (err) {
    log.warn("list-stale threw", {
      error: errorMessage(err),
    });
    return [];
  }
}

// ── Telegram message builders ─────────────────────────────────────────────

/**
 * Build a Telegram-safe HTML message for the final success notification.
 *
 * Uses the subagent's `summaries` as the authoritative data source for
 * created/updated summary files. The pre-step `staleFiles` is shown as
 * supplementary context when available.
 *
 * @param staleFiles - Source files that were stale (from pre-step list-stale;
 *                     may be empty if pre-step failed).
 * @param summaries - Summary files actually created/updated (from subagent
 *                    output; authoritative when present).
 * @param wikiSummary - Human-readable summary string from subagent.
 * @param qmdUpdateOk - Whether qmd update succeeded.
 * @param qmdEmbedOk - Whether qmd embed succeeded.
 */
export function buildTelegramSuccessMessage(
  staleFiles: string[],
  summaries: string[] | undefined,
  wikiSummary: string,
  qmdUpdateOk: boolean,
  qmdEmbedOk: boolean,
  timings: StageTiming[] = [],
): string {
  const lines: string[] = ["✅ 知识库维护完成", ""];
  const maxFiles = 10;

  if (timings.length > 0) {
    lines.push("<b>⏱️ 执行摘要</b>");
    for (const [index, stage] of timings.entries()) {
      lines.push(
        `${index + 1}. <b>${escapeHtml(stage.label)}</b> · ${
          stage.ok ? "✓" : "✗"
        }`,
      );
      lines.push(
        `   开始：<code>${formatStageStartTime(stage.startedAt)}</code> · 耗时：<code>${formatDuration(stage.durationMs)}</code>`,
      );
    }
    lines.push("");
  }

  // ── Section: created summary files (authoritative, from subagent) ────
  if (summaries && summaries.length > 0) {
    lines.push(`<b>📄 已创建 / 更新（${summaries.length} 个 summary）</b>`);
    const displayed = summaries.slice(0, maxFiles);
    for (const s of displayed) {
      lines.push(`  <code>${escapeHtml(s)}</code>`);
    }
    if (summaries.length > maxFiles) {
      lines.push(`  <code>... 还有 ${summaries.length - maxFiles} 个</code>`);
    }
    lines.push("");
  }

  // ── Section: stale source files (supplementary, from pre-step) ───────
  if (staleFiles.length > 0) {
    lines.push(`<b>📄 源文件（${staleFiles.length} 个 stale 文件）</b>`);
    const displayed = staleFiles.slice(0, maxFiles);
    for (const f of displayed) {
      lines.push(`  <code>${escapeHtml(f)}</code>`);
    }
    if (staleFiles.length > maxFiles) {
      lines.push(`  <code>... 还有 ${staleFiles.length - maxFiles} 个</code>`);
    }
    lines.push("");
  }

  if (wikiSummary.trim()) {
    lines.push("<b>📝 wiki-summarize</b>");
    const batchSummaries = wikiSummary
      .split(" | ")
      .map((summary) => summary.trim())
      .filter(Boolean);
    for (const summary of batchSummaries) {
      lines.push(`  • ${escapeHtml(summary)}`);
    }
  }
  lines.push(`🔍 qmd update：${qmdUpdateOk ? "✓" : "✗"}`);
  lines.push(`🧠 qmd embed：${qmdEmbedOk ? "✓" : "✗"}`);

  return lines.join("\n");
}

/**
 * Build a Telegram-safe HTML message for failure notifications.
 */
function buildTelegramFailureMessage(
  step: string,
  error: string,
  extra?: { exitCode?: number; stderr?: string },
): string {
  const lines: string[] = [
    `❌ 知识库维护失败 — ${step}`,
    "",
    `错误：${escapeHtml(error)}`,
  ];

  if (extra?.exitCode !== undefined) {
    lines.push(`exitCode：${extra.exitCode}`);
  }
  if (extra?.stderr) {
    const snippet = extra.stderr.slice(0, 500);
    lines.push(`stderr：${escapeHtml(snippet)}`);
  }

  return lines.join("\n");
}

// ── Batch subagent processing ────────────────────────────────────────────

/**
 * Structured result from a subagent batch / parseResultJson.
 */
export interface BatchResult {
  ok: boolean;
  done?: string;
  summaries?: string[];
}

/**
 * Pure: normalize an unknown thrown value into a human-readable message.
 */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Pure: convert a thrown error into a failed batch result.
 */
function toBatchFailure(err: unknown): BatchResult {
  return { ok: false, done: errorMessage(err) };
}

/**
 * Pure: split an array into fixed-size batches.
 *
 * Pure — no side effects, no IO. Easy to test with table tests.
 *
 * @param items - Array of items to split
 * @param batchSize - Maximum size of each batch
 * @returns Array of batches
 */
function partitionIntoBatches<T>(items: T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    batches.push(items.slice(i, i + batchSize));
  }
  return batches;
}

/**
 * Pure: aggregate per-batch results into the pipeline outcome.
 *
 * Pure — no side effects, no IO. Failures are collected separately so the
 * shell can decide how to surface them (logs, notifications) without the
 * aggregation logic being entangled with side effects.
 *
 * @param results - Batch results in batch order
 * @returns Aggregated outcome: created/updated summaries, done text, failures
 */
export interface PipelineAggregation {
  createdSummaries: string[];
  wikiSummaryDone: string;
  failed: Array<{ batch: number; error: string }>;
}

/** @internal Exported for testing only. */
export function aggregateBatchResults(
  results: BatchResult[],
): PipelineAggregation {
  const createdSummaries: string[] = [];
  const failed: Array<{ batch: number; error: string }> = [];
  let wikiSummaryDone = "";

  for (let i = 0; i < results.length; i++) {
    const result = results[i];

    if (!result.ok) {
      failed.push({ batch: i + 1, error: result.done ?? "unknown error" });
      continue;
    }

    if (result.summaries) {
      createdSummaries.push(...result.summaries);
    }
    if (result.done) {
      if (wikiSummaryDone) wikiSummaryDone += " | ";
      wikiSummaryDone += `Batch ${i + 1}: ${result.done}`;
    }
  }

  return { createdSummaries, wikiSummaryDone, failed };
}

/**
 * Run batch jobs with bounded concurrency, collecting results in input order
 * regardless of completion order.
 *
 * Fixed-size worker pool over a shared index cursor. Results are written at
 * `results[index]`, so the final array is always in input order even when
 * workers finish out of order.
 *
 * A job rejection degrades to a failed result (`{ ok: false, done }`) instead
 * of rejecting the whole pool — partially collected results are never lost.
 * Use `onRejected` for shell-side observability (e.g. logging) of throws.
 *
 * @param batches - Batches to process (each a stale-file list)
 * @param concurrency - Max number of jobs running at once
 * @param job - Async job; receives the batch and its index
 * @param onRejected - Optional shell hook fired when a job throws
 * @returns Results in input (batch) order
 */
async function runBatchesConcurrently(
  batches: string[][],
  concurrency: number,
  job: (batch: string[], index: number) => Promise<BatchResult>,
  onRejected?: (error: unknown, index: number) => void,
): Promise<BatchResult[]> {
  const results: BatchResult[] = new Array(batches.length);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= batches.length) break;
      results[index] = await job(batches[index], index).catch((err) => {
        onRejected?.(err, index);
        return toBatchFailure(err);
      });
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, batches.length) }, worker),
  );
  return results;
}

/**
 * Pure: interpret a subagent result into a batch outcome.
 *
 * Value in / value out — no IO. The shell (`processBatch`) only needs to
 * call the subagent, log, and return this function's output.
 *
 * Failure rules:
 * - Non-zero exit code, or the agent reporting `ok: false`, fails the batch.
 * - The agent's `done` text is authoritative; without it, stderr (truncated
 *   to 500 chars) is used as the failure reason.
 *
 * @param result - Raw subagent result (exit code, stderr, extracted summary)
 * @returns The batch outcome for aggregation
 */
/** @internal Exported for testing only. */
export function interpretBatchResult(result: {
  exitCode: number;
  stderr: string;
  summary?: string;
}): BatchResult {
  const parsed = parseResultJson(result.summary);

  if (result.exitCode !== 0 || parsed?.ok === false) {
    const stderrSnippet = result.stderr.slice(0, 500);
    return {
      ok: false,
      // `||` not `??`: an empty stderr snippet must still fall through to
      // the "unknown error" default ("" is not nullish).
      done: parsed?.done ?? (stderrSnippet || "unknown error"),
    };
  }

  return {
    ok: true,
    done: parsed?.done,
    summaries: parsed?.summaries,
  };
}

/**
 * Process a batch of stale files through a single Pi subagent call.
 *
 * Builds a scoped prompt for the batch, runs the wiki-summarize pipeline
 * (Phase 1-4), and returns the parsed result.
 *
 * The subagent has a 10-minute timeout (SUBAGENT_TIMEOUT_MS) and the prompt
 * template loaded via --prompt-template. Each batch is independent — the
 * subagent does not know about other batches.
 */
async function processBatch(
  exec: { subagent: (opts: SubagentOptions) => Promise<SubagentResult> },
  batch: string[],
  batchIndex: number,
  totalBatches: number,
): Promise<BatchResult> {
  const prompt = buildSubagentPrompt(batch);
  log.info("subagent batch starting", {
    templatePath: PROMPT_TEMPLATE_PATH,
    promptLength: prompt.length,
    batch: `${batchIndex + 1}/${totalBatches}`,
    staleFileCount: batch.length,
  });

  const result = await exec.subagent({
    prompt,
    promptTemplatePaths: [PROMPT_TEMPLATE_PATH],
    // Explicit model: resolves against opencode-go instead of the global
    // enabledModels (which reference cc-switch-gateway models unavailable
    // under --no-extensions) — no warnings, no silent fallback surprises.
    model: SUBAGENT_MODEL,
    // text mode: stdout stays at final-reply scale (KB), so long batches
    // can no longer hit the stdout cap and get SIGTERMed.
    outputMode: SUBAGENT_OUTPUT_MODE,
    timeoutMs: SUBAGENT_TIMEOUT_MS,
  });

  log.info("subagent batch completed", {
    exitCode: result.exitCode,
    batch: `${batchIndex + 1}/${totalBatches}`,
  });

  return interpretBatchResult(result);
}

// ── Shell: run a qmd CLI step with error handling ────────────────────────

/**
 * Run a qmd CLI command, handling failures with logging and Telegram notification.
 *
 * Pure IO shell — no decision logic. Returns true on success, false on failure.
 * The caller is responsible for returning early on failure.
 *
 * @param exec - Task exec API
 * @param stepNumber - Step number for logging (e.g. "4")
 * @param label - Human-readable step name (e.g. "qmd update")
 * @param args - CLI arguments for the qmd command
 * @param envOverrides - Optional environment variables to set before running
 */
/** @internal Exported for testing only. */
export async function runQmdStep(
  exec: {
    exec: (
      cmd: string,
      args?: string[],
    ) => Promise<{ code: number; stdout: string; stderr: string }>;
  },
  stepNumber: string,
  label: string,
  args: string[],
  envOverrides?: Record<string, string>,
): Promise<boolean> {
  // Save and override env vars if specified
  const savedEnv: Record<string, string | undefined> = {};
  if (envOverrides) {
    for (const key of Object.keys(envOverrides)) {
      savedEnv[key] = process.env[key];
      process.env[key] = envOverrides[key];
    }
  }

  log.info(`Step ${stepNumber}: ${label}`);
  try {
    const { code } = await exec.exec("qmd", args);
    if (code !== 0) {
      log.warn(`${label} failed`, { exitCode: code });

      await sendTelegramNotification(
        buildTelegramFailureMessage(
          `Step ${stepNumber} (${label})`,
          `${label} 返回非零退出码`,
          { exitCode: code },
        ),
      ).catch((e) => log.warn("telegram notify failed", { error: String(e) }));
      return false;
    }
    log.info(`${label} completed`);
    return true;
  } catch (err) {
    const errorMsg = errorMessage(err);
    log.warn(`${label} threw`, { error: errorMsg });

    await sendTelegramNotification(
      buildTelegramFailureMessage(`Step ${stepNumber} (${label})`, errorMsg),
    ).catch((e) => log.warn("telegram notify failed", { error: String(e) }));
    return false;
  } finally {
    // Restore env vars
    if (envOverrides) {
      for (const key of Object.keys(envOverrides)) {
        if (savedEnv[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = savedEnv[key] as string;
        }
      }
    }
  }
}

// ── Shell: run the wiki-summarize pipeline across all batches ────────────

/**
 * Run the one-time `split-daily-shards` migration: move DailyNotes summaries
 * out of the main index into per-year shard files (Wiki/index-<year>.md).
 *
 * Idempotent — once the main index holds no DailyNotes entries the script
 * reports a no-op. Running it on every daily run keeps knowledge bases that
 * predate the shard layout from splitting DailyNotes across the main index
 * and shards as new `upsert-summary` calls route into shards.
 *
 * Pure IO shell — no decision logic. Failures are logged and swallowed: the
 * summarize pipeline still works against an unmigrated index, so a broken
 * migration must not block the daily run.
 */
/** @internal Exported for testing only. */
export async function runShardMigration(exec: {
  exec: (
    cmd: string,
    args?: string[],
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
}): Promise<void> {
  log.info("Step 0: split-daily-shards migration");
  try {
    const result = await exec.exec("node", [
      INDEX_SCRIPT,
      "split-daily-shards",
      "--base-path",
      KNOWLEDGE_DIR,
    ]);
    if (result.code !== 0) {
      log.warn("split-daily-shards failed", {
        exitCode: result.code,
        stderr: result.stderr.slice(0, 500),
      });
      return;
    }
    const stdout = result.stdout.trim();
    if (stdout) {
      log.info("split-daily-shards output", { stdout: stdout.slice(0, 500) });
    }
  } catch (err) {
    log.warn("split-daily-shards threw", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Result of the wiki-summarize pipeline.
 */
interface SummarizePipelineResult {
  createdSummaries: string[];
  wikiSummaryDone: string;
}

/**
 * Run the wiki-summarize pipeline for all stale files, processing them
 * in independent batches via the Pi subagent with bounded concurrency
 * (up to MAX_CONCURRENT_BATCHES at a time).
 *
 * Pure shell — handles IO (subagent calls, logging, Telegram notifications).
 * Returns accumulated results for the handler to use in subsequent steps.
 *
 * Each batch is independent: a failure (returned or thrown) only affects that
 * batch. Results are collected in batch order regardless of completion order,
 * keeping `createdSummaries` / `wikiSummaryDone` deterministic.
 *
 * Shared concept files (Phase 3 linking) are safe under concurrency:
 * wiki-concept.mjs serializes per-concept mutations via inter-process lock
 * files, so parallel batches cannot lose each other's updates.
 */
/** @internal Exported for testing only. */
export async function runSummarizePipeline(
  exec: { subagent: (opts: SubagentOptions) => Promise<SubagentResult> },
  staleFiles: string[],
): Promise<SummarizePipelineResult> {
  if (staleFiles.length === 0) {
    log.info("no stale files, skipping subagent");
    return { createdSummaries: [], wikiSummaryDone: "No stale files found." };
  }

  // ── Build batches ──
  const batches = partitionIntoBatches(staleFiles, BATCH_SIZE);
  log.info("subagent batches", {
    totalFiles: staleFiles.length,
    batchCount: batches.length,
    batchSize: BATCH_SIZE,
    maxConcurrent: MAX_CONCURRENT_BATCHES,
  });

  // ── Process batches with bounded concurrency ──
  // A thrown subagent error degrades to a failed batch inside the pool
  // (onRejected keeps the shell-level log); collected results are never lost.
  // Concept-file writes stay safe: wiki-concept.mjs locks per concept slug.
  const results = await runBatchesConcurrently(
    batches,
    MAX_CONCURRENT_BATCHES,
    (batch, index) => processBatch(exec, batch, index, batches.length),
    (err, index) => {
      log.warn("wiki-summarize batch threw", {
        batch: `${index + 1}/${batches.length}`,
        error: errorMessage(err),
      });
    },
  );

  // ── Aggregate results (pure) → surface failures (shell) ──
  const { createdSummaries, wikiSummaryDone, failed } =
    aggregateBatchResults(results);

  for (const f of failed) {
    log.warn("wiki-summarize batch failed", {
      batch: `${f.batch}/${results.length}`,
      error: f.error,
    });

    await sendTelegramNotification(
      buildTelegramFailureMessage(
        `Step 1-3 (wiki-summarize batch ${f.batch}/${results.length})`,
        f.error,
      ),
    ).catch((e) => log.warn("telegram notify failed", { error: String(e) }));
  }

  if (failed.length > 0) {
    log.warn("wiki-summarize pipeline partially completed", {
      summariesCount: createdSummaries.length,
      note: "some batches failed, see previous warnings",
    });
  } else {
    log.info("wiki-summarize pipeline completed", {
      summariesCount: createdSummaries.length,
    });
  }

  return { createdSummaries, wikiSummaryDone };
}

// ── Task handler (thin orchestration shell) ──────────────────────────────

export default defineTask({
  id: "knowledge-wiki-daily",
  every: "24h",
  description:
    "每日知识库维护：过期摘要重新生成、概念自动链接、qmd 索引和向量嵌入更新",

  handler: async (exec) => {
    // ── Step 0: split DailyNotes into per-year shards (idempotent migration) ──
    const timings: StageTiming[] = [];
    const migration = await runTimedStage("Step 0 · 拆分 DailyNotes", () =>
      runShardMigration(exec),
    );
    timings.push(migration.timing);

    // ── Pre-step: list stale files ──
    log.info("Pre-step: list-stale");
    const staleFilesResult = await runTimedStage("Pre-step · list-stale", () =>
      listStaleFiles(exec),
    );
    timings.push(staleFilesResult.timing);
    const staleFiles = staleFilesResult.value;
    log.info("stale files found", { count: staleFiles.length });

    // ── Step 1-3: wiki-summarize pipeline ──
    log.info("Step 1-3: subagent — wiki-summarize full pipeline");
    const summarizeResult = await runTimedStage(
      "Step 1–3 · wiki-summarize",
      () => runSummarizePipeline(exec, staleFiles),
    );
    timings.push(summarizeResult.timing);
    const { createdSummaries, wikiSummaryDone } = summarizeResult.value;

    // ── Step 4: qmd update ──
    const qmdUpdateResult = await runTimedStage("Step 4 · qmd update", () =>
      runQmdStep(exec, "4", "qmd update", ["update"]),
    );
    timings.push(qmdUpdateResult.timing);
    const qmdUpdateOk = qmdUpdateResult.value;
    if (!qmdUpdateOk) return;

    // ── Step 5: qmd embed ──
    const qmdEmbedResult = await runTimedStage("Step 5 · qmd embed", () =>
      runQmdStep(exec, "5", "qmd embed", ["embed"], {
        QMD_EMBED_MODEL,
      }),
    );
    timings.push(qmdEmbedResult.timing);
    const qmdEmbedOk = qmdEmbedResult.value;
    if (!qmdEmbedOk) return;

    // ── Success notification ──
    const successMsg = buildTelegramSuccessMessage(
      staleFiles,
      createdSummaries,
      wikiSummaryDone,
      qmdUpdateOk,
      qmdEmbedOk,
      timings,
    );
    log.info("knowledge-wiki-daily task completed successfully");
    await sendTelegramNotification(successMsg, undefined, true).catch((e) =>
      log.warn("telegram notify failed", { error: String(e) }),
    );
  },
});
