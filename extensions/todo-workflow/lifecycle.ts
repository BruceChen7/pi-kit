import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";

import { maybeSwitchToWorktreeSession } from "../feature-workflow/commands/shared.js";
import {
  preflightFeatureStart,
  startPreparedFeatureWorkflow,
} from "../feature-workflow/start-feature.js";
import type { FeatureRecord } from "../feature-workflow/storage.js";
import { generateKebabCaseIdFromDescription } from "../shared/ai.js";
import { runWithWorkingLoader } from "../shared/ui-working.js";
import {
  confirmTodoWorktreeReady,
  ensureTodoWorktreeReady,
  getCurrentBranch,
} from "./completion.js";
import { formatTodoLabel } from "./display.js";
import {
  buildTodoDetailsMessage,
  buildTodoListMessage,
  getSessionKey,
  type TodoSessionContext,
  updateTodoStatus,
} from "./interactions.js";
import {
  createTodo,
  createUniqueTodoId,
  findTodoById,
  listTodos,
  loadTodoStore,
  removeTodo,
  type TodoItem,
  updateTodoActivation,
  updateTodoStart,
} from "./todo-store.js";

function activateTodoForSession(ctx: TodoSessionContext, todo: TodoItem): void {
  const activated = updateTodoActivation(ctx.cwd, {
    id: todo.id,
    sessionKey: getSessionKey(ctx),
    activeInSession: true,
  });
  updateTodoStatus(ctx, activated);
  ctx.ui.notify(`doing: ${activated.description}`, "info");
}

function buildTodoFeatureRecord(
  todo: TodoItem,
  worktreePath: string,
): FeatureRecord {
  return {
    slug: todo.id,
    branch: todo.workBranch ?? todo.id,
    worktreePath,
    status: "active",
    createdAt: todo.startedAt ?? todo.createdAt,
    updatedAt: new Date().toISOString(),
  };
}

async function switchToTodoWorktreeSession(
  ctx: ExtensionCommandContext,
  todo: TodoItem,
  worktreePath: string,
  beforeSwitch?: () => void | Promise<void>,
): Promise<boolean> {
  const switchResult = await maybeSwitchToWorktreeSession({
    ctx,
    record: buildTodoFeatureRecord(todo, worktreePath),
    worktreePath,
    enabled: true,
    beforeSwitch,
    onSwitched: async (replacementCtx) => {
      activateTodoForSession(replacementCtx, todo);
    },
  });

  if (
    switchResult.switched ||
    switchResult.skipReason === "ephemeral-session"
  ) {
    return true;
  }

  if (switchResult.skipReason === "cancelled") {
    ctx.ui.notify("Cancelled", "info");
  }

  return false;
}

export async function createTodoFromDescription(
  ctx: ExtensionCommandContext,
  description: string,
): Promise<TodoItem> {
  const aiId = await generateKebabCaseIdFromDescription(ctx, description);
  const todoId = aiId
    ? createUniqueTodoId(aiId, loadTodoStore(ctx.cwd).todos)
    : undefined;
  return createTodo(ctx.cwd, description, { id: todoId });
}

export async function startTodo(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  todo: TodoItem,
): Promise<{ sessionCtx: TodoSessionContext; todo: TodoItem } | null> {
  const sourceBranch = await getCurrentBranch(pi, ctx);
  if (!sourceBranch) {
    ctx.ui.notify("Failed to detect current branch", "error");
    return null;
  }

  const prepared = preflightFeatureStart({ pi, ctx });
  if (!prepared) {
    return null;
  }

  const startResult = await runWithWorkingLoader(ctx, ({ dismiss }) =>
    startPreparedFeatureWorkflow({
      ctx,
      runtime: prepared.runtime,
      slug: todo.id,
      base: sourceBranch,
      beforeSessionSwitch: dismiss,
    }),
  );
  if (!startResult.ok) {
    return null;
  }

  const sessionCtx = startResult.replacementCtx ?? ctx;
  const started = updateTodoStart(sessionCtx.cwd, {
    id: todo.id,
    sourceBranch,
    workBranch: startResult.record.branch,
    worktreePath: startResult.record.worktreePath,
  });
  activateTodoForSession(sessionCtx, started);
  return {
    sessionCtx,
    todo: started,
  };
}

export async function resumeTodo(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  todo: TodoItem,
): Promise<void> {
  const confirmed = await confirmTodoWorktreeReady(ctx, todo);
  if (!confirmed) {
    return;
  }

  const switched = await runWithWorkingLoader(ctx, async ({ dismiss }) => {
    const ensured = await ensureTodoWorktreeReady(pi, ctx, todo);
    if (!ensured.ok) {
      return false;
    }

    return switchToTodoWorktreeSession(
      ctx,
      todo,
      ensured.worktreePath,
      dismiss,
    );
  });
  if (!switched) {
    return;
  }
}

function findTodoOrNotify(
  ctx: ExtensionCommandContext,
  id: string,
): TodoItem | null {
  const todo = findTodoById(ctx.cwd, id);
  if (!todo) {
    ctx.ui.notify(`Unknown TODO: ${id}`, "error");
    return null;
  }
  return todo;
}

export async function handleListTodos(
  ctx: ExtensionCommandContext,
): Promise<void> {
  const todos = listTodos(ctx.cwd, {
    includeDone: true,
    sessionKey: getSessionKey(ctx),
  });
  if (todos.length === 0) {
    ctx.ui.notify("No TODOs found", "info");
    return;
  }

  ctx.ui.notify(buildTodoListMessage(todos), "info");
}

export async function handleShowTodo(
  ctx: ExtensionCommandContext,
  id: string,
): Promise<void> {
  const todo = findTodoOrNotify(ctx, id);
  if (!todo) {
    return;
  }

  ctx.ui.notify(buildTodoDetailsMessage(todo), "info");
}

export async function handleRemoveTodo(
  ctx: ExtensionCommandContext,
  id: string,
): Promise<void> {
  const todo = findTodoOrNotify(ctx, id);
  if (!todo) {
    return;
  }

  if (todo.status === "doing") {
    ctx.ui.notify(
      `Cannot remove active TODO: ${formatTodoLabel(todo)}`,
      "warning",
    );
    return;
  }

  const removed = removeTodo(ctx.cwd, { id: todo.id });
  ctx.ui.notify(
    `Removed TODO: "${removed.description}" [${removed.id}]`,
    "info",
  );
}

export async function handleStartTodoById(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  id: string,
): Promise<void> {
  const todo = findTodoOrNotify(ctx, id);
  if (!todo) {
    return;
  }
  if (todo.status !== "todo") {
    ctx.ui.notify(`TODO is not queued: ${formatTodoLabel(todo)}`, "warning");
    return;
  }

  await startTodo(pi, ctx, todo);
}

export async function handleResumeTodoById(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  id: string,
): Promise<void> {
  const todo = findTodoOrNotify(ctx, id);
  if (!todo) {
    return;
  }
  if (todo.status !== "doing") {
    ctx.ui.notify(
      `TODO is not in progress: ${formatTodoLabel(todo)}`,
      "warning",
    );
    return;
  }

  await resumeTodo(pi, ctx, todo);
}
