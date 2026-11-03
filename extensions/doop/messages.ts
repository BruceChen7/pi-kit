/**
 * Pure: turn a `ServerMessage` off the canvas WebSocket into one queue item.
 *
 * The queue is what `agent_settled` drains. Nothing here talks to a socket, a
 * clock or pi — the same frame always yields the same item, so a reconnect
 * that replays a frame cannot queue it twice (`pushPending` dedupes by key).
 */

export type Pending =
  | {
      kind: "comment";
      id: string;
      from: string;
      text: string;
      frameId?: string;
    }
  | { kind: "feedback"; id: string; text: string }
  | { kind: "card"; id: string; prompt: string };

export type PendingQueue = Pending[];

export function pendingKey(item: Pending): string {
  return `${item.kind}:${item.id}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimmed(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

/**
 * `agentName` is compared case-insensitively: the canvas stores whatever name
 * the account had when it commented ("Pi"), and a case difference must not make
 * this agent wake itself up over its own reply.
 */
function isOwn(from: string, agentName: string): boolean {
  return from.toLowerCase() === agentName.toLowerCase();
}

export function pendingFromMessage(
  raw: unknown,
  agentName: string,
): Pending | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.type === "comment") {
    const comment = raw.comment;
    if (!isRecord(comment)) return undefined;
    const id = trimmed(comment.id);
    const from = trimmed(comment.from);
    const text = trimmed(comment.text);
    if (!id || !from || !text) return undefined;
    /* a reply is part of its root's thread, and the worklist already folds it
       there; queueing it here would ask for the same edit twice */
    if (trimmed(comment.parentId) !== undefined) return undefined;
    /* resolving a thread broadcasts the same comment again with resolvedAt —
       without this guard, finishing a job would start a new one */
    if (comment.resolvedAt !== undefined && comment.resolvedAt !== null) {
      return undefined;
    }
    if (isOwn(from, agentName)) return undefined;
    const frameId = trimmed(comment.frameId);
    return {
      kind: "comment",
      id,
      from,
      text,
      ...(frameId ? { frameId } : {}),
    };
  }
  if (raw.type === "feedback") {
    const feedback = raw.feedback;
    if (!isRecord(feedback)) return undefined;
    const id = trimmed(feedback.id);
    const text = trimmed(feedback.text);
    if (!id || !text) return undefined;
    return { kind: "feedback", id, text };
  }
  if (raw.type === "task") {
    const task = raw.task;
    if (!isRecord(task)) return undefined;
    const id = trimmed(task.id);
    const prompt = trimmed(task.title) ?? trimmed(task.prompt);
    if (!id || !prompt) return undefined;
    /* a card another agent already claimed, or one that ended, is not ours */
    if (trimmed(task.agentName) !== undefined) return undefined;
    if (task.endedAt !== undefined && task.endedAt !== null) return undefined;
    return { kind: "card", id, prompt };
  }
  return undefined;
}

/** Same `kind:id` never enters twice, so a replayed frame is a no-op. */
export function pushPending(queue: PendingQueue, item: Pending): PendingQueue {
  const key = pendingKey(item);
  return queue.some((existing) => pendingKey(existing) === key)
    ? queue
    : [...queue, item];
}

export function drainPending(queue: PendingQueue): {
  items: Pending[];
  rest: PendingQueue;
} {
  return { items: queue, rest: [] };
}

const TEXT_LIMIT = 300;

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > TEXT_LIMIT ? `${flat.slice(0, TEXT_LIMIT - 1)}…` : flat;
}

function describe(item: Pending): string {
  if (item.kind === "comment") {
    const where = item.frameId ? ` on frame ${item.frameId}` : "";
    return `- comment ${item.id}${where} — ${item.from}: ${clip(item.text)}`;
  }
  if (item.kind === "feedback") {
    return `- feedback ${item.id}: ${clip(item.text)}`;
  }
  return `- card ${item.id}: ${clip(item.prompt)}`;
}

/** The message `agent_settled` hands the model when the canvas has news. */
export function formatWake(items: PendingQueue, canvasId: string): string {
  const count = items.length;
  if (count === 0) return `doop canvas ${canvasId}: nothing to do.`;
  return [
    `doop canvas ${canvasId} pushed ${count} item${count === 1 ? "" : "s"} while you were busy:`,
    "",
    ...items.map(describe),
    "",
    "Comments: read the thread with get_comments, fix the frame, then reply_to_comment and resolve_comment — resolving is what closes it. Pass agent_name on every doop call.",
    "Cards: treat the prompt as the request, design it, and leave the frame ready for review.",
  ].join("\n");
}
