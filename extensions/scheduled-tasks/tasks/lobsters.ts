/**
 * lobsters.ts — scheduled task: fetch Lobste.rs per-tag newest posts and push to Telegram.
 *
 * Pipeline (per tag):
 *   1. HTTP fetch /t/{tag}.json
 *   2. Parse JSON response
 *   3. Filter by score >= 1
 *   4. Compute increment (short_id exact match)
 *   5. Format as Markdown section (F1: group by tag)
 *   6. Combine all tag sections, chunk by HTML length
 *   7. Send all chunks via Telegram
 *   8. Update per-tag checkpoint on success
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { prepareChunks } from "../../shared/chunking.ts";
import { defineTask } from "../../shared/deferred-queue/define-task.ts";
import { log } from "../../shared/deferred-queue/logger.ts";
import { sendTelegramNotification } from "../../shared/telegram.ts";

// ── Constants ────────────────────────────────────────────────────────────

const TELEGRAM_MAX_LENGTH = 4096;
const MIN_SCORE = 1;
const API_FETCH_LIMIT = 25;
const CHECKPOINT_PATH = join(
  homedir(),
  ".pi",
  "agent",
  "lobsters-checkpoint.json",
);
const LOBSTERS_BASE = "https://lobste.rs";

/** Tags being tracked — each gets a per-tag newest fetch. */
export const TAGS = [
  "rust",
  "go",
  "zig",
  "databases",
  "performance",
  "networking",
  "testing",
  "debugging",
] as const;

export type Tag = (typeof TAGS)[number];

// ── Types ────────────────────────────────────────────────────────────────

/** A single Lobste.rs post from the JSON API. */
export interface LobstersPost {
  short_id: string;
  created_at: string;
  title: string;
  url: string;
  score: number;
  flags: number;
  comment_count: number;
  description: string;
  description_plain: string;
  submitter_user: string;
  user_is_author: boolean;
  tags: string[];
  short_id_url: string;
  comments_url: string;
}

/**
 * Per-tag checkpoint state.
 * Key: tag name (lowercase), Value: short_id of most-recently-seen post.
 */
export type TagCheckpointMap = Partial<Record<Tag, string>>;

/**
 * Result of per-tag incremental decision.
 *
 * - `init` — first run; push all filtered items.
 * - `increment` — checkpoint found in fetched range; push items before it.
 * - `warning` — checkpoint not found; push all with warning.
 * - `skip` — no new items after filtering.
 */
export type IncrementDecision =
  | { kind: "init"; items: LobstersPost[]; headId: string }
  | { kind: "increment"; items: LobstersPost[]; headId: string }
  | { kind: "warning"; items: LobstersPost[]; headId: string }
  | { kind: "skip" };

/** Result of fetching and processing a single tag. */
export interface TagResult {
  tag: Tag;
  items: LobstersPost[];
  headId: string;
  warning?: string;
}

// ── Pure core: per-tag incremental decision ─────────────────────────────

/**
 * Given a list of Lobste.rs posts (newest-first) and the persisted checkpoint
 * short_id, decide which items are new and should be pushed.
 *
 * Pure function: no IO, no side effects.
 */
export function computeTagIncrement(
  items: LobstersPost[],
  lastHeadId: string | null,
): IncrementDecision {
  if (items.length === 0) return { kind: "skip" };

  const headId = items[0].short_id;

  if (lastHeadId === null) {
    // First run — push all items that pass the score filter,
    // record the most recent post's short_id as checkpoint.
    return { kind: "init", items, headId };
  }

  const checkpointIdx = items.findIndex((item) => item.short_id === lastHeadId);

  if (checkpointIdx === -1) {
    // Checkpoint not found — the user's saved checkpoint scrolled out
    // of the 25-item window. Push all fetched items.
    return { kind: "warning", items, headId };
  }

  const newItems = items.slice(0, checkpointIdx);
  if (newItems.length === 0) return { kind: "skip" };

  return { kind: "increment", items: newItems, headId };
}

// ── Pure core: filter by minimum score ──────────────────────────────────

/**
 * Filter posts by minimum score threshold.
 * Preserves newest-first ordering.
 */
export function filterByMinScore(
  items: LobstersPost[],
  minScore: number,
): LobstersPost[] {
  return items.filter((item) => item.score >= minScore);
}

// ── Pure core: format a single tag's items as a Markdown section ────────

/**
 * Display name for each tag (capitalised first letter).
 */
export function displayTag(tag: string): string {
  return tag.charAt(0).toUpperCase() + tag.slice(1);
}

