/**
 * todo-closeout — the "the run is stopping with an unfinished list" gate.
 *
 * `todo-reminder` covers drift *inside* a run: it injects on the next request.
 * A run that ends with open items never makes another request, so that channel
 * cannot reach the case this module exists for — 171 of 914 sessions that used
 * the act todo list ended with `todo`/`in_progress` items still open.
 *
 * Functional Core: every decision here is value in / value out. The shell
 * (`controller.ts`) owns the follow-up message, the UI note, and the reminder
 * cadence reset. Nothing here writes a todo, and nothing persists the ledger.
 *
 * Loop discipline: the fingerprint of the open set is the only key. Asking
 * again requires the open count to strictly drop, so "reply politely and stop"
 * cannot buy another turn. A per-list ask budget caps the cost, and the
 * give-up path speaks once through the UI instead of opening more LLM turns.
 */

import { sanitizeTodoText, selectReminderTodos } from "./todo-reminder.ts";
import type { PlanPhase, TodoItem } from "./types.ts";

/** Per-list cap on follow-up turns. Mirrors the hard cap on stop-hook loops. */
export const TODO_CLOSEOUT_MAX_ASKS = 2;

/** Consecutive turn ends with no list movement before the gate stops asking. */
export const TODO_CLOSEOUT_GIVE_UP_AFTER_STALLS = 2;

/** Cap on open items echoed in the message. */
export const TODO_CLOSEOUT_ITEM_LIMIT = 5;

/**
 * Session-scoped bookkeeping. Deliberately not persisted: a resume or a fresh
 * session starts with a fresh budget, which is the intended behavior.
 */
export type TodoCloseoutLedger = {
  /** Identifies the list this budget belongs to; a new run starts a new budget. */
  runKey: string | null;
  /** Fingerprint of the open set at the last ask; null = nothing asked yet. */
  askedFor: string | null;
  /** Open count at the last ask; the progress ruler. */
  askedOpenCount: number;
  /** Follow-up turns spent on the current list. */
  asks: number;
  /** Consecutive turn ends whose list state did not move. */
  stalls: number;
  /** Whether the one completion-claim extra ask was already used. */
  claimAskUsed: boolean;
  /** Whether the give-up note was already shown for this list. */
  notified: boolean;
};

export type TodoCloseoutBudget = {
  maxAsks: number;
  giveUpAfterStalls: number;
};

const DEFAULT_BUDGET: TodoCloseoutBudget = {
  maxAsks: TODO_CLOSEOUT_MAX_ASKS,
  giveUpAfterStalls: TODO_CLOSEOUT_GIVE_UP_AFTER_STALLS,
};

export type TodoCloseoutVariant = "initial" | "progress" | "completion-claim";

export type TodoCloseoutSilentReason =
  | "not-act"
  | "closed"
  | "same-state"
  | "no-progress"
  | "exhausted";

export type TodoCloseoutDecision =
  | {
      kind: "silent";
      reason: TodoCloseoutSilentReason;
      ledger: TodoCloseoutLedger;
    }
  | {
      kind: "ask";
      variant: TodoCloseoutVariant;
      message: string;
      ledger: TodoCloseoutLedger;
    }
  | { kind: "give-up"; note: string; ledger: TodoCloseoutLedger };

export type TodoCloseoutInput = {
  phase: PlanPhase;
  todos: readonly TodoItem[];
  ledger: TodoCloseoutLedger;
  /** Identity of the current list (active run id). A change resets the budget. */
  runKey?: string | null;
  /** Last assistant text of the run that just ended; used only to add one ask. */
  lastAssistantText: string;
  todoToolName: string;
  budget?: Partial<TodoCloseoutBudget>;
};

export const createTodoCloseoutLedger = (): TodoCloseoutLedger => ({
  runKey: null,
  askedFor: null,
  askedOpenCount: 0,
  asks: 0,
  stalls: 0,
  claimAskUsed: false,
  notified: false,
});

/**
 * `blocked` counts as settled only with a note. That keeps "someone else is
 * blocking me" expressible without letting a bare status flip silence the gate.
 * The todo tool already carries `notes`, so no schema change is needed.
 */
