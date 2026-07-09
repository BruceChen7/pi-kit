/**
 * bookmark-pipeline.ts — 共享 bookmark 处理管线
 *
 * 纯函数集合 + 工厂函数，用于 opencli bookmark → 增量判断 → Markdown → Telegram HTML 分块
 * 的通用管线。被多个 scheduled-task 共享（X Bookmarks、Raindrop Bookmarks 等）。
 *
 * 各 task 只需定义自己的：
 *   - BookmarkItem 类型（字段映射）
 *   - computeIncrement（增量判断逻辑）
 *   - formatIncrement（格式化逻辑）
 *   - BookmarkTaskConfig（配置对象传给 createBookmarkTask）
 *
 * No IO, no side effects — fully testable. 工厂函数处理所有编排。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { defineTask } from "./deferred-queue/define-task.ts";
import { log } from "./deferred-queue/logger.ts";
import {
  convertMarkdownToTelegramHtml,
  sendTelegramNotification,
} from "./telegram.ts";

// ── JSON parsing ───────────────────────────────────────

/**
 * Parse the JSON output from an opencli bookmarks command.
 *
 * @template T - The expected bookmark item type.
 * @throws {Error} If the input is not a valid JSON array.
 */
export function parseBookmarkItems<T>(jsonString: string): T[] {
  const parsed: unknown = JSON.parse(jsonString);
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected JSON array from opencli, got ${typeof parsed}`);
  }
  return parsed as T[];
}

// ── Telegram chunking ───────────────────────────────────

/**
 * Input for the pure core decision: how to chunk bookmark output.
 */
export interface BookmarkChunkInput {
  /** Raw Markdown output. */
  rawOutput: string;
  /** Prefix prepended to the first chunk. */
  prefix: string;
  /**
   * Maximum character length of the raw content per chunk (first-pass limit).
   * The output HTML is further constrained by `maxHtmlLength`.
   */
  maxChunkLength?: number;
  /**
   * Maximum HTML length per chunk (Telegram's sendMessage limit is 4096).
   * After Markdown→HTML conversion, each chunk's HTML string is guaranteed
   * to be ≤ this value.
   */
  maxHtmlLength: number;
}

/**
 * A single HTML chunk ready to send to Telegram.
 */
export interface BookmarkChunk {
  /** HTML string safe for Telegram parse_mode=HTML. */
  html: string;
}

/**
 * Pure core: converts raw Markdown into HTML chunks ready to send.
 *
 * - Splits output at entry boundaries (`## N.` headings) to keep whole entries intact.
 * - Accumulates entries into chunks by **HTML length** (not raw length), so the
 *   output never exceeds Telegram's sendMessage limit even after
 *   Markdown→HTML tag expansion.
 * - Prepends the prefix only to the first chunk.
 *
 * Edge case: a single entry whose HTML exceeds `maxHtmlLength` is still sent as
 * one chunk (Telegram will reject it, but this is extremely rare — a single
 * bookmark entry would need to be thousands of characters long).
 *
 * No IO, no side effects — fully testable.
 */
export function prepareBookmarkChunks(
  input: BookmarkChunkInput,
): BookmarkChunk[] {
  const entries = splitEntries(input.rawOutput);
  const result: BookmarkChunk[] = [];

  let buffer: string[] = [];

  const flushBuffer = () => {
    if (buffer.length === 0) return;
    const raw = buffer.join("\n");
    const text = result.length === 0 ? input.prefix + raw : raw;
    result.push({ html: convertMarkdownToTelegramHtml(text) });
    buffer = [];
  };

  for (const entry of entries) {
    const candidateBuffer = [...buffer, entry];
    const raw = candidateBuffer.join("\n");
    const text =
      result.length === 0 && buffer.length === 0 ? input.prefix + raw : raw;

    if (
      convertMarkdownToTelegramHtml(text).length > input.maxHtmlLength &&
      buffer.length > 0
    ) {
      flushBuffer();
    }

    buffer.push(entry);
  }

  flushBuffer();

  return result;
}

/**
 * Split raw Markdown text into individual bookmark entries.
 *
 * Entries are delimited by `## N.` heading lines.
 */
export function splitEntries(text: string): string[] {
  const entries: string[] = [];
  let buffer = "";

  for (const line of text.split("\n")) {
    if (/^## \d+\.(?:\s|$)/.test(line) && buffer) {
      entries.push(buffer.trim());
      buffer = line;
    } else {
      buffer += (buffer ? "\n" : "") + line;
    }
  }

  if (buffer.trim()) {
    entries.push(buffer.trim());
  }

  return entries;
}

// ── Checkpoint management ──────────────────────────────

/**
 * Load a checkpoint from disk.
 *
 * @param checkpointPath - Absolute path to the JSON checkpoint file.
 * @param fieldName - The key in the JSON object to read (e.g. "lastHeadId").
 * @returns The stored string value, or null when the file doesn't exist or is corrupt.
 *
 * No IO aside from the read — tests accept a temp path.
 */
export function loadCheckpoint(
  checkpointPath: string,
  fieldName: string,
): string | null {
  try {
    const raw = readFileSync(checkpointPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return typeof parsed[fieldName] === "string"
      ? (parsed[fieldName] as string)
      : null;
  } catch {
    return null;
  }
}

/**
 * Persist a checkpoint value to disk.
 *
 * @param fieldName - The key in the JSON object to write.
 * @param value - The string value to persist.
 * @param checkpointPath - Absolute path to the JSON checkpoint file.
 *
 * No IO aside from the write — tests accept a temp path.
 */
export function saveCheckpoint(
  fieldName: string,
  value: string,
  checkpointPath: string,
): void {
  const dir = dirname(checkpointPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(
    checkpointPath,
    JSON.stringify({ [fieldName]: value }, null, 2),
    "utf-8",
  );
}

// ── Warning messages ───────────────────────────────────

/**
 * Build a user-facing truncation warning when the checkpoint was not found
 * in the fetched range, indicating the limit may have been exceeded.
 */
export function buildTruncationWarning(limit: number): string {
  return `上次 job 后有大量新增收藏，本次只拉取到前 ${limit} 条，结果可能不完整。`;
}

// ── Shared types for createBookmarkTask ─────────────────

/**
 * Result of the incremental decision logic.
 *
 * - `init` — first run, push all items (initial sync).
 * - `increment` — checkpoint found; push items before/after it.
 * - `warning` — checkpoint not found in fetched range; push all with warning.
 * - `skip` — no new items, do nothing.
 */
export type IncrementDecision<B> =
  | { kind: "init"; items: B[]; headValue: string }
  | { kind: "increment"; items: B[]; headValue: string }
  | { kind: "warning"; items: B[]; headValue: string }
  | { kind: "skip" };

/**
 * Standardized checkpoint state passed to `computeIncrement`.
 *
 * `lastCheckpointValue` is the raw string from disk (or null on first run).
 * Each task's `computeIncrement` maps this to its domain semantics
 * (e.g. tweet ID comparison, timestamp comparison).
 */
export interface CheckpointState {
  lastCheckpointValue: string | null;
}

/**
 * Configuration for creating a bookmark task via `createBookmarkTask`.
 *
 * @template B - The bookmark item type (parsed from opencli JSON output).
 */
export interface BookmarkTaskConfig<B> {
  /** Unique task identifier (e.g. "x-bookmarks-fetch"). */
  id: string;
  /** Cron-like interval (e.g. "24h", "1h"). */
  every: string;
  /** Human-readable task description. */
  description: string;

  /** Open CLI command (e.g. "opencli"). */
  command: string;
  /** Arguments to the command (excluding --limit and -f json). */
  args: string[];

  /** Absolute path to the checkpoint JSON file. */
  checkpointPath: string;
  /** Field name inside the checkpoint JSON (e.g. "lastHeadTweetId"). */
  checkpointField: string;

  /**
   * Build the Telegram prefix message.
   * Called with the decision and item count.
   */
  buildPrefix: (decision: IncrementDecision<B>, count: number) => string;

  /**
   * Pure core: given fetched items and persisted checkpoint state,
   * decide what to push.
   */
  computeIncrement: (
    items: B[],
    state: CheckpointState,
  ) => IncrementDecision<B>;

  /**
   * Pure core: format a list of bookmark items as Markdown.
   */
  formatIncrement: (items: B[], warning?: string) => string;

  /** Max items to fetch per run (default: 50). */
  limit?: number;
  /** Max HTML length per Telegram chunk (default: 4096). */
  maxHtmlLength?: number;
}

// ── Factory: create a bookmark task ─────────────────────

/**
 * Create a fully-wired scheduled bookmark task.
 *
 * Handles the 7-step pipeline:
 *   1. exec opencli → 2. parse JSON → 3. load checkpoint + compute increment →
 *   4. format Markdown → 5. chunk for Telegram → 6. send chunks → 7. save checkpoint
 *
 * Each task provides its domain logic via `config`, and the factory
 * wires up all orchestration (error handling, logging, Telegram delivery).
 *
 * @returns A `TaskDefinition` compatible with `defineTask`.
 */
export function createBookmarkTask<B>(
  config: BookmarkTaskConfig<B>,
): ReturnType<typeof defineTask> {
  const {
    id,
    every,
    description,
    command,
    args,
    checkpointPath,
    checkpointField,
    buildPrefix,
    computeIncrement,
    formatIncrement,
    limit = 50,
    maxHtmlLength = 4096,
  } = config;

  return defineTask({
    id,
    every,
    description,
    handler: async (exec) => {
      log.info(`starting ${id} via opencli`);

      // ── 1. Shell: run opencli ──────────────────────────────
      const result = await exec.exec(command, [
        ...args,
        "--limit",
        String(limit),
        "-f",
        "json",
      ]);

      if (result.code !== 0) {
        log.warn(`${id} failed`, {
          exitCode: result.code,
          stderr: result.stderr.slice(0, 500),
        });
        return;
      }

      // ── 2. Parse JSON ──────────────────────────────────────
      let items: B[];
      try {
        items = parseBookmarkItems<B>(result.stdout);
      } catch (err) {
        log.warn("failed to parse opencli JSON output", {
          error: String(err),
          stdoutSnippet: result.stdout.slice(0, 500),
        });
        return;
      }

      log.info("opencli bookmarks fetched", { count: items.length });

      // ── 3. Pure: decide what to push ────────────────────────
      const lastCheckpointValue = loadCheckpoint(
        checkpointPath,
        checkpointField,
      );
      const state: CheckpointState = { lastCheckpointValue };
      const decision = computeIncrement(items, state);

      log.info("increment decision", { kind: decision.kind });

      if (decision.kind === "skip") {
        log.info("no new bookmarks to push");
        return;
      }

      if (decision.kind === "init") {
        log.info("first run — pushing all bookmarks", {
          headValue: decision.headValue,
          count: decision.items.length,
        });
      }

      // ── 4. Pure: format items as Markdown ──────────────────
      const warning =
        decision.kind === "warning" ? buildTruncationWarning(limit) : undefined;

      const markdown = formatIncrement(decision.items, warning);
      const prefix = buildPrefix(decision, decision.items.length);

      // ── 5. Pure: chunk Markdown into Telegram HTML ──────────
      const chunks = prepareBookmarkChunks({
        rawOutput: markdown,
        prefix,
        maxHtmlLength,
      });

      log.info("sending bookmark chunks", {
        chunkCount: chunks.length,
        newItems: decision.items.length,
        decisionKind: decision.kind,
      });

      // ── 6. Shell: send each chunk via Telegram ─────────────
      for (let i = 0; i < chunks.length; i++) {
        try {
          await sendTelegramNotification(chunks[i].html, undefined, true);
          log.info("chunk sent", { chunkIndex: i });
        } catch (err) {
          log.warn("failed to send bookmark chunk", {
            chunkIndex: i,
            error: String(err),
          });
          return;
        }
      }

      // ── 7. All sent — persist new checkpoint ───────────────
      saveCheckpoint(checkpointField, decision.headValue, checkpointPath);
      log.info(`${id} complete, checkpoint updated`, {
        headValue: decision.headValue,
      });
    },
  });
}