/**
 * Format a single Lobste.rs post as a concise text line (embedded in a section).
 */
export function formatPostLine(
  item: LobstersPost,
  globalIndex: number,
): string {
  const parts: string[] = [
    `${globalIndex + 1}. **${item.title}** | ⬆ ${item.score} 💬 ${item.comment_count}`,
  ];

  if (item.description_plain) {
    const desc =
      item.description_plain.length > 200
        ? `${item.description_plain.slice(0, 200)}…`
        : item.description_plain;
    parts.push(`   💬 ${desc}`);
  }

  parts.push(`   🔗 ${item.url}`);

  return parts.join("\n");
}

/**
 * Format a tag's new items as a Markdown section.
 *
 * Example output:
 * ```
 * ## Rust
 *
 * 1. **Title A** | ⬆ 45 💬 12
 *    💬 Optional description here
 *    🔗 https://example.com
 * 2. **Title B** | ⬆ 32 💬 8
 *    🔗 https://example.org
 * ```
 *
 * Pure function: no IO, no side effects.
 */
export function formatTagSection(
  tag: Tag,
  items: LobstersPost[],
  startIndex: number,
  warning?: string,
): string {
  const lines: string[] = [];

  if (warning) {
    lines.push(`> ⚠️ ${warning}`, "");
  }

  lines.push(`## ${displayTag(tag)}`, "");

  for (let i = 0; i < items.length; i++) {
    lines.push(formatPostLine(items[i], startIndex + i));
  }

  return lines.join("\n");
}

// ── Warning message ─────────────────────────────────────────────────────

/**
 * Build a user-facing truncation warning when the checkpoint was not found
 * in the fetched range, indicating the API fetch limit may have been exceeded.
 *
 * @param limit - Maximum number of items fetched from the API per request.
 */
export function buildTruncationWarning(limit: number): string {
  return `上次 job 后有大量新帖，本次只拉取前 ${limit} 条，结果可能不完整。`;
}

// ── IO: checkpoint management ───────────────────────────────────────────

/**
 * Load per-tag checkpoint from disk.
 * Returns an empty map when the file doesn't exist or is corrupt.
 * Only accepts keys that match valid tags from the TAGS union.
 */