export const isSettledTodo = (todo: TodoItem): boolean =>
  todo.status === "done" ||
  (todo.status === "blocked" && (todo.notes ?? "").trim() !== "");

export const unsettledTodos = (todos: readonly TodoItem[]): TodoItem[] =>
  todos.filter((todo) => !isSettledTodo(todo));

/**
 * Identity of the open set: id + status, sorted by id. Text is excluded —
 * rewording an item is not progress.
 */
export const todoCloseoutFingerprint = (todos: readonly TodoItem[]): string =>
  [...todos]
    .sort((left, right) => left.id - right.id)
    .map((todo) => `${todo.id}:${todo.status}`)
    .join(",");

const COMPLETION_CLAIM_RE =
  /\b(?:done|finished|completed|all set|that'?s everything)\b|完成|做完了|搞定了/iu;

/**
 * Only ever used to add one ask, never to suppress one. A false positive costs
 * a single extra turn; a false negative would hide the exact mismatch the gate
 * exists to catch.
 */
export const claimsCompletion = (text: string): boolean =>
  COMPLETION_CLAIM_RE.test(text);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const messageText = (message: Record<string, unknown>): string => {
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string"
        ? part.text
        : "",
    )
    .join("");
};

/** Last assistant text from an `agent_end` messages payload. */
export const lastAssistantTextFromMessages = (
  messages: readonly unknown[],
): string => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isRecord(message) && message.role === "assistant") {
      return messageText(message);
    }
  }
  return "";
};

const describeOpen = (open: readonly TodoItem[], limit: number): string => {
  const { shown, hidden } = selectReminderTodos(open, limit);
  const items = shown
    .map(
      (todo) =>
        `#${todo.id} ${todo.status} ${JSON.stringify(sanitizeTodoText(todo.text))}`,
    )
    .join(", ");
  const overflow =
    hidden > 0
      ? ` (${hidden} more open item${hidden === 1 ? "" : "s"} not shown)`
      : "";
  return `${items}${overflow}`;
};

export const formatTodoCloseoutAsk = (input: {
  variant: TodoCloseoutVariant;
  open: readonly TodoItem[];
  todoToolName: string;
  limit?: number;
}): string => {
  const { variant, open, todoToolName } = input;
  const list = describeOpen(open, input.limit ?? TODO_CLOSEOUT_ITEM_LIMIT);

  if (variant === "progress") {
    return [
      "<system-reminder>",
      `The run is stopping again with ${open.length} Act TODO item${open.length === 1 ? "" : "s"} still open: ${list}.`,
      "",
      `Finish them, or mark each one "blocked" with notes: "<what stopped it>" using ${todoToolName}. ` +
        `Do not mark items done to silence this reminder; only tick what you actually finished.`,
      `Do not restate this reminder to the user.`,
      "</system-reminder>",
    ].join("\n");
  }

  if (variant === "completion-claim") {
    return [
      "<system-reminder>",
      `Your last message reports the work as finished, but the Act TODO list still shows ${list}.`,
      "",
      `Reconcile the list with that summary in one ${todoToolName} call: mark done what you actually finished, ` +
        `and mark blocked with notes whatever you did not finish. ` +
        `Do not mark items done to silence this reminder; only tick what you actually finished. ` +
        `A summary that says "done" next to an open in_progress item is exactly the mismatch this check exists to catch.`,
      `Do not restate this reminder to the user.`,
      "</system-reminder>",
    ].join("\n");
  }

  return [
    "<system-reminder>",
    `Act Mode is stopping with ${open.length} open TODO item${open.length === 1 ? "" : "s"}: ${list}.`,
    `Settle the list with one ${todoToolName} call before you stop — pick the one that is true:`,
    `- You finished it: status "done".`,
    `- You are not doing it in this run, or something blocks it: status "blocked" plus notes with one line saying why (or action "remove"/"clear" if the work is dropped).`,
    `- You are stopping mid-step and will continue later: status "blocked" plus notes with the next concrete step, so the next session resumes from a known state.`,
    `Do not mark items done to silence this reminder; only tick what you actually finished. Nothing here was changed for you.`,
    `Do not restate this reminder to the user.`,
    "</system-reminder>",
  ].join("\n");
};

