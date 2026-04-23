import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import {
  getTodoCompletionArgumentCompletions,
  handleTodoCompletionCommand,
} from "./completion.js";
import {
  buildTodoCreatedMessage,
  buildTodoStartedMessage,
  chooseTodoAction,
  getCurrentSessionActiveTodo,
  listOpenTodos,
  promptForNewTodoDescription,
  showTodoPicker,
} from "./interactions.js";
import {
  createTodoFromDescription,
  handleListTodos,
  handleRemoveTodo,
  handleResumeTodoById,
  handleShowTodo,
  handleStartTodoById,
  resumeTodo,
  startTodo,
} from "./lifecycle.js";
import { findTodoById, loadTodoStore } from "./todo-store.js";

export type TodoCommand =
  | { kind: "menu" }
  | { kind: "add"; description: string; startNow: boolean }
  | { kind: "list" }
  | { kind: "show"; id: string }
  | { kind: "remove"; id: string }
  | { kind: "start"; id: string }
  | { kind: "resume"; id: string }
  | { kind: "finish"; id?: string }
  | { kind: "cleanup-one"; id?: string }
  | { kind: "cleanup-all" }
  | { kind: "delegate-end"; rawArgs: string }
  | { kind: "usage-error"; message: string }
  | { kind: "unknown" };

function parseAddTodoArgs(rawArgs: string): {
  description: string;
  startNow: boolean;
} | null {
  const tokens = rawArgs.trim().split(/\s+/).filter(Boolean);
  if (tokens[0] !== "add") {
    return null;
  }

  const startNow = tokens.includes("--start");
  const description = tokens
    .slice(1)
    .filter((token) => token !== "--start")
    .join(" ")
    .trim();
  if (!description) {
    return null;
  }

  return {
    description,
    startNow,
  };
}

export function parseTodoCommand(rawArgs: string): TodoCommand {
  const trimmed = rawArgs.trim();
  if (!trimmed) {
    return { kind: "menu" };
  }

  const addArgs = parseAddTodoArgs(trimmed);
  if (addArgs) {
    return {
      kind: "add",
      description: addArgs.description,
      startNow: addArgs.startNow,
    };
  }

  if (trimmed.startsWith("add")) {
    return {
      kind: "usage-error",
      message: "Usage: /todo add [--start] <description>",
    };
  }

  if (trimmed === "list") {
    return { kind: "list" };
  }
  if (trimmed.startsWith("show ")) {
    return { kind: "show", id: trimmed.slice(5).trim() };
  }
  if (trimmed.startsWith("remove ")) {
    return { kind: "remove", id: trimmed.slice(7).trim() };
  }
  if (trimmed.startsWith("start ")) {
    return { kind: "start", id: trimmed.slice(6).trim() };
  }
  if (trimmed.startsWith("resume ")) {
    return { kind: "resume", id: trimmed.slice(7).trim() };
  }

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const [command, value, extra] = tokens;
  if (command === "finish") {
    if (extra) {
      return { kind: "delegate-end", rawArgs: trimmed };
    }
    return { kind: "finish", id: value };
  }
  if (command === "cleanup") {
    if (value === "--all" && !extra) {
      return { kind: "cleanup-all" };
    }
    if (extra) {
      return { kind: "delegate-end", rawArgs: trimmed };
    }
    return { kind: "cleanup-one", id: value };
  }

  return { kind: "unknown" };
}

function parseCompletionPrefix(argumentPrefix: string): {
  tokens: string[];
  current: string;
} {
  const hasTrailingSpace = /\s$/.test(argumentPrefix);
  const trimmed = argumentPrefix.trim();
  if (!trimmed) {
    return { tokens: [], current: "" };
  }

  const parts = trimmed.split(/\s+/);
  if (hasTrailingSpace) {
    return { tokens: parts, current: "" };
  }

  const current = parts.pop() ?? "";
  return { tokens: parts, current };
}

function filterCompletionItems(
  items: AutocompleteItem[],
  current: string,
): AutocompleteItem[] {
  if (!current) {
    return items;
  }

  const lower = current.toLowerCase();
  return items.filter(
    (item) =>
      item.value.toLowerCase().startsWith(lower) ||
      item.label.toLowerCase().includes(lower),
  );
}

export function getStaticTodoCommandCompletionItems(): AutocompleteItem[] {
  return [
    {
      value: "add",
      label: "add",
      description: "create a new todo",
    },
    {
      value: "start",
      label: "start",
      description: "start a queued todo",
    },
    {
      value: "resume",
      label: "resume",
      description: "resume a doing todo",
    },
    {
      value: "finish",
      label: "finish",
      description: "finish a doing todo",
    },
    {
      value: "cleanup",
      label: "cleanup",
      description: "cleanup merged todo resources",
    },
    {
      value: "remove",
      label: "remove",
      description: "remove a todo",
    },
    {
      value: "list",
      label: "list",
      description: "list todos",
    },
    {
      value: "show",
      label: "show",
      description: "show todo details",
    },
  ];
}