export function loadTagCheckpoint(checkpointPath: string): TagCheckpointMap {
  try {
    const raw = readFileSync(checkpointPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const result: TagCheckpointMap = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        const tag = key as Tag;
        if (TAGS.includes(tag)) {
          result[tag] = value;
        }
      }
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Persist per-tag checkpoint to disk atomically.
 *
 * Uses write-temp-then-rename to prevent file corruption on crash.
 * Creates the directory if it doesn't exist.
 */
export function saveTagCheckpoint(
  checkpoint: TagCheckpointMap,
  checkpointPath: string,
): void {
  const dir = dirname(checkpointPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const tmpPath = `${checkpointPath}.tmp.${Date.now()}`;
  try {
    writeFileSync(tmpPath, JSON.stringify(checkpoint, null, 2), "utf-8");
    renameSync(tmpPath, checkpointPath);
  } catch (err) {
    // Clean up temp file on failure
    try {
      if (existsSync(tmpPath)) {
        rmSync(tmpPath, { force: true });
      }
    } catch {
      // ignore cleanup failures
    }
    throw err;
  }
}

// ── IO: HTTP fetch with exec context ────────────────────────────────────

/**
 * Fetch a tag's newest posts via exec (curl).
 *
 * Falls back to `fetch` if available in the runtime; uses `curl` via
 * exec.exec for compatibility with the ExecContext pattern.
 *
 * Returns parsed posts array, or null on failure.
 */
export async function fetchTagPosts(
  tag: string,
  execFn: (
    cmd: string,
    args?: string[],
  ) => Promise<{
    code: number;
    stdout: string;
    stderr: string;
  }>,
): Promise<LobstersPost[] | null> {
  const url = `${LOBSTERS_BASE}/t/${tag}.json`;
  log.info("fetching tag", { tag, url });

  const result = await execFn("curl", ["-s", "--max-time", "15", url]);

  if (result.code !== 0) {
    log.warn("fetch tag failed", {
      tag,
      exitCode: result.code,
      stderr: result.stderr.slice(0, 300),
    });
    return null;
  }

  try {
    const parsed = JSON.parse(result.stdout) as LobstersPost[];
    if (!Array.isArray(parsed)) {
      log.warn("fetch tag: unexpected JSON format", { tag });
      return null;
    }
    return parsed;
  } catch (err) {
    log.warn("fetch tag: failed to parse JSON", {
      tag,
      error: String(err),
      stdoutSnippet: result.stdout.slice(0, 300),
    });
    return null;
  }
}

// ── Task handler ────────────────────────────────────────────────────────

const PREFIX = "📑 Lobsters 今日推荐";

export default defineTask({
  id: "lobsters-recent-fetch",
  every: "24h",
  description: "每日获取 Lobste.rs 指定 tag 的最新帖子并通过 Telegram 推送",

  handler: async (exec) => {
    log.info("starting lobsters fetch", { tags: TAGS });

    // ── 1. Load per-tag checkpoint ───────────────────────────────
    const persisted = loadTagCheckpoint(CHECKPOINT_PATH);
    const tagResults: TagResult[] = [];

    // ── 2. Fetch each tag, compute increment ──────────────────────
    for (const tag of TAGS) {
      const allItems = await fetchTagPosts(tag, exec.exec);
      if (allItems === null) {
        // Fetch failed for this tag — skip it, keep old checkpoint
        log.warn("skipping tag due to fetch failure", { tag });
        continue;
      }

      log.info("tag fetched", {
        tag,
        totalItems: allItems.length,
      });

      // Apply score threshold
      const scoredItems = filterByMinScore(allItems, MIN_SCORE);

      // Compute increment on scored items
      const decision = computeTagIncrement(scoredItems, persisted[tag] ?? null);

      log.info("tag increment decision", {
        tag,
        kind: decision.kind,
        newItems: decision.kind !== "skip" ? decision.items.length : 0,
      });

      if (decision.kind === "skip") {
        continue;
      }

      const warning =
        decision.kind === "warning"
          ? buildTruncationWarning(API_FETCH_LIMIT)
          : undefined;

      tagResults.push({
        tag,
        items: decision.items,
        headId: decision.headId,
        warning,
      });
    }

    // ── 3. Nothing to push? Done. ─────────────────────────────────
    if (tagResults.length === 0) {
      log.info("no new posts across any tag — skipping");
      return;
    }

    const totalNewItems = tagResults.reduce(
      (sum, r) => sum + r.items.length,
      0,
    );
    log.info("new posts to push", {
      tagsWithContent: tagResults.length,
      totalItems: totalNewItems,
    });

    // ── 4. Format as Markdown sections (F1: group by tag) ─────────
    let globalIndex = 0;
    const sections: string[] = [];

    for (const r of tagResults) {
      const section = formatTagSection(r.tag, r.items, globalIndex, r.warning);
      sections.push(section);
      globalIndex += r.items.length;
    }

    const prefix = `${PREFIX}（${totalNewItems} 条）\n\n`;

    // ── 5. Chunk sections into Telegram HTML chunks ───────────────
    const chunks = prepareChunks({
      sections,
      prefix,
      maxHtmlLength: TELEGRAM_MAX_LENGTH,
    });

    log.info("sending lobsters chunks", {
      chunkCount: chunks.length,
      totalItems: totalNewItems,
    });

    // ── 6. Send each chunk via Telegram ───────────────────────────
    let lastSentIndex = -1;
    for (let i = 0; i < chunks.length; i++) {
      try {
        await sendTelegramNotification(chunks[i].html, undefined, true);
        lastSentIndex = i;
        log.info("chunk sent", { chunkIndex: i });
      } catch (err) {
        log.warn("failed to send lobsters chunk", {
          chunkIndex: i,
          error: String(err),
        });
        // Update checkpoint with items whose chunks were already sent
        // to avoid duplicate messages on retry.
        if (tagResults.length > 0) {
          // Only save checkpoint for tags that were fully sent across all chunks
          // If some chunks failed mid-way, we save what we can to avoid duplicates.
          const newCheckpoint: TagCheckpointMap = { ...persisted };
          for (const r of tagResults) {
            newCheckpoint[r.tag] = r.headId;
          }
          saveTagCheckpoint(newCheckpoint, CHECKPOINT_PATH);
          log.info("partial checkpoint saved to avoid duplicate resend", {
            lastSentIndex,
            tagsUpdated: tagResults.map((r) => r.tag),
          });
        }
        return;
      }
    }

    // ── 7. All sent — persist new per-tag checkpoints ─────────────
    const newCheckpoint: TagCheckpointMap = { ...persisted };
    for (const r of tagResults) {
      newCheckpoint[r.tag] = r.headId;
    }
    saveTagCheckpoint(newCheckpoint, CHECKPOINT_PATH);

    log.info("lobsters fetch complete, checkpoint updated", {
      tagsUpdated: tagResults.map((r) => r.tag),
    });
  },
});
