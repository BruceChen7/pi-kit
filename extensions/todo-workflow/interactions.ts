import type {
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import {
  type Component,
  Container,
  type SelectItem,
  SelectList,
  Text,
  truncateToWidth,
} from "@mariozechner/pi-tui";

import { isStaleSessionContextError } from "../shared/stale-context.js";
import {
  formatTodoLabel,
  formatTodoListLine,
  formatTodoStatus,
} from "./display.js";
import { listTodos, type TodoItem } from "./todo-store.js";

export type TodoSessionContext = Pick<
  ExtensionContext,
  "cwd" | "ui" | "sessionManager"
>;

export type TodoAction = "resume-current" | "start-queued" | "add-new";

const STATUS_KEY = "todo-workflow";
const WIDGET_KEY = STATUS_KEY;
const TODO_WIDGET_OPTIONS = { placement: "aboveEditor" as const };

export function getSessionKey(ctx: TodoSessionContext): string {
  const sessionFile = ctx.sessionManager.getSessionFile();
  return typeof sessionFile === "string" && sessionFile.trim()
    ? sessionFile.trim()
    : `cwd:${ctx.cwd}`;
}

export function pickCurrentSessionTodo(
  todos: TodoItem[],
  sessionKey: string,
): TodoItem | null {
  return (
    todos.find(
      (todo) => todo.status === "doing" && todo.activeSessionKey === sessionKey,
    ) ??
    todos.find((todo) => todo.status === "doing") ??
    null
  );
}

export function listOpenTodos(ctx: TodoSessionContext): TodoItem[] {
  return listTodos(ctx.cwd, {
    includeDone: false,
    sessionKey: getSessionKey(ctx),
  });
}

export function getCurrentSessionActiveTodo(
  ctx: TodoSessionContext,
): TodoItem | null {
  return pickCurrentSessionTodo(listOpenTodos(ctx), getSessionKey(ctx));
}

type TodoWidgetTheme = {
  fg(color: string, text: string): string;
  bg?: (color: string, text: string) => string;
};

type TodoWidgetFactory = (tui: unknown, theme: TodoWidgetTheme) => Component;

function buildTodoWidget(todo: TodoItem): TodoWidgetFactory {
  return (_tui, theme) => ({
    render(width: number): string[] {
      const marker = theme.fg("accent", "▌ TODO");
      const details = theme.fg(
        "muted",
        `  ${todo.description}  •  ${todo.workBranch ?? todo.id}`,
      );
      const line = truncateToWidth(`${marker}${details}`, width);
      return [theme.bg ? theme.bg("toolPendingBg", line) : line];
    },
    invalidate(): void {
      // Stateless; theme is applied during render.
    },
  });
}

type TodoUiWithOptionalWidget = TodoSessionContext["ui"] & {
  setWidget?: (
    key: string,
    content?: TodoWidgetFactory,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ) => void;
};

export function updateTodoStatus(
  ctx: TodoSessionContext,
  todo: TodoItem | null,
): void {
  try {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    const ui = ctx.ui as TodoUiWithOptionalWidget;
    if (typeof ui.setWidget !== "function") {
      return;
    }

    if (!todo) {
      ui.setWidget(WIDGET_KEY, undefined);
      return;
    }

    ui.setWidget(WIDGET_KEY, buildTodoWidget(todo), TODO_WIDGET_OPTIONS);
  } catch (error) {
    if (!isStaleSessionContextError(error)) {
      throw error;
    }
  }
}

export function restoreTodoStatus(ctx: TodoSessionContext): void {
  updateTodoStatus(ctx, getCurrentSessionActiveTodo(ctx));
}

export async function showTodoPicker(
  ctx: ExtensionCommandContext,
  todos = listOpenTodos(ctx),
  emptyMessage = "No TODOs found. Use /todo add <description> to create one.",
): Promise<string | null> {
  if (todos.length === 0) {
    ctx.ui.notify(emptyMessage, "info");
    return null;
  }

  const items: SelectItem[] = todos.map((todo) => ({
    value: todo.id,
    label: formatTodoLabel(todo),
    description: formatTodoStatus(todo),
  }));

  return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
    const title =
      typeof theme.bold === "function"
        ? theme.bold("Project TODOs")
        : "Project TODOs";
    container.addChild(new Text(theme.fg("accent", title)));

    const selectList = new SelectList(items, Math.min(items.length, 10), {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    });

    selectList.onSelect = (item) => done(item.value);
    selectList.onCancel = () => done(null);

    container.addChild(selectList);
    container.addChild(
      new Text(theme.fg("dim", "j/k navigate • enter select • esc cancel")),
    );
    container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

    return {
      render(width: number): string[] {
        return container.render(width);
      },
      invalidate(): void {
        container.invalidate();
      },
      handleInput(data: string): void {
        if (data === "j") {
          selectList.handleInput("down");
        } else if (data === "k") {
          selectList.handleInput("up");
        } else {
          selectList.handleInput(data);
        }
        tui.requestRender();
      },
    };
  });
}

export function buildTodoActionOptions(input: {
  hasCurrentTodo: boolean;
  hasQueuedTodo: boolean;
}): Array<{ label: string; value: TodoAction }> {
  const options: Array<{ label: string; value: TodoAction }> = [];
  if (input.hasCurrentTodo) {
    options.push({
      label: "Resume current TODO",
      value: "resume-current",
    });
  }
  if (input.hasQueuedTodo) {
    options.push({
      label: "Start a queued TODO",
      value: "start-queued",
    });
  }
  options.push({
    label: "Add a new TODO",
    value: "add-new",
  });
  return options;
}

export async function chooseTodoAction(
  ctx: ExtensionCommandContext,
): Promise<TodoAction | null> {
  const options = buildTodoActionOptions({
    hasCurrentTodo: Boolean(getCurrentSessionActiveTodo(ctx)),
    hasQueuedTodo: listOpenTodos(ctx).some((todo) => todo.status === "todo"),
  });

  const choice = await ctx.ui.select(
    "TODO actions",
    options.map((option) => option.label),
  );
  if (!choice) {
    ctx.ui.notify("Cancelled", "info");
    return null;
  }

  return options.find((option) => option.label === choice)?.value ?? null;
}

export async function promptForNewTodoDescription(
  ctx: ExtensionCommandContext,
): Promise<string | null> {
  const description = (await ctx.ui.input("New TODO:", ""))?.trim();
  if (!description) {
    ctx.ui.notify("Cancelled", "info");
    return null;
  }
  return description;
}

export function buildTodoCreatedMessage(todo: TodoItem): string {
  return `Added TODO: "${todo.description}" [${todo.id}]`;
}

export function buildTodoStartedMessage(todo: TodoItem): string {
  return `Started TODO: "${todo.description}" [${todo.id}] • branch ${todo.workBranch ?? todo.id}`;
}

export function buildTodoDetailsMessage(todo: TodoItem): string {
  return [
    `id: ${todo.id}`,
    `description: ${todo.description}`,
    `status: ${todo.status}`,
    todo.sourceBranch ? `source branch: ${todo.sourceBranch}` : null,
    todo.workBranch ? `work branch: ${todo.workBranch}` : null,
    todo.worktreePath ? `worktree: ${todo.worktreePath}` : null,
    `created at: ${todo.createdAt}`,
    `updated at: ${todo.updatedAt}`,
    todo.startedAt ? `started at: ${todo.startedAt}` : null,
    todo.completedAt ? `completed at: ${todo.completedAt}` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function buildTodoListMessage(todos: TodoItem[]): string {
  return todos.map((todo) => `- ${formatTodoListLine(todo)}`).join("\n");
}
