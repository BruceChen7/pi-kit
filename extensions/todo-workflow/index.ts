import fs from "node:fs";

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
import { startFeatureWorkflow } from "../feature-workflow/start-feature.js";
import type { FeatureRecord } from "../feature-workflow/storage.js";
import { ensureFeatureWorktree } from "../feature-workflow/worktree-gateway.js";
import {
  createTodo,
  findTodoById,
  getDoingTodos,
  listTodos,
  markTodoDone,
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

function activateTodoForSession(
  ctx: ExtensionContext,
  todo: TodoItem,
): TodoItem {
  const activated = updateTodoActivation(ctx.cwd, {
    id: todo.id,
    sessionKey: getSessionKey(ctx),
    activeInSession: true,
  });
  updateStatus(ctx, activated);
  ctx.ui.notify(`doing: ${activated.title}`, "info");
  return activated;
}

async function getCurrentBranch(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<string | null> {
  const result = await pi.exec("git", [
    "-C",
    ctx.cwd,
    "branch",
    "--show-current",
  ]);
  const branch = result.stdout?.trim();
  return branch || null;
}

async function ensureTodoWorktreeReady(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  todo: TodoItem,
): Promise<{ ok: true; worktreePath: string } | { ok: false }> {
  if (!todo.workBranch) {
    ctx.ui.notify(`TODO "${todo.title}" is missing its work branch.`, "error");
    return { ok: false };
  }

  const hasWorktree = todo.worktreePath
    ? fs.existsSync(todo.worktreePath)
    : false;
  if (!hasWorktree && todo.worktreePath) {
    const shouldRebuild = await ctx.ui.confirm(
      `Rebuild missing worktree for "${todo.title}"?`,
      `Expected worktree path: ${todo.worktreePath}`,
    );
    if (!shouldRebuild) {
      ctx.ui.notify("Cancelled", "info");
      return { ok: false };
    }
  }

  const runWt = async (args: string[]) => {
    const result = await pi.exec("wt", ["-C", ctx.cwd, ...args]);
    return {
      code: result.code ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  };

  const ensured = await ensureFeatureWorktree(runWt, {
    branch: todo.workBranch,
    fallbackWorktreePath: todo.worktreePath ?? "",
  });
  if (!ensured.ok) {
    ctx.ui.notify(ensured.message, "error");
    return { ok: false };
  }

  return {
    ok: true,
    worktreePath: ensured.worktreePath,
  };
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

  const startResult = await startFeatureWorkflow({
    pi,
    ctx,
    slug: todo.id,
    base: sourceBranch,
  });
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
  const ensured = await ensureTodoWorktreeReady(pi, ctx, todo);
  if (!ensured.ok) {
    return;
  }

  const switched = await switchToTodoWorktreeSession(
    ctx,
    todo,
    ensured.worktreePath,
  );
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

  if (todo.status === "doing") {
    await resumeTodo(pi, ctx, todo);
    return;
  }

  if (todo.status === "done") {
    ctx.ui.notify("Done TODOs are view-only for now.", "info");
    return;
  }

  await startTodo(pi, ctx, todo);
}

async function handleEndTodo(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const doingTodos = getDoingTodos(ctx.cwd);
  if (doingTodos.length === 0) {
    ctx.ui.notify("No doing TODOs found", "info");
    updateStatus(ctx, null);
    return;
  }

  let target = doingTodos[0] as TodoItem;
  if (doingTodos.length > 1) {
    const choice = await ctx.ui.select(
      "Finish TODO:",
      doingTodos.map((todo) => todo.title),
    );
    if (!choice) {
      ctx.ui.notify("Cancelled", "info");
      return;
    }
    target = doingTodos.find((todo) => todo.title === choice) ?? target;
  }

  if (!target.workBranch || !target.sourceBranch) {
    ctx.ui.notify(`TODO "${target.title}" is missing git metadata.`, "error");
    return;
  }

  const currentBranch = await getCurrentBranch(pi, ctx);
  if (currentBranch !== target.workBranch) {
    const shouldSwitch = await ctx.ui.confirm(
      `Switch to ${target.workBranch} before finishing?`,
      `Current branch: ${currentBranch || "unknown"}`,
    );
    if (!shouldSwitch) {
      ctx.ui.notify("Cancelled", "info");
      return;
    }

    const switched = await ensureTodoWorktreeReady(pi, ctx, target);
    if (!switched.ok) {
      return;
    }
  }

  const checkoutSource = await pi.exec("git", [
    "-C",
    ctx.cwd,
    "checkout",
    target.sourceBranch,
  ]);
  if ((checkoutSource.code ?? 1) !== 0) {
    ctx.ui.notify(
      checkoutSource.stderr ?? "Failed to checkout source branch",
      "error",
    );
    return;
  }

  const mergeResult = await pi.exec("git", [
    "-C",
    ctx.cwd,
    "merge",
    "--no-ff",
    target.workBranch,
  ]);
  if ((mergeResult.code ?? 1) !== 0) {
    ctx.ui.notify(mergeResult.stderr ?? "Failed to merge TODO branch", "error");
    return;
  }

  const checkoutBack = await pi.exec("git", [
    "-C",
    ctx.cwd,
    "checkout",
    target.sourceBranch,
  ]);
  if ((checkoutBack.code ?? 1) !== 0) {
    ctx.ui.notify(
      checkoutBack.stderr ?? "Failed to return to source branch",
      "error",
    );
    return;
  }

  const completed = markTodoDone(ctx.cwd, { id: target.id });
  const cleanup = await ctx.ui.confirm(
    `Clean up worktree/branch for "${target.title}"?`,
    `${target.workBranch}${target.worktreePath ? ` • ${target.worktreePath}` : ""}`,
  );
  if (cleanup) {
    ctx.ui.notify(
      "Cleanup flow not implemented yet; leaving branch/worktree intact.",
      "info",
    );
  }

  updateStatus(ctx, getCurrentSessionActiveTodo(ctx));
  ctx.ui.notify(`Completed TODO: ${completed.title}`, "info");
}

export default function todoWorkflowExtension(pi: ExtensionAPI): void {
  pi.registerCommand("todo", {
    description: "Manage project TODO workflow",
    handler: async (args, ctx) => handleTodoCommand(pi, args, ctx),
  });

  pi.registerCommand("end_todo", {
    description: "Finish a doing TODO by merging it back to its source branch",
    handler: async (_args, ctx) => handleEndTodo(pi, ctx),
  });

  pi.on("session_start", async (_event, ctx) => {
    updateStatus(ctx, getCurrentSessionActiveTodo(ctx));
  });

  pi.on("session_switch", async (_event, ctx) => {
    updateStatus(ctx, getCurrentSessionActiveTodo(ctx));
  });
}
