import { homedir } from "node:os";
import { join } from "node:path";
import { loadCheckpoint, saveCheckpoint } from "../../shared/checkpoint.ts";
import { prepareChunks, splitEntries } from "../../shared/chunking.ts";
import { defineTask } from "../../shared/deferred-queue/define-task.ts";
import { log } from "../../shared/deferred-queue/logger.ts";
import { sendTelegramNotification } from "../../shared/telegram.ts";

const TELEGRAM_MAX_LENGTH = 4096;
const CHUNK_PREFIX = "📑 Reddit Saved\n\n";
const LIMIT = 50;
const CHECKPOINT_PATH = join(
  homedir(),
  ".pi",
  "agent",
  "reddit-saved-checkpoint.json",
);
const CHECKPOINT_FIELD = "lastHeadPostId";

// ── Types ──────────────────────────────────────────────

/** A single saved Reddit post from the opencli JSON output. */
export interface SavedPost {
  title: string;
  subreddit: string;
  score: number;
  comments: number;
  url: string;
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
  lastHeadPostId: string | null,
): IncrementDecision {
  if (items.length === 0) return { kind: "skip" };

  const headId = extractPostIdFromUrl(items[0].url);

  if (lastHeadPostId === null) {
    // First run: push all items and record the most recent post as checkpoint.
    return { kind: "init", items, headId };
  }

  const checkpointIdx = items.findIndex(
    (item) => extractPostIdFromUrl(item.url) === lastHeadPostId,
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

// ── Chunking (delegates to shared chunking.ts) ─────────

/**
 * Pure core: converts raw Markdown into HTML chunks ready to send.
 *
 * Delegates to the shared {@link prepareChunks} after calling
 * {@link splitEntries} on `rawOutput`.
 *
 * No IO, no side effects — fully testable with string inputs.
 */
export function prepareSavedChunks(
  rawOutput: string,
  prefix: string,
  maxHtmlLength: number,
): { html: string }[] {
  return prepareChunks({
    sections: splitEntries(rawOutput),
    prefix,
    maxHtmlLength,
  });
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
    const lastHeadPostId = loadCheckpoint(CHECKPOINT_PATH, CHECKPOINT_FIELD);
    const decision = computeIncrement(items, lastHeadPostId);

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
    const chunks = prepareSavedChunks(
      markdown,
      CHUNK_PREFIX,
      TELEGRAM_MAX_LENGTH,
    );

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
        // Save checkpoint to avoid duplicate resend of already-sent chunks
        saveCheckpoint(CHECKPOINT_FIELD, decision.headId, CHECKPOINT_PATH);
        log.info("partial checkpoint saved to avoid duplicate resend", {
          headId: decision.headId,
          lastSentIndex: i - 1,
        });
        return;
      }
    }

    // ── 7. All sent — persist new checkpoint ───────────────
    saveCheckpoint(CHECKPOINT_FIELD, decision.headId, CHECKPOINT_PATH);
    log.info("reddit saved fetch complete, checkpoint updated", {
      headId: decision.headId,
    });
  },
});
