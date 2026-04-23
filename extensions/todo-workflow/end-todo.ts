import fs from "node:fs";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";

import { ensureFeatureWorktree } from "../feature-workflow/worktree-gateway.js";
import { runWithWorkingLoader } from "../shared/ui-working.js";
import {
  findTodoById,
  getDoingTodos,
  loadTodoStore,
  markTodoDone,
  syncTodoDone,
  type TodoItem,
} from "./todo-store.js";

type ParsedEndTodoAction =
  | { kind: "menu" }
  | { kind: "finish"; id?: string }
  | { kind: "cleanup-one"; id?: string }
  | { kind: "cleanup-all" }
  | { kind: "error"; message: string };

type MergeInspection =
  | { state: "merged" }
  | { state: "not-merged" }
  | { state: "unknown"; reason: string };

type CleanupScope = "worktree" | "local" | "remote";

type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

const END_TODO_USAGE =
  "Usage: /end_todo [finish [<todo-id>] | cleanup [<todo-id>|--all]]";

const END_TODO_MENU_OPTIONS = [
  "Finish a todo",
  "Cleanup one merged todo",
  "Cleanup all merged todos",
] as const;

const CLEANUP_SCOPE_OPTIONS = [
  "Local worktree only",
  "Local worktree + local branch",
  "Local worktree + local branch + remote branch",
] as const;

type EndTodoMenuOption = (typeof END_TODO_MENU_OPTIONS)[number];
type CleanupScopeOption = (typeof CLEANUP_SCOPE_OPTIONS)[number];

type CompletionParseResult = {
  tokens: string[];
  current: string;
};

