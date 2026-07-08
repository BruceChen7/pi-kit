import { homedir } from "node:os";
import { join } from "node:path";
import {
  buildTruncationWarning,
  loadCheckpoint,
  parseBookmarkItems,
  prepareBookmarkChunks,
  saveCheckpoint,
} from "../../shared/bookmark-pipeline.ts";
import { defineTask } from "../../shared/deferred-queue/define-task.ts";
import { log } from "../../shared/deferred-queue/logger.ts";
import { sendTelegramNotification } from "../../shared/telegram.ts";

const TELEGRAM_MAX_LENGTH = 4096;
const LIMIT = 50;
const CHECKPOINT_PATH = join(
  homedir(),
  ".pi",
  "agent",
  "raindrop-bookmarks-checkpoint.json",
);
const CHECKPOINT_FIELD = "lastCreatedAt";

// ── Types ──────────────────────────────────────────────

/** A single bookmark entry from the opencli JSON output. */
export interface BookmarkItem {
  title: string;
  link: string;
  domain: string;
  created: string;
  tags: string[];
  excerpt: string;
}

/** On-disk checkpoint state (persisted to JSON). */
export interface CheckpointState {
  /** ISO 8601 timestamp of the most recently seen bookmark (null = first run). */
  lastCreatedAt: string | null;
}

/**
 * Result of the incremental decision logic.
 *
 * - `init` — first run, checkpoint recorded; **do not push** anything.
 * - `increment` — checkpoint found in the fetched range; push items after it.
 * - `warning` — checkpoint not found; push all fetched items with a truncation warning.
 * - `skip` — no new items, do nothing.
 */
export type IncrementDecision =
  | { kind: "init"; items: BookmarkItem[]; headCreated: string }
  | { kind: "increment"; items: BookmarkItem[]; headCreated: string }
  | { kind: "warning"; items: BookmarkItem[]; headCreated: string }
  | { kind: "skip" };

// ── Pure core: incremental decision ────────────────────

/**
 * Given the current fetch result and the persisted checkpoint, decide what to do.
 *
 * The opencli bookmarks API returns items newest-first (most recent bookmark
 * at index 0). Items with `created > lastCreatedAt` are new.
 *
 * No IO, no side effects — fully testable.
 */
export function computeIncrement(
  items: BookmarkItem[],
  state: CheckpointState,
): IncrementDecision {
  if (items.length === 0) return { kind: "skip" };

  const headCreated = items[0].created;

  if (state.lastCreatedAt === null) {
    return { kind: "init", items, headCreated };
  }

  // Find the index where created <= lastCreatedAt (items we've seen before)
  // lastCreatedAt is non-null here because we returned `init` above when null.
  const lastCreatedAt = state.lastCreatedAt;
  const checkpointIdx = items.findIndex(
    (item) => item.created <= lastCreatedAt,
  );

  if (checkpointIdx === -1) {
    return { kind: "warning", items, headCreated };
  }

  const newItems = items.slice(0, checkpointIdx);
  if (newItems.length === 0) return { kind: "skip" };

  return { kind: "increment", items: newItems, headCreated };
}

// ── Pure core: format items as Markdown ─────────────────

/**
 * Convert a list of bookmark items into reading-friendly Markdown.
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
    const excerpt = item.excerpt ? `\n💬 ${item.excerpt.slice(0, 200)}` : "";
    const tags = item.tags.length > 0 ? ` 🏷️ ${item.tags.join(", ")}` : "";

    parts.push(
      `## ${i + 1}. **${item.title}**`,
      `🔗 ${item.link}`,
      `📍 ${item.domain}${tags}`,
      excerpt,
    );
  }

  return parts.join("\n");
}

// ── Task handler ───────────────────────────────────────

export default defineTask({
  id: "raindrop-bookmarks-fetch",
  every: "1h",
  description: "获取 Raindrop.io 新增书签并通过 Telegram 推送",
  handler: async (exec) => {
    log.info("starting raindrop bookmarks fetch via opencli");

    // ── 1. Shell: run opencli ──────────────────────────────
    const result = await exec.exec("opencli", [
      "raindrop",
      "bookmarks",
      "--limit",
      String(LIMIT),
      "-f",
      "json",
    ]);

    if (result.code !== 0) {
      log.warn("opencli raindrop bookmarks failed", {
        exitCode: result.code,
        stderr: result.stderr.slice(0, 500),
      });
      return;
    }

    // ── 2. Parse JSON ──────────────────────────────────────
    let items: BookmarkItem[];
    try {
      items = parseBookmarkItems<BookmarkItem>(result.stdout);
    } catch (err) {
      log.warn("failed to parse opencli JSON output", {
        error: String(err),
        stdoutSnippet: result.stdout.slice(0, 500),
      });
      return;
    }

    log.info("opencli raindrop bookmarks fetched", { count: items.length });

    // ── 3. Pure: decide what to push ────────────────────────
    const lastCreatedAt = loadCheckpoint(CHECKPOINT_PATH, CHECKPOINT_FIELD);
    const state: CheckpointState = { lastCreatedAt };
    const decision = computeIncrement(items, state);

    log.info("increment decision", { kind: decision.kind });

    if (decision.kind === "skip") {
      log.info("no new bookmarks to push");
      return;
    }

    if (decision.kind === "init") {
      log.info("first run — pushing all bookmarks", {
        headCreated: decision.headCreated,
        count: decision.items.length,
      });
    }

    // ── 4. Pure: format items as Markdown ──────────────────
    const isInit = decision.kind === "init";
    const warning =
      decision.kind === "warning" ? buildTruncationWarning(LIMIT) : undefined;

    const markdown = formatIncrement(decision.items, warning);
    const prefix = isInit
      ? `📑 Raindrop 首次全量同步（共 ${decision.items.length} 篇）\n\n`
      : `📑 Raindrop 新增书签（${decision.items.length} 篇）\n\n`;

    // ── 5. Pure: chunk Markdown into Telegram HTML ──────────
    const chunks = prepareBookmarkChunks({
      rawOutput: markdown,
      prefix,
      maxHtmlLength: TELEGRAM_MAX_LENGTH,
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
    saveCheckpoint(CHECKPOINT_FIELD, decision.headCreated, CHECKPOINT_PATH);
    log.info("raindrop bookmarks fetch complete, checkpoint updated", {
      headCreated: decision.headCreated,
    });
  },
});
