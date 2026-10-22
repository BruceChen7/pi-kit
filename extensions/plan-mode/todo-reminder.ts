/**
 * todo-reminder — the "the agent stopped following the list" detector.
 *
 * Functional Core: every decision here is value in / value out. The shell
 * (`index.ts`) feeds host events in and, when `drainTodoReminderForContext`
 * says so, appends the returned text to the next LLM request via the
 * `context` hook. Nothing is persisted: the reminder exists for exactly one
 * request.
 *
 * Why a runtime channel instead of more prompt text: the discipline is
 * already written into the tool guidelines, and a static sentence in the
 * system prompt stops being visible as soon as the run goes long. This is the
 * structural version of the same instruction.
 */

import { ACT_TODO_TOOL_NAME, TODO_TOOL_NAME } from "./constants.ts";
import type { TodoItem, TodoStatus } from "./types.ts";

export type TodoReminderReason = "idle" | "stale";

/** Turns without a todo tool call before an idle reminder is due. */
export const TODO_REMINDER_IDLE_INTERVAL = 4;

/** Shorter interval while something is declared in_progress. */
export const TODO_REMINDER_ACTIVE_INTERVAL = 2;

/** Cap on echoed items, to bound the reminder's size on long lists. */
export const TODO_REMINDER_ITEM_LIMIT = 10;

/** Tool calls that count as "the agent touched the list" and reset cadence. */
export const TODO_REMINDER_TOOL_NAMES: ReadonlySet<string> = new Set([
  TODO_TOOL_NAME,
  ACT_TODO_TOOL_NAME,
]);

export type TodoReminderCadence = {
  turn: number;
  lastTodoToolTurn: number;
  injectedThisCycle: boolean;
  due: boolean;
  reason: TodoReminderReason | null;
};

export const createTodoReminderCadence = (): TodoReminderCadence => ({
  turn: 0,
  lastTodoToolTurn: 0,
  injectedThisCycle: false,
  due: false,
  reason: null,
});

export const resetTodoReminderCadence = (
  cadence: TodoReminderCadence,
): void => {
  cadence.turn = 0;
  cadence.lastTodoToolTurn = 0;
  cadence.injectedThisCycle = false;
  cadence.due = false;
  cadence.reason = null;
};

export const onTurnStart = (cadence: TodoReminderCadence): void => {
  cadence.turn += 1;
};

const reminderInterval = (hasInProgress: boolean): number =>
  hasInProgress ? TODO_REMINDER_ACTIVE_INTERVAL : TODO_REMINDER_IDLE_INTERVAL;

const markDue = (
  cadence: TodoReminderCadence,
  reason: TodoReminderReason,
): void => {
  cadence.due = true;
  cadence.reason = reason;
};

export type TodoToolResultInput = {
  toolName: string;
  hasTodos: boolean;
  hasInProgress: boolean;
};

/**
 * Record one tool result. A todo tool resets the window; any other tool only
 * arms the reminder once the window has elapsed, so an agent that is reading
 * files for two turns is left alone.
 */
export const noteToolResult = (
  cadence: TodoReminderCadence,
  result: TodoToolResultInput,
): void => {
  if (TODO_REMINDER_TOOL_NAMES.has(result.toolName)) {
    cadence.lastTodoToolTurn = cadence.turn;
    cadence.injectedThisCycle = false;
    cadence.due = false;
    cadence.reason = null;
    return;
  }
  if (cadence.injectedThisCycle || cadence.due || !result.hasTodos) {
    return;
  }
  if (
    cadence.turn - cadence.lastTodoToolTurn <
    reminderInterval(result.hasInProgress)
  ) {
    return;
  }
  markDue(cadence, "idle");
};

export type TodoTurnEndInput = {
  /** Tool results produced by the turn that just ended. */
  toolResultCount: number;
  hasInProgress: boolean;
};

/**
 * A text-only turn that leaves work in_progress is the failure this whole
 * module exists for: the agent answered, so no tool_result will ever fire and
 * the idle window would miss it.
 */
