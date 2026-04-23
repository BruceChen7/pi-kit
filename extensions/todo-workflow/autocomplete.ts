import type { AutocompleteItem } from "@mariozechner/pi-tui";

import { formatTodoLabel, formatTodoStatus } from "./display.js";
import type { TodoItem } from "./todo-store.js";

export type ParsedCompletionPrefix = {
  tokens: string[];
  current: string;
};

export function parseCompletionPrefix(
  argumentPrefix: string,
): ParsedCompletionPrefix {
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

export function filterCompletionItems(
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

export function buildTodoArgumentCompletionValue(
  command: string,
  value: string,
): string {
  return `${command} ${value}`;
}

export function buildTodoArgumentCompletionItem(
  command: string,
  todo: TodoItem,
): AutocompleteItem {
  return {
    value: buildTodoArgumentCompletionValue(command, todo.id),
    label: formatTodoLabel(todo),
    description: formatTodoStatus(todo),
  };
}

export function buildLiteralArgumentCompletionItem(
  command: string,
  value: string,
  description?: string,
): AutocompleteItem {
  return {
    value: buildTodoArgumentCompletionValue(command, value),
    label: value,
    description,
  };
}

export function filterTodosForCommand(
  command: string,
  todos: TodoItem[],
): TodoItem[] {
  if (command === "start") {
    return todos.filter((todo) => todo.status === "todo");
  }
  if (command === "resume" || command === "finish") {
    return todos.filter((todo) => todo.status === "doing");
  }

  return todos;
}
