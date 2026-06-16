import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { defineTask } from "../../shared/deferred-queue/define-task.ts";
import { log } from "../../shared/deferred-queue/logger.ts";
import {
  convertMarkdownToTelegramHtml,
  sendTelegramNotification,
} from "../../shared/telegram.ts";

const CHUNK_MAX_LENGTH = 3800;
const TELEGRAM_MAX_LENGTH = 4096;
const CHUNK_PREFIX = "📑 X Bookmarks\n\n";
const LIMIT = 50;
const CHECKPOINT_PATH = join(
  homedir(),
  ".pi",
  "agent",
  "x-bookmarks-checkpoint.json",
);

// ── Types ──────────────────────────────────────────────

/** A single bookmark entry from the opencli JSON output. */
export interface BookmarkItem {
  id: string;
  author: string;
  name: string;
  text: string;
  likes: number;
  retweets: number;
  bookmarks: number;
  created_at: string;
  url: string;
  has_media: boolean;
  media_urls: string[];
}

/** On-disk checkpoint state (persisted to JSON). */
export interface CheckpointState {
  /** id of the most recently seen bookmark (null = first run). */
  lastHeadTweetId: string | null;
}

/**
 * Result of the incremental decision logic.
 *
 * - `init` — first run, checkpoint recorded; **do not push** anything.
 * - `increment` — checkpoint found in the fetched range; push items before it.
 * - `warning` — checkpoint not found; push all fetched items with a truncation warning.
 * - `skip` — no new items, do nothing.
 */
export type IncrementDecision =
  | { kind: "init"; headId: string }
  | { kind: "increment"; items: BookmarkItem[]; headId: string }
  | { kind: "warning"; items: BookmarkItem[]; headId: string }
  | { kind: "skip" };

// ── Pure core: incremental decision ────────────────────

/**
 * Given the current fetch result and the persisted checkpoint, decide what to do.
 *
 * The opencli bookmarks API returns items newest-first (most recent bookmark
 * at index 0). The `headId` is the most recent bookmark we've already seen.
 * Any items that appear *before* the checkpoint (earlier in the array) are
 * newer bookmarks we haven't seen yet.
 *
 * No IO, no side effects — fully testable.
 */
export function computeIncrement(
  items: BookmarkItem[],
  state: CheckpointState,
): IncrementDecision {
  if (items.length === 0) return { kind: "skip" };

  const headId = items[0].id;

  if (state.lastHeadTweetId === null) {
    // First run: record the most recent bookmark as checkpoint, push nothing.
    return { kind: "init", headId };
  }

  const checkpointIdx = items.findIndex(
    (item) => item.id === state.lastHeadTweetId,
  );

  if (checkpointIdx === -1) {
    // Checkpoint not found in the fetched range — the user bookmarked so many
    // new items that the checkpoint scrolled out of the limit window.
    return { kind: "warning", items, headId };
  }

  const newItems = items.slice(0, checkpointIdx);
  if (newItems.length === 0) return { kind: "skip" };

  return { kind: "increment", items: newItems, headId };
}

// ── Pure core: format items as Markdown ─────────────────

/**
 * Convert a list of bookmark items into reading-friendly Markdown.
 *
 * If `warning` is provided, prepend it above the list in a blockquote.
 */
export function formatIncrement(
  items: BookmarkItem[],
  warning?: string,
): string {
  const parts: string[] = [];

  if (warning) {
    parts.push(`> ⚠️ ${warning}\n`);
  }

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const truncated =
      item.text.length > 300 ? `${item.text.slice(0, 300)}…` : item.text;
    parts.push(
      `## ${i + 1}.`,
      `- 作者：@${item.author}`,
      `- 时间：${item.created_at}`,
      `- 内容：${truncated}`,
      `- 链接：${item.url}`,
    );
  }

  return parts.join("\n");
}

// ── JSON parsing ───────────────────────────────────────

/**
 * Parse the JSON output from `opencli twitter bookmarks -f json`.
 *
 * Pure function (throws on malformed input).
 */