export const noteTurnEnd = (
  cadence: TodoReminderCadence,
  input: TodoTurnEndInput,
): void => {
  if (cadence.injectedThisCycle || input.toolResultCount > 0) {
    return;
  }
  if (!input.hasInProgress) {
    return;
  }
  markDue(cadence, "stale");
};

/** Drain the pending reminder. True means "inject now, and not again this cycle". */
export const drainTodoReminderForContext = (
  cadence: TodoReminderCadence,
): boolean => {
  if (!cadence.due) {
    return false;
  }
  cadence.due = false;
  cadence.injectedThisCycle = true;
  cadence.lastTodoToolTurn = cadence.turn;
  return true;
};

const STATUS_RANK: Record<TodoStatus, number> = {
  in_progress: 0,
  todo: 1,
  blocked: 2,
  done: 3,
};

export type ReminderSelection = {
  shown: TodoItem[];
  hidden: number;
};

/**
 * Open items only: the reminder exists to surface unfinished work, so
 * completed items are dropped before the cap is applied. Ties keep list order
 * (`Array.prototype.sort` is stable).
 */
export const selectReminderTodos = (
  todos: readonly TodoItem[],
  limit: number = TODO_REMINDER_ITEM_LIMIT,
): ReminderSelection => {
  const open = todos.filter((todo) => todo.status !== "done");
  if (open.length <= limit) {
    return { shown: [...open], hidden: 0 };
  }
  const shown = [...open]
    .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status])
    .slice(0, limit);
  return { shown, hidden: open.length - shown.length };
};

const sanitizeTodoText = (text: string): string =>
  text
    .replace(/[\r\n]+/gu, " ")
    .replace(/<\/?system-reminder>/giu, "")
    .trim();

const findInProgress = (todos: readonly TodoItem[]): TodoItem[] =>
  todos.filter((todo) => todo.status === "in_progress");

export type BuildTodoReminderInput = {
  todos: readonly TodoItem[];
  reason: TodoReminderReason;
  toolName: string;
  limit?: number;
};

/**
 * Build the transient reminder body, or `undefined` when there is no open
 * work to remind about. The list is echoed as JSON so the agent gets the ids
 * and statuses without spending a tool call on `list`.
 */
export const buildTodoReminder = (
  input: BuildTodoReminderInput,
): string | undefined => {
  const { shown, hidden } = selectReminderTodos(input.todos, input.limit);
  if (shown.length === 0) {
    return undefined;
  }

  const payload = shown.map((todo) => ({
    id: todo.id,
    text: sanitizeTodoText(todo.text),
    status: todo.status,
  }));
  const overflow =
    hidden > 0
      ? ` (${hidden} more open item${hidden === 1 ? "" : "s"} not shown)`
      : "";
  const inProgress = findInProgress(shown);

  const header =
    input.reason === "stale"
      ? "Your last turn ended without a tool call, but the list still has work marked in_progress. Here is its current state:"
      : "The todo list has not been updated recently. Here is its current state:";

  const lines = [
    "<system-reminder>",
    header,
    "",
    `${JSON.stringify(payload)}${overflow}`,
    "",
  ];

  const active = inProgress[0];
  if (inProgress.length > 1) {
    lines.push(
      `Multiple items are in_progress (${inProgress
        .map((todo) => `#${todo.id}`)
        .join(", ")}). Keep one and set the others back to todo.`,
    );
  } else if (active) {
    lines.push(
      `You are on #${active.id} ${sanitizeTodoText(active.text)}. ` +
        `Mark it done with ${input.toolName} when it is finished, then start the next item.`,
    );
  } else {
    const next = shown.find((todo) => todo.status === "todo");
    if (next) {
      lines.push(
        `Next step: #${next.id} ${sanitizeTodoText(next.text)}. ` +
          `Mark it in_progress with ${input.toolName} before starting it, ` +
          "and mark the finished step done in the same call.",
      );
    }
  }

  lines.push("Do not restate this reminder to the user.");
  lines.push("</system-reminder>");
  return lines.join("\n");
};
