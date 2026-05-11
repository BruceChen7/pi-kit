import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
  buildTodoArgumentCompletionItem,
  filterCompletionItems,
  filterTodosForCommand,
  parseCompletionPrefix,
} from "./autocomplete.js";
import {
  getTopLevelTodoCommandItems,
  isTodoCompletionActionCommand,
  isTodoIdArgumentCommand,
  TODO_DIRECT_ID_COMMAND_SPECS,
} from "./commands.js";
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
import { findTodoById, loadTodoStore, type TodoItem } from "./todo-store.js";

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

  for (const spec of TODO_DIRECT_ID_COMMAND_SPECS) {
    const prefix = `${spec.command} `;
    if (trimmed.startsWith(prefix)) {
      return { kind: spec.kind, id: trimmed.slice(prefix.length).trim() };
    }
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

export function getStaticTodoCommandCompletionItems(): AutocompleteItem[] {
  return getTopLevelTodoCommandItems();
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
  if (isTodoCompletionActionCommand(command)) {
    return getTodoCompletionArgumentCompletions(pi, argumentPrefix);
  }

  if (isTodoIdArgumentCommand(command) && tokens.length === 1) {
    return filterCompletionItems(
      filterTodosForCommand(command, loadTodoStore(process.cwd()).todos).map(
        (todo) => buildTodoArgumentCompletionItem(command, todo),
      ),
      current,
    );
  }

  return null;
}

async function startCreatedTodo(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  todo: TodoItem,
): Promise<void> {
  const started = await startTodo(pi, ctx, todo);
  if (started) {
    started.sessionCtx.ui.notify(buildTodoStartedMessage(started.todo), "info");
  }
}

type TodoUiWithOptionalConfirm = ExtensionCommandContext["ui"] & {
  confirm?: ExtensionCommandContext["ui"]["confirm"];
};

async function confirmStartCreatedTodo(
  ctx: ExtensionCommandContext,
  todo: TodoItem,
): Promise<boolean> {
  const { confirm } = ctx.ui as TodoUiWithOptionalConfirm;
  if (!ctx.hasUI || !confirm) {
    return false;
  }

  return confirm(`Start TODO "${todo.description}" now?`, `id: ${todo.id}`);
}

async function createTodoAndMaybeStart(input: {
  pi: ExtensionAPI;
  ctx: ExtensionCommandContext;
  description: string;
  startNow: boolean;
}): Promise<void> {
  const todo = await createTodoFromDescription(input.ctx, input.description);
  input.ctx.ui.notify(buildTodoCreatedMessage(todo), "info");

  if (!input.startNow && !(await confirmStartCreatedTodo(input.ctx, todo))) {
    return;
  }

  await startCreatedTodo(input.pi, input.ctx, todo);
}

async function promptForNewTodo(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const description = await promptForNewTodoDescription(ctx);
  if (!description) {
    return;
  }

  await createTodoAndMaybeStart({
    pi,
    ctx,
    description,
    startNow: false,
  });
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
    case "add":
      await createTodoAndMaybeStart({
        pi,
        ctx,
        description: command.description,
        startNow: command.startNow,
      });
      return;
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
