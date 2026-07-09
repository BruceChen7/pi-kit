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

// ── Pure core: incremental decision ────────────────────

/**
 * Given the current fetch result and the persisted checkpoint, decide what to do.
 *
 * The opencli bookmarks API returns items newest-first. Any items that
 * appear *before* the checkpoint (earlier in the array) are newer bookmarks
 * we haven't seen yet.
 *
 * No IO, no side effects — fully testable.
 */
export function computeIncrement(
  items: BookmarkItem[],
  state: CheckpointState,
): IncrementDecision<BookmarkItem> {
  if (items.length === 0) return { kind: "skip" };

  const headValue = items[0].id;

  if (state.lastCheckpointValue === null) {
    return { kind: "init", items, headValue };
  }

  const checkpointIdx = items.findIndex(
    (item) => item.id === state.lastCheckpointValue,
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

// ── Task definition ────────────────────────────────────

const CHECKPOINT_PATH = join(
  homedir(),
  ".pi",
  "agent",
  "x-bookmarks-checkpoint.json",
);

export default createBookmarkTask<BookmarkItem>({
  id: "x-bookmarks-fetch",
  every: "24h",
  description: "Fetch X bookmarks daily via Pi agent",
  command: "opencli",
  args: ["twitter", "bookmarks"],
  checkpointPath: CHECKPOINT_PATH,
  checkpointField: "lastHeadTweetId",
  buildPrefix: () => "📑 X Bookmarks\n\n",
  computeIncrement,
  formatIncrement,
});