function normalizeResult(result: {
  code?: number;
  stdout?: string;
  stderr?: string;
}): CommandResult {
  return {
    code: result.code ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

async function runGit(
  pi: ExtensionAPI,
  repoRoot: string,
  args: string[],
): Promise<CommandResult> {
  return normalizeResult(await pi.exec("git", ["-C", repoRoot, ...args]));
}

async function runWt(
  pi: ExtensionAPI,
  repoRoot: string,
  args: string[],
): Promise<CommandResult> {
  return normalizeResult(await pi.exec("wt", ["-C", repoRoot, ...args]));
}

function trimToNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function formatCommandError(result: CommandResult, fallback: string): string {
  return trimToNull(result.stderr) ?? trimToNull(result.stdout) ?? fallback;
}

function matchesMissingResource(message: string): boolean {
  return /not found|does not exist|no such|already removed|unknown worktree/i.test(
    message,
  );
}

function invalidEndTodoUsage(): ParsedEndTodoAction {
  return {
    kind: "error",
    message: END_TODO_USAGE,
  };
}

function parseEndTodoArgs(rawArgs: string): ParsedEndTodoAction {
  const tokens = rawArgs.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return { kind: "menu" };
  }

  const [command, value, extra] = tokens;
  if (extra) {
    return invalidEndTodoUsage();
  }

  if (command === "finish") {
    return { kind: "finish", id: value };
  }

  if (command === "cleanup") {
    if (value === "--all") {
      return { kind: "cleanup-all" };
    }
    return { kind: "cleanup-one", id: value };
  }

  return invalidEndTodoUsage();
}

function parseCompletionPrefix(argumentPrefix: string): CompletionParseResult {
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

function toTodoCompletionItem(todo: TodoItem): AutocompleteItem {
  return {
    value: todo.id,
    label: `${todo.id}    ${todo.title}`,
    description: todo.status,
  };
}

function buildActionCompletionItems(): AutocompleteItem[] {
  return [
    {
      value: "finish",
      label: "finish",
      description: "finish current or selected todo",
    },
    {
      value: "cleanup",
      label: "cleanup",
      description: "cleanup merged todo resources",
    },
  ];
}

async function doesGitRefExist(
  pi: ExtensionAPI,
  repoRoot: string,
  ref: string,
): Promise<boolean> {
  const result = await runGit(pi, repoRoot, ["rev-parse", "--verify", ref]);
  return result.code === 0;
}

async function inspectTodoMergeState(
  pi: ExtensionAPI,
  repoRoot: string,
  todo: TodoItem,
): Promise<MergeInspection> {
  if (
    !todo.sourceBranch ||
    !todo.workBranch ||
    todo.sourceBranch === todo.workBranch
  ) {
    return {
      state: "unknown",
      reason: `TODO "${todo.title}" is missing valid git metadata.`,
    };
  }

  if (!(await doesGitRefExist(pi, repoRoot, todo.sourceBranch))) {
    return {
      state: "unknown",
      reason: `TODO "${todo.title}" is missing source branch ${todo.sourceBranch}.`,
    };
  }

  if (!(await doesGitRefExist(pi, repoRoot, todo.workBranch))) {
    return {
      state: "unknown",
      reason: `TODO "${todo.title}" is missing work branch ${todo.workBranch}.`,
    };
  }

  const result = await runGit(pi, repoRoot, [
    "merge-base",
    "--is-ancestor",
    todo.workBranch,
    todo.sourceBranch,
  ]);
  if (result.code === 0) {
    return { state: "merged" };
  }
  if (result.code === 1) {
    return { state: "not-merged" };
  }

  return {
    state: "unknown",
    reason: formatCommandError(result, "Failed to inspect merge status"),
  };
}

async function listMergedCleanupCandidates(
  pi: ExtensionAPI,
  repoRoot: string,
): Promise<TodoItem[]> {
  const candidates: TodoItem[] = [];
  for (const todo of loadTodoStore(repoRoot).todos) {
    const inspection = await inspectTodoMergeState(pi, repoRoot, todo);
    if (inspection.state === "merged") {
      candidates.push(todo);
    }
  }
  return candidates;
}

async function resolveTodoById(
  repoRoot: string,
  id: string,
  ctx: ExtensionCommandContext,
): Promise<TodoItem | null> {
  const todo = findTodoById(repoRoot, id);
  if (!todo) {
    ctx.ui.notify(`Unknown TODO: ${id}`, "error");
    return null;
  }
  return todo;
}

async function selectTodoFromList(
  ctx: ExtensionCommandContext,
  title: string,
  todos: TodoItem[],
): Promise<TodoItem | null> {
  if (todos.length === 0) {
    return null;
  }
  if (todos.length === 1) {
    return todos[0] ?? null;
  }
  if (!ctx.hasUI) {
    ctx.ui.notify("This /end_todo flow requires interactive mode", "warning");
    return null;
  }

  const choice = await ctx.ui.select(
    title,
    todos.map((todo) => todo.title),
  );
  if (!choice) {
    ctx.ui.notify("Cancelled", "info");
    return null;
  }

  return todos.find((todo) => todo.title === choice) ?? null;
}

async function selectFinishTarget(
  repoRoot: string,
  ctx: ExtensionCommandContext,
  id?: string,
): Promise<TodoItem | null> {
  if (id) {
    return resolveTodoById(repoRoot, id, ctx);
  }

  const doingTodos = getDoingTodos(repoRoot);
  if (doingTodos.length === 0) {
    ctx.ui.notify("No doing TODOs found", "info");
    return null;
  }

  return selectTodoFromList(ctx, "Finish TODO:", doingTodos);
}

async function selectCleanupTarget(
  pi: ExtensionAPI,
  repoRoot: string,
  ctx: ExtensionCommandContext,
  id?: string,
): Promise<TodoItem | null> {
  if (id) {
    return resolveTodoById(repoRoot, id, ctx);
  }

  const candidates = await listMergedCleanupCandidates(pi, repoRoot);
  if (candidates.length === 0) {
    ctx.ui.notify("No merged TODOs found", "info");
    return null;
  }

  return selectTodoFromList(ctx, "Cleanup merged TODO:", candidates);
}

export async function getCurrentBranch(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<string | null> {
  const result = await runGit(pi, ctx.cwd, ["branch", "--show-current"]);
  return trimToNull(result.stdout) ?? null;
}

function isMissingTodoWorktree(todo: TodoItem): boolean {
  return Boolean(todo.worktreePath && !fs.existsSync(todo.worktreePath));
}

export async function confirmTodoWorktreeReady(
  ctx: ExtensionCommandContext,
  todo: TodoItem,
): Promise<boolean> {
  if (!isMissingTodoWorktree(todo)) {
    return true;
  }

  const shouldRebuild = await ctx.ui.confirm(
    `Rebuild missing worktree for "${todo.title}"?`,
    `Expected worktree path: ${todo.worktreePath}`,
  );
  if (!shouldRebuild) {
    ctx.ui.notify("Cancelled", "info");
    return false;
  }

  return true;
}

export async function ensureTodoWorktreeReady(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  todo: TodoItem,
): Promise<{ ok: true; worktreePath: string } | { ok: false }> {
  if (!todo.workBranch) {
    ctx.ui.notify(`TODO "${todo.title}" is missing its work branch.`, "error");
    return { ok: false };
  }

  const ensured = await ensureFeatureWorktree(
    async (args: string[]) => runWt(pi, ctx.cwd, args),
    {
      branch: todo.workBranch,
      fallbackWorktreePath: todo.worktreePath ?? "",
    },
  );
  if (!ensured.ok) {
    ctx.ui.notify(ensured.message, "error");
    return { ok: false };
  }

  return {
    ok: true,
    worktreePath: ensured.worktreePath,
  };
}

function parseEndTodoMenuChoice(
  choice: EndTodoMenuOption,
): ParsedEndTodoAction {
  switch (choice) {
    case "Finish a todo":
      return { kind: "finish" };
    case "Cleanup one merged todo":
      return { kind: "cleanup-one" };
    case "Cleanup all merged todos":
      return { kind: "cleanup-all" };
  }
}

async function chooseEndTodoMenuAction(
  ctx: ExtensionCommandContext,
): Promise<ParsedEndTodoAction | null> {
  if (!ctx.hasUI) {
    ctx.ui.notify("/end_todo requires interactive mode", "warning");
    return null;
  }

  const choice = await ctx.ui.select("/end_todo", [...END_TODO_MENU_OPTIONS]);
  if (!choice) {
    ctx.ui.notify("Cancelled", "info");
    return null;
  }

  return parseEndTodoMenuChoice(choice as EndTodoMenuOption);
}

function parseCleanupScopeChoice(choice: CleanupScopeOption): CleanupScope {
  switch (choice) {
    case "Local worktree only":
      return "worktree";
    case "Local worktree + local branch":
      return "local";
    case "Local worktree + local branch + remote branch":
      return "remote";
  }
}

async function chooseCleanupScope(
  ctx: ExtensionCommandContext,
  todo: TodoItem,
): Promise<CleanupScope | null> {
  if (!ctx.hasUI) {
    return "local";
  }

  const choice = await ctx.ui.select(`Cleanup scope for "${todo.title}":`, [
    ...CLEANUP_SCOPE_OPTIONS,
  ]);
  if (!choice) {
    ctx.ui.notify("Cancelled", "info");
    return null;
  }

  return parseCleanupScopeChoice(choice as CleanupScopeOption);
}

async function removeWorktree(
  pi: ExtensionAPI,
  repoRoot: string,
  todo: TodoItem,
): Promise<string | null> {
  if (!todo.workBranch) {
    return "missing work branch";
  }

  const result = await runWt(pi, repoRoot, [
    "remove",
    todo.workBranch,
    "--yes",
    "--foreground",
  ]);
  if (result.code === 0) {
    return null;
  }

  const message = formatCommandError(result, "wt remove failed");
  return matchesMissingResource(message) ? null : `worktree: ${message}`;
}

async function removeLocalBranch(
  pi: ExtensionAPI,
  repoRoot: string,
  todo: TodoItem,
): Promise<string | null> {
  if (!todo.workBranch) {
    return "missing work branch";
  }

  const result = await runGit(pi, repoRoot, ["branch", "-d", todo.workBranch]);
  if (result.code === 0) {
    return null;
  }

  const message = formatCommandError(result, "git branch -d failed");
  return matchesMissingResource(message) ? null : `local branch: ${message}`;
}

async function removeRemoteBranch(
  pi: ExtensionAPI,
  repoRoot: string,
  todo: TodoItem,
): Promise<string | null> {
  if (!todo.workBranch) {
    return "missing work branch";
  }

  const result = await runGit(pi, repoRoot, [
    "push",
    "origin",
    "--delete",
    todo.workBranch,
  ]);
  if (result.code === 0) {
    return null;
  }

  return `remote branch: ${formatCommandError(result, "git push origin --delete failed")}`;
}

async function cleanupTodoResources(
  pi: ExtensionAPI,
  repoRoot: string,
  todo: TodoItem,
  scope: CleanupScope,
): Promise<string[]> {
  const failures: string[] = [];

  const worktreeFailure = await removeWorktree(pi, repoRoot, todo);
  if (worktreeFailure) {
    failures.push(worktreeFailure);
  }

  if (scope === "local" || scope === "remote") {
    const branchFailure = await removeLocalBranch(pi, repoRoot, todo);
    if (branchFailure) {
      failures.push(branchFailure);
    }
  }

  if (scope === "remote") {
    const remoteFailure = await removeRemoteBranch(pi, repoRoot, todo);
    if (remoteFailure) {
      failures.push(remoteFailure);
    }
  }

  return failures;
}

async function runFinishFlow(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  id?: string,
): Promise<void> {
  const target = await selectFinishTarget(ctx.cwd, ctx, id);
  if (!target) {
    return;
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

    const confirmed = await confirmTodoWorktreeReady(ctx, target);
    if (!confirmed) {
      return;
    }
  }

  const finished = await runWithWorkingLoader(
    ctx,
    async () => {
      let mergeCwd = target.worktreePath ?? ctx.cwd;

      if (currentBranch !== target.workBranch) {
        const switched = await ensureTodoWorktreeReady(pi, ctx, target);
        if (!switched.ok) {
          return false;
        }
        mergeCwd = switched.worktreePath;
      }

      const mergeResult = await runWt(pi, mergeCwd, [
        "merge",
        "--no-remove",
        target.sourceBranch,
      ]);
      if (mergeResult.code !== 0) {
        ctx.ui.notify(
          formatCommandError(mergeResult, "Failed to merge TODO branch"),
          "error",
        );
        return false;
      }

      return true;
    },
    { message: "Merging..." },
  );
  if (!finished) {
    return;
  }

  const completed = markTodoDone(ctx.cwd, { id: target.id });
  const cleanupNow = await ctx.ui.confirm(
    `Clean up worktree/branch for "${target.title}"?`,
    `${target.workBranch}${target.worktreePath ? ` • ${target.worktreePath}` : ""}`,
  );
  if (cleanupNow) {
    await runCleanupOneFlow(pi, ctx, target.id);
  }

  ctx.ui.notify(`Completed TODO: ${completed.title}`, "info");
}

async function runCleanupOneFlow(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  id?: string,
): Promise<void> {
  const target = await selectCleanupTarget(pi, ctx.cwd, ctx, id);
  if (!target) {
    return;
  }

  const inspection = await inspectTodoMergeState(pi, ctx.cwd, target);
  if (inspection.state === "not-merged") {
    ctx.ui.notify(
      `TODO "${target.title}" is not merged into ${target.sourceBranch} yet.`,
      "warning",
    );
    return;
  }
  if (inspection.state === "unknown") {
    ctx.ui.notify(inspection.reason, "warning");
    return;
  }

  const scope = await chooseCleanupScope(ctx, target);
  if (!scope) {
    return;
  }

  const failures = await runWithWorkingLoader(
    ctx,
    () => cleanupTodoResources(pi, ctx.cwd, target, scope),
    { message: "Cleaning..." },
  );
  syncTodoDone(ctx.cwd, { id: target.id });

  if (failures.length === 0) {
    ctx.ui.notify(`Cleaned TODO: ${target.title}`, "info");
    return;
  }

  ctx.ui.notify(
    `Partially cleaned TODO: ${target.title} (${failures.join(" | ")})`,
    "warning",
  );
}

type BulkCleanupSummary = {
  merged: TodoItem[];
  notMergedCount: number;
  invalidCount: number;
};

async function classifyBulkCleanupTargets(
  pi: ExtensionAPI,
  repoRoot: string,
): Promise<BulkCleanupSummary> {
  const summary: BulkCleanupSummary = {
    merged: [],
    notMergedCount: 0,
    invalidCount: 0,
  };

  for (const todo of loadTodoStore(repoRoot).todos) {
    const inspection = await inspectTodoMergeState(pi, repoRoot, todo);
    switch (inspection.state) {
      case "merged":
        summary.merged.push(todo);
        break;
      case "not-merged":
        summary.notMergedCount += 1;
        break;
      case "unknown":
        summary.invalidCount += 1;
        break;
    }
  }

  return summary;
}

async function runCleanupAllFlow(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const summary = await classifyBulkCleanupTargets(pi, ctx.cwd);
  if (summary.merged.length === 0) {
    ctx.ui.notify("No merged TODOs found", "info");
    return;
  }

  const confirmed = await ctx.ui.confirm(
    `Cleanup ${summary.merged.length} merged TODO(s)?`,
    [
      `merged candidates: ${summary.merged.length}`,
      `skipped not merged: ${summary.notMergedCount}`,
      `skipped invalid: ${summary.invalidCount}`,
    ].join("\n"),
  );
  if (!confirmed) {
    ctx.ui.notify("Cancelled", "info");
    return;
  }

  let partial = 0;
  const failures: string[] = [];

  await runWithWorkingLoader(
    ctx,
    async () => {
      for (const todo of summary.merged) {
        const cleanupFailures = await cleanupTodoResources(
          pi,
          ctx.cwd,
          todo,
          "local",
        );
        syncTodoDone(ctx.cwd, { id: todo.id });
        if (cleanupFailures.length > 0) {
          partial += 1;
          failures.push(`${todo.id}: ${cleanupFailures.join(" | ")}`);
        }
      }
    },
    { message: "Cleaning..." },
  );

  const resultSummary = [
    `cleaned ${summary.merged.length}`,
    `partial ${partial}`,
    `skipped not merged ${summary.notMergedCount}`,
    `skipped invalid ${summary.invalidCount}`,
  ].join(", ");

  ctx.ui.notify(
    failures.length > 0
      ? `Bulk TODO cleanup completed with warnings: ${resultSummary} (${failures.join(" ; ")})`
      : `Bulk TODO cleanup completed: ${resultSummary}`,
    failures.length > 0 ? "warning" : "info",
  );
}

async function buildCleanupCompletionItems(
  pi: ExtensionAPI,
  repoRoot: string,
): Promise<AutocompleteItem[]> {
  const candidates = await listMergedCleanupCandidates(pi, repoRoot);
  return [
    {
      value: "--all",
      label: "--all",
      description: "cleanup all merged todos",
    },
    ...candidates.map(toTodoCompletionItem),
  ];
}

export async function getEndTodoArgumentCompletions(
  pi: ExtensionAPI,
  argumentPrefix: string,
): Promise<AutocompleteItem[] | null> {
  const { tokens, current } = parseCompletionPrefix(argumentPrefix);
  if (tokens.length === 0) {
    return filterCompletionItems(buildActionCompletionItems(), current);
  }

  const repoRoot = process.cwd();
  const [command] = tokens;
  if (command === "finish" && tokens.length === 1) {
    const todos = getDoingTodos(repoRoot);
    return filterCompletionItems(todos.map(toTodoCompletionItem), current);
  }

  if (command === "cleanup" && tokens.length === 1) {
    const items = await buildCleanupCompletionItems(pi, repoRoot);
    return filterCompletionItems(items, current);
  }

  return null;
}

export async function handleEndTodoCommand(
  pi: ExtensionAPI,
  rawArgs: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  let action = parseEndTodoArgs(rawArgs);
  if (action.kind === "error") {
    ctx.ui.notify(action.message, "error");
    return;
  }

  if (action.kind === "menu") {
    const selected = await chooseEndTodoMenuAction(ctx);
    if (!selected) {
      return;
    }
    action = selected;
  }

  switch (action.kind) {
    case "finish":
      await runFinishFlow(pi, ctx, action.id);
      return;
    case "cleanup-one":
      await runCleanupOneFlow(pi, ctx, action.id);
      return;
    case "cleanup-all":
      await runCleanupAllFlow(pi, ctx);
      return;
    case "menu":
    case "error":
      return;
  }
}
