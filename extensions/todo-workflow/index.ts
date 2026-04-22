import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import {
  Container,
  type SelectItem,
  SelectList,
  Text,
} from "@mariozechner/pi-tui";

import { maybeSwitchToWorktreeSession } from "../feature-workflow/commands/shared.js";
import {
  preflightFeatureStart,
  startPreparedFeatureWorkflow,
} from "../feature-workflow/start-feature.js";
import type { FeatureRecord } from "../feature-workflow/storage.js";
import { runWithWorkingLoader } from "../shared/ui-working.js";
import {
  confirmTodoWorktreeReady,
  ensureTodoWorktreeReady,
  getCurrentBranch,
  getEndTodoArgumentCompletions,
  handleEndTodoCommand,
} from "./end-todo.js";
import {
  createTodo,
  findTodoById,
  listTodos,
  type TodoItem,
  updateTodoActivation,
  updateTodoStart,
} from "./todo-store.js";

function getSessionKey(ctx: ExtensionContext): string {
  const sessionFile = ctx.sessionManager.getSessionFile();
  return typeof sessionFile === "string" && sessionFile.trim()
    ? sessionFile.trim()
    : `cwd:${ctx.cwd}`;
}

function updateStatus(_ctx: ExtensionContext, _todo: TodoItem | null): void {}

function listOpenTodos(ctx: ExtensionContext): TodoItem[] {
  return listTodos(ctx.cwd, {
    includeDone: false,
    sessionKey: getSessionKey(ctx),
  });
}

function getCurrentSessionActiveTodo(ctx: ExtensionContext): TodoItem | null {
  return listOpenTodos(ctx).find((todo) => todo.status === "doing") ?? null;
}

function buildTodoDescription(todo: TodoItem): string {
  if (todo.status === "doing") {
    return todo.workBranch ? `doing • ${todo.workBranch}` : "doing";
  }
  if (todo.status === "done") {
    return "done";
  }
  return "todo";
}

async function showTodoPicker(ctx: ExtensionContext): Promise<string | null> {
  const todos = listOpenTodos(ctx);

  if (todos.length === 0) {
    ctx.ui.notify(
      "No TODOs found. Use /todo add <title> to create one.",
      "info",
    );
    return null;
  }

  const items: SelectItem[] = todos.map((todo) => ({
    value: todo.id,
    label: todo.title,
    description: buildTodoDescription(todo),
  }));

  return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
    container.addChild(
      new Text(theme.fg("accent", theme.bold("Project TODOs"))),
    );

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
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
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

function activateTodoForSession(ctx: ExtensionContext, todo: TodoItem): void {
  const activated = updateTodoActivation(ctx.cwd, {
    id: todo.id,
    sessionKey: getSessionKey(ctx),
    activeInSession: true,
  });
  updateStatus(ctx, activated);
  ctx.ui.notify(`doing: ${activated.title}`, "info");
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
): Promise<boolean> {
  const switchResult = await maybeSwitchToWorktreeSession({
    ctx,
    record: buildTodoFeatureRecord(todo, worktreePath),
    worktreePath,
    enabled: true,
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

async function startTodo(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  todo: TodoItem,
): Promise<void> {
  const sourceBranch = await getCurrentBranch(pi, ctx);
  if (!sourceBranch) {
    ctx.ui.notify("Failed to detect current branch", "error");
    return;
  }

  const prepared = preflightFeatureStart({ pi, ctx });
  if (!prepared) {
    return;
  }

  const startResult = await runWithWorkingLoader(ctx, () =>
    startPreparedFeatureWorkflow({
      ctx,
      runtime: prepared.runtime,
      slug: todo.id,
      base: sourceBranch,
    }),
  );
  if (!startResult.ok) {
    return;
  }

  const started = updateTodoStart(ctx.cwd, {
    id: todo.id,
    sourceBranch,
    workBranch: startResult.record.branch,
    worktreePath: startResult.record.worktreePath,
  });
  activateTodoForSession(ctx, started);
}

async function resumeTodo(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  todo: TodoItem,
): Promise<void> {
  const confirmed = await confirmTodoWorktreeReady(ctx, todo);
  if (!confirmed) {
    return;
  }

  const switched = await runWithWorkingLoader(ctx, async () => {
    const ensured = await ensureTodoWorktreeReady(pi, ctx, todo);
    if (!ensured.ok) {
      return false;
    }

    return switchToTodoWorktreeSession(ctx, todo, ensured.worktreePath);
  });
  if (!switched) {
    return;
  }

  activateTodoForSession(ctx, todo);
}

async function handleTodoCommand(
  pi: ExtensionAPI,
  rawArgs: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const trimmed = rawArgs.trim();
  if (trimmed.startsWith("add ")) {
    const title = trimmed.slice(4).trim();
    if (!title) {
      ctx.ui.notify("Usage: /todo add <title>", "warning");
      return;
    }
    const todo = createTodo(ctx.cwd, title);
    ctx.ui.notify(`Added TODO: "${todo.title}"`, "info");
    return;
  }

  if (!ctx.hasUI) {
    ctx.ui.notify("todo requires interactive mode", "warning");
    return;
  }

  const selectedId = await showTodoPicker(ctx);
  if (!selectedId) return;

  const todo = findTodoById(ctx.cwd, selectedId);
  if (!todo) {
    ctx.ui.notify(`Unknown TODO: ${selectedId}`, "error");
    return;
  }

  switch (todo.status) {
    case "doing":
      await resumeTodo(pi, ctx, todo);
      return;
    case "done":
      ctx.ui.notify("Done TODOs are view-only for now.", "info");
      return;
    case "todo":
      await startTodo(pi, ctx, todo);
      return;
  }
}

export default function todoWorkflowExtension(pi: ExtensionAPI): void {
  pi.registerCommand("todo", {
    description: "Manage project TODO workflow",
    handler: async (args, ctx) => handleTodoCommand(pi, args, ctx),
  });

  pi.registerCommand("end_todo", {
    description: "Finish or clean up project TODOs",
    getArgumentCompletions: (argumentPrefix) =>
      getEndTodoArgumentCompletions(pi, argumentPrefix),
    handler: async (args, ctx) => handleEndTodoCommand(pi, args, ctx),
  });

  pi.on("session_start", async (_event, ctx) => {
    updateStatus(ctx, getCurrentSessionActiveTodo(ctx));
  });

  pi.on("session_switch", async (_event, ctx) => {
    updateStatus(ctx, getCurrentSessionActiveTodo(ctx));
  });
}