function toTodoCompletionItem(todo: {
  id: string;
  description: string;
  status: string;
  workBranch?: string;
}): AutocompleteItem {
  return {
    value: todo.id,
    label: `${todo.description} [${todo.id}]`,
    description:
      todo.status === "doing"
        ? todo.workBranch
          ? `doing • ${todo.workBranch}`
          : "doing"
        : todo.status,
  };
}

export async function getTodoArgumentCompletions(
  pi: ExtensionAPI,
  argumentPrefix: string,
): Promise<AutocompleteItem[] | null> {
  const { tokens, current } = parseCompletionPrefix(argumentPrefix);
  if (tokens.length === 0) {
    return filterCompletionItems(
      getStaticTodoCommandCompletionItems(),
      current,
    );
  }

  const [command] = tokens;
  if (command === "finish" || command === "cleanup") {
    return getTodoCompletionArgumentCompletions(pi, argumentPrefix);
  }

  if (
    (command === "start" ||
      command === "resume" ||
      command === "show" ||
      command === "remove") &&
    tokens.length === 1
  ) {
    const todos = loadTodoStore(process.cwd()).todos;
    return filterCompletionItems(todos.map(toTodoCompletionItem), current);
  }

  return null;
}

async function promptForNewTodo(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const description = await promptForNewTodoDescription(ctx);
  if (!description) {
    return;
  }

  const todo = await createTodoFromDescription(ctx, description);
  ctx.ui.notify(buildTodoCreatedMessage(todo), "info");

  const shouldStart = await ctx.ui.confirm(
    `Start TODO "${todo.description}" now?`,
    `id: ${todo.id}`,
  );
  if (!shouldStart) {
    return;
  }

  const started = await startTodo(pi, ctx, todo);
  if (started) {
    started.sessionCtx.ui.notify(buildTodoStartedMessage(started.todo), "info");
  }
}

async function handleTodoMenu(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("todo requires interactive mode", "warning");
    return;
  }

  const openTodos = listOpenTodos(ctx);
  if (openTodos.length === 0) {
    await promptForNewTodo(pi, ctx);
    return;
  }

  const action = await chooseTodoAction(ctx);
  if (!action) {
    return;
  }

  if (action === "add-new") {
    await promptForNewTodo(pi, ctx);
    return;
  }

  if (action === "resume-current") {
    const currentTodo = getCurrentSessionActiveTodo(ctx);
    if (!currentTodo) {
      ctx.ui.notify("No current TODO found", "warning");
      return;
    }
    await resumeTodo(pi, ctx, currentTodo);
    return;
  }

  const queuedTodos = openTodos.filter((todo) => todo.status === "todo");
  if (queuedTodos.length === 0) {
    ctx.ui.notify("No queued TODOs found", "warning");
    return;
  }

  const nextTodoId =
    queuedTodos.length === 1
      ? (queuedTodos[0]?.id ?? null)
      : await showTodoPicker(ctx, queuedTodos, "No queued TODOs found");
  if (!nextTodoId) {
    return;
  }

  const nextTodo = findTodoById(ctx.cwd, nextTodoId);
  if (!nextTodo) {
    ctx.ui.notify(`Unknown TODO: ${nextTodoId}`, "error");
    return;
  }

  await startTodo(pi, ctx, nextTodo);
}

export async function handleTodoCommand(
  pi: ExtensionAPI,
  rawArgs: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const trimmed = rawArgs.trim();
  const command = parseTodoCommand(rawArgs);

  switch (command.kind) {
    case "add": {
      const todo = await createTodoFromDescription(ctx, command.description);
      ctx.ui.notify(buildTodoCreatedMessage(todo), "info");

      if (!command.startNow) {
        return;
      }

      const started = await startTodo(pi, ctx, todo);
      if (started) {
        started.sessionCtx.ui.notify(
          buildTodoStartedMessage(started.todo),
          "info",
        );
      }
      return;
    }
    case "list":
      await handleListTodos(ctx);
      return;
    case "show":
      await handleShowTodo(ctx, command.id);
      return;
    case "remove":
      await handleRemoveTodo(ctx, command.id);
      return;
    case "start":
      await handleStartTodoById(pi, ctx, command.id);
      return;
    case "resume":
      await handleResumeTodoById(pi, ctx, command.id);
      return;
    case "finish":
    case "cleanup-one":
    case "cleanup-all":
      await handleTodoCompletionCommand(pi, trimmed, ctx);
      return;
    case "delegate-end":
      await handleTodoCompletionCommand(pi, command.rawArgs, ctx);
      return;
    case "usage-error":
      ctx.ui.notify(command.message, "warning");
      return;
    case "unknown":
      ctx.ui.notify("Unknown /todo action", "warning");
      return;
    case "menu":
      await handleTodoMenu(pi, ctx);
      return;
  }
}
