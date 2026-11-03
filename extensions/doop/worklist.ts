/**
 * Pure: turn the canvas's raw comment log into one ordered worklist.
 *
 * Everything the model should not have to think about happens here — resolved
 * threads, replies folded into their root, threads this agent started itself,
 * duplicate ids, and comments whose anchor is unusable. The list is a function
 * of the server's state alone, so running it twice gives the same answer.
 */

export type CommentAnchor =
  | { kind: "element"; frameId: string; elementId: string; html: string }
  | { kind: "frame"; frameId: string; x: number; y: number }
  | { kind: "canvas"; pageId: string; x: number; y: number };

export type DoopComment = {
  id: string;
  text: string;
  from: string;
  at: number;
  resolvedAt?: number;
  parentId?: string;
  forAgent?: boolean;
  targetAgent?: string;
  frameId?: string;
  elementId?: string;
  html?: string;
  pageId?: string;
  x?: number;
  y?: number;
};

export type WorkItem = {
  id: string;
  anchor: CommentAnchor;
  author: string;
  at: number;
  text: string;
  /** replies from people other than this agent; its own replies are noise */
  replies: number;
  /** the comment @mentions a resident role, i.e. a human aimed it at the team */
  forAgent: boolean;
  targetAgent?: string;
};

export type Worklist = {
  canvasId: string;
  items: WorkItem[];
  skipped: number;
};

