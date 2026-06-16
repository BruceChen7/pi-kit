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
const CHUNK_PREFIX = "📑 Reddit Saved\n\n";
const LIMIT = 50;
const CHECKPOINT_PATH = join(
  homedir(),
  ".pi",
  "agent",
  "reddit-saved-checkpoint.json",
);

// ── Types ──────────────────────────────────────────────

/** A single saved Reddit post from the opencli JSON output. */
export interface SavedPost {
  title: string;
  subreddit: string;
  score: number;
  comments: number;
  url: string;
}

/** On-disk checkpoint state (persisted to JSON). */
export interface CheckpointState {
  /** post ID of the most recently seen saved post (null = first run). */
  lastHeadPostId: string | null;
}

/**
 * Result of the incremental decision logic.
 *
 * - `init` — first run; push all items and record checkpoint.
 * - `increment` — checkpoint found in the fetched range; push items before it.
 * - `warning` — checkpoint not found; push all fetched items with a truncation warning.
 * - `skip` — no new items, do nothing.
 */
export type IncrementDecision =
  | { kind: "init"; items: SavedPost[]; headId: string }
  | { kind: "increment"; items: SavedPost[]; headId: string }
  | { kind: "warning"; items: SavedPost[]; headId: string }
  | { kind: "skip" };

// ── Pure core: post ID extraction ──────────────────────

/**
 * Extract the Reddit post ID from a URL.
 *
 * Handles both regular post URLs and comment permalink URLs:
 * - `https://www.reddit.com/r/PiCodingAgent/comments/1u5g1wo/title/` → `1u5g1wo`
 * - `https://www.reddit.com/r/PiCodingAgent/comments/1tvko93/title/comment_id/` → `1tvko93`
 */
