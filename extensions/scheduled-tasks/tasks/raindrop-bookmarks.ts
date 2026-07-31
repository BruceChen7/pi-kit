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
 * Collapse newlines in user-supplied text (excerpts, titles) so it can never
 * spill into extra lines that could be misparsed as dedupe key lines.
 */
function normalizeSingleLine(text: string): string {
  return text.replace(/\s*\n+\s*/g, " ").trim();
}

/** 条目体公共部分：excerpt 截断 + tags 后缀（Telegram 与档案共用）。 */
function renderItemBody(item: BookmarkItem): { excerpt: string; tags: string } {
  const excerpt = item.excerpt
    ? `\n💬 ${normalizeSingleLine(item.excerpt).slice(0, 200)}`
    : "";
  const tags = item.tags.length > 0 ? ` 🏷️ ${item.tags.join(", ")}` : "";
  return { excerpt, tags };
}

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
    const { excerpt, tags } = renderItemBody(item);

    parts.push(
      `## ${i + 1}. **${item.title}**`,
      `🔗 ${item.link}`,
      `📍 ${item.domain}${tags}`,
      excerpt,
    );
  }

  return parts.join("\n");
}

// ── Pure core: per-year archive entry ───────────────────

/** Lines starting with this prefix carry the dedupe key (the bookmark URL). */
const ARCHIVE_LINK_RE = /^🔗 (.+)$/gm;

/** 从已有文件内容中提取已归档的 key（`🔗 <key>` 行）。 */
function extractArchiveKeys(existingContent: string): Set<string> {
  const keys = new Set<string>();
  const linkRe = new RegExp(ARCHIVE_LINK_RE.source, "gm");
  for (const match of existingContent.matchAll(linkRe)) {
    keys.add(match[1]);
  }
  return keys;
}

/**
 * Dedupe key for an archive entry: link, falling back to the title.
 *
 * Newlines are collapsed so the `🔗 <key>` line stays a single line and a
 * later run can re-extract it verbatim via {@link ARCHIVE_LINK_RE}.
 */
function archiveKey(item: BookmarkItem): string {
  return normalizeSingleLine(item.link || item.title);
}

/**
 * 纯决策：过滤出尚未归档的条目。
 *
 * key = link（回退 title）；空 key 的条目跳过。输入是简单值集合，
 * 不接触文件格式，独立可测。
 */
export function selectNewArchiveItems(
  items: BookmarkItem[],
  existingKeys: ReadonlySet<string>,
): BookmarkItem[] {
  return items.filter((item) => {
    const key = archiveKey(item);
    if (!key) return false;
    return !existingKeys.has(key);
  });
}

/**
 * 纯渲染：把新条目渲染为追加文本。
 *
 * @param includeFileTitle - 首次建文件时写 `# ...` 标题（由编排方决定）。
 */
export function renderArchiveEntry(
  date: string,
  newItems: BookmarkItem[],
  includeFileTitle: boolean,
): string {
  const parts: string[] = [];
  if (includeFileTitle) {
    parts.push(`# Raindrop 书签档案（${date.slice(0, 4)}）`, "");
  }
  parts.push(`## ${date}`, "");

  for (let i = 0; i < newItems.length; i++) {
    const item = newItems[i];
    const key = archiveKey(item);
    const { excerpt, tags } = renderItemBody(item);

    parts.push(
      `${i + 1}. **${item.title}**`,
      `🔗 ${key}`,
      `📍 ${item.domain}${tags}`,
      excerpt,
    );
  }

  return `${parts.join("\n")}\n`;
}

/**
 * Build the text to append to the per-year archive file.
 *
 * 编排：提取已有 key（含上一年档案，用于跨年重试去重）→ 过滤新条目 → 渲染。
 * 返回 "" 表示全部重复。
 * Contract: every item line includes a `🔗 <key>` line so a later run can
 * re-extract keys via {@link ARCHIVE_LINK_RE}.
 *
 * @param previousYearContent - 上一年档案内容；仅当本年文件尚为空时由编排方提供
 *   （无上一年的文件时为空字符串）。防止跨年失败的批次在次年文件里重复归档。
 */
export function buildArchiveEntry(
  date: string,
  items: BookmarkItem[],
  existingContent: string,
  previousYearContent = "",
): string {
  const keys = extractArchiveKeys(existingContent);
  for (const key of extractArchiveKeys(previousYearContent)) {
    keys.add(key);
  }
  const newItems = selectNewArchiveItems(items, keys);
  if (newItems.length === 0) return "";
  return renderArchiveEntry(date, newItems, existingContent.length === 0);
}

// ── Task definition ────────────────────────────────────

const CHECKPOINT_PATH = join(
  homedir(),
  ".pi",
  "agent",
  "raindrop-bookmarks-checkpoint.json",
);

const ARCHIVE_DIR = join(homedir(), "work", "notes", "Calendar", "DailyNotes");

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
  archive: {
    dir: ARCHIVE_DIR,
    buildFileName: (year) => `raindrop-bookmarks-${year}.md`,
    buildEntry: buildArchiveEntry,
  },
});
