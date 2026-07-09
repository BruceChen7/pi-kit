import { homedir } from "node:os";
import { join } from "node:path";
import {
  type CheckpointState,
  createBookmarkTask,
  type IncrementDecision,
} from "../../shared/bookmark-pipeline.ts";

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

// ── Pure core: incremental decision ────────────────────

/**
 * Given the current fetch result and the persisted checkpoint, decide what to do.
 *
 * The opencli bookmarks API returns items newest-first (most recent bookmark
 * at index 0). Items with `created > lastCheckpointValue` are new.
 *
 * No IO, no side effects — fully testable.
 */
export function computeIncrement(
  items: BookmarkItem[],
  state: CheckpointState,
): IncrementDecision<BookmarkItem> {
  if (items.length === 0) return { kind: "skip" };

  const headValue = items[0].created;

  if (state.lastCheckpointValue === null) {
    return { kind: "init", items, headValue };
  }

  // Find the index where created <= lastCheckpointValue (items we've seen before)
  // lastCheckpointValue is non-null here because we returned `init` above when null.
  const lastCheckpointValue = state.lastCheckpointValue;
  const checkpointIdx = items.findIndex(
    (item) => item.created <= lastCheckpointValue,
  );

  if (checkpointIdx === -1) {
    return { kind: "warning", items, headValue };
  }

  const newItems = items.slice(0, checkpointIdx);
  if (newItems.length === 0) return { kind: "skip" };

  return { kind: "increment", items: newItems, headValue };
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

// ── Task definition ────────────────────────────────────

const CHECKPOINT_PATH = join(
  homedir(),
  ".pi",
  "agent",
  "raindrop-bookmarks-checkpoint.json",
);

export default createBookmarkTask<BookmarkItem>({
  id: "raindrop-bookmarks-fetch",
  every: "24h",
  description: "获取 Raindrop.io 新增书签并通过 Telegram 推送",
  command: "opencli",
  args: ["raindrop", "bookmarks"],
  checkpointPath: CHECKPOINT_PATH,
  checkpointField: "lastCreatedAt",
  buildPrefix: (decision, count) => {
    if (decision.kind === "init") {
      return `📑 Raindrop 首次全量同步（共 ${count} 篇）\n\n`;
    }
    return `📑 Raindrop 新增书签（${count} 篇）\n\n`;
  },
  computeIncrement,
  formatIncrement,
});
