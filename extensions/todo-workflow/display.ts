import type { TodoItem } from "./todo-store.js";

export function formatTodoStatus(todo: TodoItem): string {
  if (todo.status === "doing") {
    return todo.workBranch ? `doing • ${todo.workBranch}` : "doing";
  }
  if (todo.status === "done") {
    return "done";
  }
  return "todo";
}

export function formatTodoLabel(todo: TodoItem): string {
  return `${todo.description} [${todo.id}]`;
}

export function formatTodoSelectionLabel(todo: TodoItem): string {
  return `${formatTodoLabel(todo)} • ${formatTodoStatus(todo)}`;
}

export function formatTodoListLine(todo: TodoItem): string {
  return formatTodoSelectionLabel(todo);
}