export type CommentsParse =
  | { ok: true; comments: DoopComment[] }
  | { ok: false; detail: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/** Boundary: MCP hands back `unknown`. Anything without id/text/from/at is dropped, not guessed. */
export function parseComments(raw: unknown): CommentsParse {
  if (!Array.isArray(raw)) {
    return { ok: false, detail: "get_comments did not return an array" };
  }
  const comments: DoopComment[] = [];
  let dropped = 0;
  for (const entry of raw) {
    if (!isRecord(entry)) {
      dropped += 1;
      continue;
    }
    const id = str(entry.id);
    const text = str(entry.text);
    const from = str(entry.from);
    const at = num(entry.at);
    if (!id || !text || !from || at === undefined) {
      dropped += 1;
      continue;
    }
    comments.push({
      id,
      text,
      from,
      at,
      ...(num(entry.resolvedAt) !== undefined
        ? { resolvedAt: num(entry.resolvedAt) }
        : {}),
      ...(str(entry.parentId) ? { parentId: str(entry.parentId) } : {}),
      ...(entry.forAgent === true ? { forAgent: true } : {}),
      ...(str(entry.targetAgent)
        ? { targetAgent: str(entry.targetAgent) }
        : {}),
      ...(str(entry.frameId) ? { frameId: str(entry.frameId) } : {}),
      ...(str(entry.elementId) ? { elementId: str(entry.elementId) } : {}),
      ...(str(entry.html) ? { html: str(entry.html) } : {}),
      ...(str(entry.pageId) ? { pageId: str(entry.pageId) } : {}),
      ...(num(entry.x) !== undefined ? { x: num(entry.x) } : {}),
      ...(num(entry.y) !== undefined ? { y: num(entry.y) } : {}),
    });
  }
  if (dropped > 0 && comments.length === 0) {
    return { ok: false, detail: `all ${dropped} comments were malformed` };
  }
  return { ok: true, comments };
}

/** Three shapes the canvas pins a comment to, most specific first. */
export function anchorOf(comment: DoopComment): CommentAnchor | undefined {
  if (comment.frameId && comment.elementId) {
    return {
      kind: "element",
      frameId: comment.frameId,
      elementId: comment.elementId,
      html: comment.html ?? "",
    };
  }
  if (comment.frameId) {
    return {
      kind: "frame",
      frameId: comment.frameId,
      x: comment.x ?? 0,
      y: comment.y ?? 0,
    };
  }
  if (comment.pageId) {
    return {
      kind: "canvas",
      pageId: comment.pageId,
      x: comment.x ?? 0,
      y: comment.y ?? 0,
    };
  }
  return undefined;
}

const MAX_THREAD_DEPTH = 10;

/** Replies can point at another reply; walk up to the root the list actually holds. */
function rootOf(
  reply: DoopComment,
  byId: Map<string, DoopComment>,
): DoopComment | undefined {
  let current: DoopComment | undefined = reply;
  for (let depth = 0; depth < MAX_THREAD_DEPTH; depth += 1) {
    const parentId = current?.parentId;
    if (!parentId) return current;
    current = byId.get(parentId);
    if (!current) return undefined;
  }
  return undefined;
}

export function toWorklist(input: {
  canvasId: string;
  comments: DoopComment[];
  agentName: string;
}): Worklist {
  const { canvasId, comments, agentName } = input;
  const byId = new Map<string, DoopComment>();
  for (const comment of comments) {
    if (!byId.has(comment.id)) byId.set(comment.id, comment);
  }
  const repliesByRoot = new Map<string, DoopComment[]>();
  const roots: DoopComment[] = [];
  for (const comment of byId.values()) {
    if (!comment.parentId) {
      roots.push(comment);
      continue;
    }
    const root = rootOf(comment, byId);
    if (!root || root.parentId) continue;
    const list = repliesByRoot.get(root.id) ?? [];
    list.push(comment);
    repliesByRoot.set(root.id, list);
  }

  let skipped = 0;
  const items: WorkItem[] = [];
  for (const root of roots) {
    const replies = repliesByRoot.get(root.id) ?? [];
    const anchor = anchorOf(root);
    const others = [root, ...replies].filter((c) => c.from !== agentName);
    if (root.resolvedAt !== undefined || !anchor || others.length === 0) {
      skipped += 1;
      continue;
    }
    const item: WorkItem = {
      id: root.id,
      anchor,
      author: root.from,
      at: root.at,
      text: root.text,
      replies: replies.filter((c) => c.from !== agentName).length,
      forAgent: root.forAgent === true,
    };
    items.push(
      root.targetAgent ? { ...item, targetAgent: root.targetAgent } : item,
    );
  }
  items.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  return { canvasId, items, skipped };
}

const TEXT_LIMIT = 200;
const HTML_LIMIT = 160;

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function anchorLabel(anchor: CommentAnchor): string {
  switch (anchor.kind) {
    case "element":
      return `element ${anchor.elementId} in frame ${anchor.frameId}`;
    case "frame":
      return `frame ${anchor.frameId} at ${anchor.x},${anchor.y}`;
    case "canvas":
      return `canvas point ${anchor.pageId} ${anchor.x},${anchor.y}`;
  }
}

export function formatWorkItem(item: WorkItem, index: number): string {
  const lines = [
    `${index + 1}. comment ${item.id} — ${anchorLabel(item.anchor)} — ${item.author}${item.forAgent ? ` (@${item.targetAgent ?? "resident"})` : ""}`,
    `   ${clip(item.text, TEXT_LIMIT)}`,
  ];
  if (item.replies > 0)
    lines.push(
      `   ${item.replies} repl${item.replies === 1 ? "y" : "ies"} on this thread`,
    );
  if (item.anchor.kind === "element" && item.anchor.html) {
    lines.push(`   anchor html: ${clip(item.anchor.html, HTML_LIMIT)}`);
  }
  return lines.join("\n");
}

/** The text `/doop review` hands to the model, and the text `doop_comments` returns. */
export function formatWorklist(list: Worklist, agentName: string): string {
  const { canvasId, items, skipped } = list;
  const head = `doop canvas ${canvasId}: ${items.length} open comment${items.length === 1 ? "" : "s"}${skipped > 0 ? ` (${skipped} skipped: resolved, ours, or no usable anchor)` : ""}`;
  if (items.length === 0) {
    return `${head}\nNothing to do. Do not re-open resolved threads.`;
  }
  return [
    head,
    "",
    ...items.map((item, index) => formatWorkItem(item, index)),
    "",
    `Work them in this order. For each: locate it with get_frame, edit with edit_frame_html (or append_frame_html for a new section), then call get_frame_screenshot and fix what looks wrong. Finish the thread with reply_to_comment (say what you changed) and resolve_comment — resolving is the only thing that closes it. Pass agent_name "${agentName}" on every doop call.`,
  ].join("\n");
}

export function summarize(list: Worklist): string {
  return `${list.items.length} open${list.skipped > 0 ? ` · ${list.skipped} skipped` : ""}`;
}