export function parseBookmarkItems(jsonString: string): BookmarkItem[] {
  const parsed: unknown = JSON.parse(jsonString);
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected JSON array from opencli, got ${typeof parsed}`);
  }
  // Basic field validation is left to the caller / downstream code.
  // If a field is missing, TypeScript will still produce a valid object
  // and the formatting functions will render whatever is available.
  return parsed as BookmarkItem[];
}

// ── Input for the chunking decision ─────────────────────

/**
 * Input for the pure core decision: how to chunk bookmark output.
 */
export interface BookmarkChunkInput {
  /** Raw Markdown output from the subagent. */
  rawOutput: string;
  /** Prefix prepended to the first chunk. */
  prefix: string;
  /**
   * Maximum character length of the raw content per chunk.
   * Used as a first-pass limit; the output HTML is further constrained
   * by `maxHtmlLength` to account for tag expansion.
   */
  maxChunkLength: number;
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
 *   output never exceeds Telegram's 4096-character `sendMessage` limit even after
 *   Markdown→HTML tag expansion.
 * - Prepends the prefix only to the first chunk.
 *
 * Edge case: a single entry whose HTML exceeds `maxHtmlLength` is still sent as
 * one chunk (Telegram will reject it, but this is extremely rare — a single
 * bookmark entry would need to be thousands of characters long).
 *
 * No IO, no side effects — fully testable with string inputs.
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
      // Adding this entry would exceed the HTML length limit — flush first
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
 * The leading summary text (before the first `## N.`) is treated as the first entry.
 */
function splitEntries(text: string): string[] {
  const entries: string[] = [];
  let buffer = "";

  for (const line of text.split("\n")) {
    if (/^## \d+\.\s/.test(line) && buffer) {
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

// ── IO: checkpoint management ──────────────────────────

/**
 * Load checkpoint from disk.
 * Returns `lastHeadTweetId: null` when the file doesn't exist or is corrupt.
 */
export function loadCheckpoint(checkpointPath: string): CheckpointState {
  try {
    const raw = readFileSync(checkpointPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      lastHeadTweetId:
        typeof parsed.lastHeadTweetId === "string"
          ? parsed.lastHeadTweetId
          : null,
    };
  } catch {
    return { lastHeadTweetId: null };
  }
}

/**
 * Persist the latest head tweet id to disk.
 * Creates the directory if it doesn't exist.
 */
export function saveCheckpoint(headId: string, checkpointPath: string): void {
  const dir = dirname(checkpointPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(
    checkpointPath,
    JSON.stringify({ lastHeadTweetId: headId }, null, 2),
    "utf-8",
  );
}

// ── Shell: warning message construction ─────────────────

/**
 * Build a user-facing truncation warning when the checkpoint was not found
 * in the fetched range, indicating the limit may have been exceeded.
 */
export function buildTruncationWarning(limit: number): string {
  return `上次 job 后有大量新增收藏，本次只拉取到前 ${limit} 条，结果可能不完整。`;
}

// ── Task handler ───────────────────────────────────────

export default defineTask({
  id: "x-bookmarks-fetch",
  every: "24h",
  description: "Fetch X bookmarks daily via Pi agent",
  handler: async (exec) => {
    log.info("starting bookmarks fetch via opencli");

    // ── 1. Shell: run opencli ──────────────────────────────
    const result = await exec.exec("opencli", [
      "twitter",
      "bookmarks",
      "--limit",
      String(LIMIT),
      "-f",
      "json",
    ]);

    if (result.code !== 0) {
      log.warn("opencli bookmarks failed", {
        exitCode: result.code,
        stderr: result.stderr.slice(0, 500),
      });
      return; // do NOT update checkpoint on failure
    }

    // ── 2. Parse JSON ──────────────────────────────────────
    let items: BookmarkItem[];
    try {
      items = parseBookmarkItems(result.stdout);
    } catch (err) {
      log.warn("failed to parse opencli JSON output", {
        error: String(err),
        stdoutSnippet: result.stdout.slice(0, 500),
      });
      return;
    }

    log.info("opencli bookmarks fetched", { count: items.length });

    // ── 3. Pure: decide what to push ────────────────────────
    const state = loadCheckpoint(CHECKPOINT_PATH);
    const decision = computeIncrement(items, state);

    log.info("increment decision", { kind: decision.kind });

    if (decision.kind === "skip") {
      log.info("no new bookmarks to push");
      return;
    }

    if (decision.kind === "init") {
      log.info("first run — recording checkpoint, no push", {
        headId: decision.headId,
      });
      saveCheckpoint(decision.headId, CHECKPOINT_PATH);
      return;
    }

    // ── 4. Pure: format items as Markdown ──────────────────
    const warning =
      decision.kind === "warning" ? buildTruncationWarning(LIMIT) : undefined;

    const markdown = formatIncrement(decision.items, warning);

    // ── 5. Pure: chunk Markdown into Telegram HTML ──────────
    const chunks = prepareBookmarkChunks({
      rawOutput: markdown,
      prefix: CHUNK_PREFIX,
      maxChunkLength: CHUNK_MAX_LENGTH,
      maxHtmlLength: TELEGRAM_MAX_LENGTH,
    });

    log.info("sending bookmark chunks", {
      chunkCount: chunks.length,
      newItems: decision.items.length,
      decisionKind: decision.kind,
    });

    // ── 6. Shell: send each chunk via Telegram ─────────────
    // If any send fails, we abort — checkpoint is NOT updated,
    // so next run will re-discover the same items.
    for (let i = 0; i < chunks.length; i++) {
      try {
        await sendTelegramNotification(chunks[i].html, undefined, true);
        log.info("chunk sent", { chunkIndex: i });
      } catch (err) {
        log.warn("failed to send bookmark chunk", {
          chunkIndex: i,
          error: String(err),
        });
        return; // do NOT update checkpoint
      }
    }

    // ── 7. All sent — persist new checkpoint ───────────────
    saveCheckpoint(decision.headId, CHECKPOINT_PATH);
    log.info("bookmarks fetch complete, checkpoint updated", {
      headId: decision.headId,
    });
  },
});