export function extractPostIdFromUrl(url: string): string {
  const match = url.match(/\/comments\/([a-z0-9]+)\//);
  if (!match) {
    throw new Error(`Cannot extract post ID from URL: ${url}`);
  }
  return match[1];
}

// ── Pure core: incremental decision ────────────────────

/**
 * Given the current fetch result and the persisted checkpoint, decide what to do.
 *
 * The opencli saved API returns items newest-first (most recently saved
 * at index 0). The `headId` identifies the most recently seen saved post.
 * Any items that appear *before* the checkpoint (earlier in the array) are
 * newly saved posts we haven't seen yet.
 *
 * **Key difference from bookmarks**: first run (`init`) pushes all items
 * and records the checkpoint, rather than only recording.
 *
 * No IO, no side effects — fully testable.
 */
export function computeIncrement(
  items: SavedPost[],
  state: CheckpointState,
): IncrementDecision {
  if (items.length === 0) return { kind: "skip" };

  const headId = extractPostIdFromUrl(items[0].url);

  if (state.lastHeadPostId === null) {
    // First run: push all items and record the most recent post as checkpoint.
    return { kind: "init", items, headId };
  }

  const checkpointIdx = items.findIndex(
    (item) => extractPostIdFromUrl(item.url) === state.lastHeadPostId,
  );

  if (checkpointIdx === -1) {
    // Checkpoint not found in the fetched range — the user saved so many
    // new posts that the checkpoint scrolled out of the limit window.
    return { kind: "warning", items, headId };
  }

  const newItems = items.slice(0, checkpointIdx);
  if (newItems.length === 0) return { kind: "skip" };

  return { kind: "increment", items: newItems, headId };
}

// ── Pure core: format items as Markdown ─────────────────

/**
 * Convert a single saved post into a Markdown entry line.
 *
 * Format:
 * ```
 * ## N.
 * - subreddit：r/xxx
 * - ⬆ score • 💬 comments
 * - [title](url)
 * ```
 */
export function formatSavedPost(item: SavedPost, index: number): string {
  const lines: string[] = [
    `## ${index + 1}.`,
    `- subreddit：${item.subreddit}`,
    `- ⬆ ${item.score} • 💬 ${item.comments}`,
    `- [${item.title}](${item.url})`,
  ];
  return lines.join("\n");
}

/**
 * Convert a list of saved posts into reading-friendly Markdown.
 *
 * If `warning` is provided, prepend it above the list in a blockquote.
 */
export function formatSavedPosts(items: SavedPost[], warning?: string): string {
  const parts: string[] = [];

  if (warning) {
    parts.push(`> ⚠️ ${warning}\n`);
  }

  for (let i = 0; i < items.length; i++) {
    parts.push(formatSavedPost(items[i], i));
  }

  return parts.join("\n");
}

// ── JSON parsing ───────────────────────────────────────

/**
 * Parse the JSON output from `opencli reddit saved -f json`.
 *
 * Pure function (throws on malformed input).
 */
export function parseSavedItems(jsonString: string): SavedPost[] {
  const parsed: unknown = JSON.parse(jsonString);
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected JSON array from opencli, got ${typeof parsed}`);
  }
  return parsed as SavedPost[];
}

// ── Chunking ──────────────────────────────────────────

/**
 * Input for the pure core decision: how to chunk output.
 */
export interface SavedChunkInput {
  /** Raw Markdown output. */
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
   */
  maxHtmlLength: number;
}

/**
 * A single HTML chunk ready to send to Telegram.
 */
export interface SavedChunk {
  /** HTML string safe for Telegram parse_mode=HTML. */
  html: string;
}

/**
 * Pure core: converts raw Markdown into HTML chunks ready to send.
 *
 * Same strategy as `prepareBookmarkChunks`:
 * - Splits output at entry boundaries (`## N.` headings) to keep whole entries intact.
 * - Accumulates entries into chunks by **HTML length**.
 * - Prepends the prefix only to the first chunk.
 *
 * No IO, no side effects — fully testable with string inputs.
 */
export function prepareSavedChunks(input: SavedChunkInput): SavedChunk[] {
  const entries = splitEntries(input.rawOutput);
  const result: SavedChunk[] = [];

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
 * Split raw Markdown text into individual entries.
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

// ── IO: checkpoint management ──────────────────────────

/**
 * Load checkpoint from disk.
 * Returns `lastHeadPostId: null` when the file doesn't exist or is corrupt.
 */
export function loadCheckpoint(checkpointPath: string): CheckpointState {
  try {
    const raw = readFileSync(checkpointPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      lastHeadPostId:
        typeof parsed.lastHeadPostId === "string"
          ? parsed.lastHeadPostId
          : null,
    };
  } catch {
    return { lastHeadPostId: null };
  }
}

/**
 * Persist the latest head post ID to disk.
 * Creates the directory if it doesn't exist.
 */
export function saveCheckpoint(headId: string, checkpointPath: string): void {
  const dir = dirname(checkpointPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(
    checkpointPath,
    JSON.stringify({ lastHeadPostId: headId }, null, 2),
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
  id: "reddit-saved-fetch",
  every: "2d",
  description: "Fetch Reddit saved posts every 2 days via Pi agent",
  handler: async (exec) => {
    log.info("starting reddit saved fetch via opencli");

    // ── 1. Shell: run opencli ──────────────────────────────
    const result = await exec.exec("opencli", [
      "reddit",
      "saved",
      "--limit",
      String(LIMIT),
      "-f",
      "json",
    ]);

    if (result.code !== 0) {
      log.warn("opencli reddit saved failed", {
        exitCode: result.code,
        stderr: result.stderr.slice(0, 500),
      });
      return; // do NOT update checkpoint on failure
    }

    // ── 2. Parse JSON ──────────────────────────────────────
    let items: SavedPost[];
    try {
      items = parseSavedItems(result.stdout);
    } catch (err) {
      log.warn("failed to parse opencli JSON output", {
        error: String(err),
        stdoutSnippet: result.stdout.slice(0, 500),
      });
      return;
    }

    log.info("opencli reddit saved fetched", { count: items.length });

    // ── 3. Pure: decide what to push ────────────────────────
    const state = loadCheckpoint(CHECKPOINT_PATH);
    const decision = computeIncrement(items, state);

    log.info("increment decision", { kind: decision.kind });

    if (decision.kind === "skip") {
      log.info("no new saved posts to push");
      return;
    }

    // ── 4. Pure: format items as Markdown ──────────────────
    const warning =
      decision.kind === "warning" ? buildTruncationWarning(LIMIT) : undefined;

    const markdown = formatSavedPosts(decision.items, warning);

    // ── 5. Pure: chunk Markdown into Telegram HTML ──────────
    const chunks = prepareSavedChunks({
      rawOutput: markdown,
      prefix: CHUNK_PREFIX,
      maxChunkLength: CHUNK_MAX_LENGTH,
      maxHtmlLength: TELEGRAM_MAX_LENGTH,
    });

    log.info("sending saved post chunks", {
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
        log.warn("failed to send saved post chunk", {
          chunkIndex: i,
          error: String(err),
        });
        return; // do NOT update checkpoint
      }
    }

    // ── 7. All sent — persist new checkpoint ───────────────
    saveCheckpoint(decision.headId, CHECKPOINT_PATH);
    log.info("reddit saved fetch complete, checkpoint updated", {
      headId: decision.headId,
    });
  },
});