export const formatTodoCloseoutGiveUpNote = (input: {
  open: readonly TodoItem[];
  limit?: number;
}): string => {
  const limit = input.limit ?? TODO_CLOSEOUT_ITEM_LIMIT;
  // Same order as the ask, so the note and the last message agree.
  const ids = selectReminderTodos(input.open, limit).shown.map(
    (todo) => `#${todo.id}`,
  );
  const extra = input.open.length - ids.length;
  const idList =
    extra > 0 ? `${ids.join(", ")} (+${extra} more)` : ids.join(", ");
  const count = input.open.length;
  return (
    `Act TODO still has ${count} open item${count === 1 ? "" : "s"} (${idList}). ` +
    "Left as-is; this check will not ask again for this list. " +
    "Close the list out with act_mode_todo to re-arm."
  );
};

const silent = (
  reason: TodoCloseoutSilentReason,
  ledger: TodoCloseoutLedger,
): TodoCloseoutDecision => ({ kind: "silent", reason, ledger: { ...ledger } });

const ask = (
  variant: TodoCloseoutVariant,
  open: readonly TodoItem[],
  input: TodoCloseoutInput,
  fingerprint: string,
  ledger: TodoCloseoutLedger,
): TodoCloseoutDecision => ({
  kind: "ask",
  variant,
  message: formatTodoCloseoutAsk({
    variant,
    open,
    todoToolName: input.todoToolName,
  }),
  ledger: {
    ...ledger,
    askedFor: fingerprint,
    askedOpenCount: open.length,
    asks: ledger.asks + 1,
    // A real answer starts a fresh stall window: progress earns the next chance.
    stalls: 0,
    claimAskUsed: ledger.claimAskUsed || variant === "completion-claim",
  },
});

const giveUpOrExhausted = (
  open: readonly TodoItem[],
  ledger: TodoCloseoutLedger,
): TodoCloseoutDecision => {
  if (ledger.notified) {
    return silent("exhausted", ledger);
  }
  return {
    kind: "give-up",
    note: formatTodoCloseoutGiveUpNote({ open }),
    ledger: { ...ledger, notified: true },
  };
};

export const decideTodoCloseout = (
  input: TodoCloseoutInput,
): TodoCloseoutDecision => {
  const budget: TodoCloseoutBudget = { ...DEFAULT_BUDGET, ...input.budget };
  const runKey = input.runKey ?? null;
  // A budget is only meaningful for the list it was spent on. Without this,
  // an exhausted budget would silence the first list of the next task.
  const ledger: TodoCloseoutLedger =
    input.ledger.runKey === runKey
      ? input.ledger
      : { ...createTodoCloseoutLedger(), runKey };

  if (input.phase !== "act") {
    return silent("not-act", ledger);
  }

  const open = unsettledTodos(input.todos);
  if (open.length === 0) {
    return silent("closed", { ...createTodoCloseoutLedger(), runKey });
  }

  if (ledger.asks >= budget.maxAsks) {
    return giveUpOrExhausted(open, ledger);
  }

  const fingerprint = todoCloseoutFingerprint(open);

  if (ledger.askedFor === null) {
    return ask("initial", open, input, fingerprint, ledger);
  }

  const sameState = ledger.askedFor === fingerprint;
  if (!sameState && open.length < ledger.askedOpenCount) {
    return ask("progress", open, input, fingerprint, ledger);
  }

  if (
    !ledger.claimAskUsed &&
    claimsCompletion(input.lastAssistantText) &&
    open.length >= ledger.askedOpenCount
  ) {
    return ask("completion-claim", open, input, fingerprint, ledger);
  }

  const stalls = ledger.stalls + 1;
  if (stalls >= budget.giveUpAfterStalls) {
    return giveUpOrExhausted(open, { ...ledger, stalls });
  }
  return silent(sameState ? "same-state" : "no-progress", {
    ...ledger,
    stalls,
  });
};
