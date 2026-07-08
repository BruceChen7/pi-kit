/**
 * bookmark-pipeline.ts — 共享 bookmark 处理管线
 *
 * 纯函数集合，用于 opencli bookmark → 增量判断 → Markdown → Telegram HTML 分块
 * 的通用管线。被多个 scheduled-task 共享（X Bookmarks、Raindrop Bookmarks 等）。
 *
 * 各 task 只需定义自己的：
 *   - BookmarkItem 类型（字段映射）
 *   - computeIncrement（增量判断逻辑）
 *   - formatIncrement（格式化逻辑）
 *   - defineTask handler（编排）
 *
 * No IO, no side effects — fully testable.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { convertMarkdownToTelegramHtml } from "./telegram.ts";

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
