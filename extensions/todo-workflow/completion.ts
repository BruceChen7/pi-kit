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
  buildLiteralArgumentCompletionItem,
  buildTodoArgumentCompletionItem,
  filterCompletionItems,
  filterTodosForCommand,
  parseCompletionPrefix,
} from "./autocomplete.js";
import {
  getTodoCompletionActionItems,
  isTodoCompletionActionCommand,
} from "./commands.js";
import { formatTodoSelectionLabel } from "./display.js";
import {
  findTodoById,
  getDoingTodos,
  loadTodoStore,
  markTodoDone,
  syncTodoDone,
  type TodoItem,
} from "./todo-store.js";

type ParsedTodoCompletionAction =
  | { kind: "menu" }
  | { kind: "finish"; id?: string; commitMessage?: string }
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

const TODO_COMPLETION_USAGE =
  "Usage: /todo [finish [<todo-id>] [--message <commit-message>] | cleanup [<todo-id>|--all]]";
const TODO_FINISH_MESSAGE_USAGE =
  "Usage: /todo finish [<todo-id>] --message <commit-message>";

const TODO_COMPLETION_MENU_OPTIONS = [
  "Finish a todo",
  "Cleanup one merged todo",
  "Cleanup all merged todos",
] as const;

const CLEANUP_SCOPE_OPTIONS = [
  "Local worktree only",
  "Local worktree + local branch",
  "Local worktree + local branch + remote branch",
] as const;

type TodoCompletionMenuOption = (typeof TODO_COMPLETION_MENU_OPTIONS)[number];
type CleanupScopeOption = (typeof CLEANUP_SCOPE_OPTIONS)[number];

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

function normalizeCommandError(error: unknown): CommandResult {
  return {
    code: 1,
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
  };
}

async function runCommand(
  pi: ExtensionAPI,
  command: string,
  args: string[],
): Promise<CommandResult> {
  try {
    return normalizeResult(await pi.exec(command, args));
  } catch (error: unknown) {
    return normalizeCommandError(error);
  }
}

async function runGit(
  pi: ExtensionAPI,
  repoRoot: string,
  args: string[],
): Promise<CommandResult> {
  return runCommand(pi, "git", ["-C", repoRoot, ...args]);
}

async function runWt(
  pi: ExtensionAPI,
  repoRoot: string,
  args: string[],
): Promise<CommandResult> {
  return runCommand(pi, "wt", ["-C", repoRoot, ...args]);
}

function trimToNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function formatCommandError(result: CommandResult, fallback: string): string {
  return trimToNull(result.stderr) ?? trimToNull(result.stdout) ?? fallback;
}

function invalidTodoCompletionUsage(): ParsedTodoCompletionAction {
  return {
    kind: "error",
    message: TODO_COMPLETION_USAGE,
  };
}

function unquoteMessage(message: string): string {
  if (
    (message.startsWith('"') && message.endsWith('"')) ||
    (message.startsWith("'") && message.endsWith("'"))
  ) {
    return message.slice(1, -1).trim();
  }
  return message;
}

function parseFinishArgs(args: string): ParsedTodoCompletionAction {
  const messageMatch = /(?:^|\s)(--message|-m)\s+(.+)$/s.exec(args);
  const beforeMessage = messageMatch
    ? args.slice(0, messageMatch.index).trim()
    : args.trim();
  const commitMessage = messageMatch
    ? unquoteMessage(messageMatch[2]?.trim() ?? "")
    : undefined;
  const tokens = beforeMessage.split(/\s+/).filter(Boolean);
  const [command, id, extra] = tokens;

  if (command !== "finish" || extra || commitMessage === "") {
    return invalidTodoCompletionUsage();
  }

  return { kind: "finish", id, commitMessage };
}

function parseTodoCompletionArgs(rawArgs: string): ParsedTodoCompletionAction {
  const trimmed = rawArgs.trim();
  if (!trimmed) {
    return { kind: "menu" };
  }

  if (trimmed === "finish" || trimmed.startsWith("finish ")) {
    return parseFinishArgs(trimmed);
  }

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const [command, value, extra] = tokens;
  if (extra || !isTodoCompletionActionCommand(command)) {
    return invalidTodoCompletionUsage();
  }

  if (value === "--all") {
    return { kind: "cleanup-all" };
  }
  return { kind: "cleanup-one", id: value };
}

async function doesGitRefExist(
  pi: ExtensionAPI,
  repoRoot: string,
  ref: string,
): Promise<boolean> {
  const result = await runGit(pi, repoRoot, ["rev-parse", "--verify", ref]);
  return result.code === 0;
}

async function doesLocalBranchExist(
  pi: ExtensionAPI,
  repoRoot: string,
  branch: string,
): Promise<boolean> {
  return doesGitRefExist(pi, repoRoot, `refs/heads/${branch}`);
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
      reason: `TODO "${todo.description}" is missing valid git metadata.`,
    };
  }

  if (!(await doesGitRefExist(pi, repoRoot, todo.sourceBranch))) {
    return {
      state: "unknown",
      reason: `TODO "${todo.description}" is missing source branch ${todo.sourceBranch}.`,
    };
  }

  if (!(await doesGitRefExist(pi, repoRoot, todo.workBranch))) {
    return {
      state: "unknown",
      reason: `TODO "${todo.description}" is missing work branch ${todo.workBranch}.`,
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
  prompt: string,
  todos: TodoItem[],
): Promise<TodoItem | null> {
  if (todos.length === 0) {
    return null;
  }
  if (todos.length === 1) {
    return todos[0] ?? null;
  }
  if (!ctx.hasUI) {
    ctx.ui.notify(
      "This /todo finish/cleanup flow requires interactive mode",
      "warning",
    );
    return null;
  }

  const options = todos.map((todo) => formatTodoSelectionLabel(todo));
  const choice = await ctx.ui.select(prompt, options);
  if (!choice) {
    ctx.ui.notify("Cancelled", "info");
    return null;
  }

  return (
    todos.find((todo) => formatTodoSelectionLabel(todo) === choice) ?? null
  );
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
    `Rebuild missing worktree for "${todo.description}"?`,
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
    ctx.ui.notify(
      `TODO "${todo.description}" is missing its work branch.`,
      "error",
    );
    return { ok: false };
  }

  const ensured = await ensureFeatureWorktree(
    async (args: string[]) => runWt(pi, ctx.cwd, args),
    {
      branch: todo.workBranch,
      fallbackWorktreePath: todo.worktreePath ?? "",
    },
  );
  if (ensured.ok === false) {
    ctx.ui.notify(ensured.message, "error");
    return { ok: false };
  }

  return {
    ok: true,
    worktreePath: ensured.worktreePath,
  };
}

function parseTodoCompletionMenuChoice(
  choice: TodoCompletionMenuOption,
): ParsedTodoCompletionAction {
  switch (choice) {
    case "Finish a todo":
      return { kind: "finish" };
    case "Cleanup one merged todo":
      return { kind: "cleanup-one" };
    case "Cleanup all merged todos":
      return { kind: "cleanup-all" };
  }
}

async function chooseTodoCompletionMenuAction(
  ctx: ExtensionCommandContext,
): Promise<ParsedTodoCompletionAction | null> {
  if (!ctx.hasUI) {
    ctx.ui.notify("/todo finish/cleanup requires interactive mode", "warning");
    return null;
  }

  const choice = await ctx.ui.select("/todo finish / cleanup", [
    ...TODO_COMPLETION_MENU_OPTIONS,
  ]);
  if (!choice) {
    ctx.ui.notify("Cancelled", "info");
    return null;
  }

  return parseTodoCompletionMenuChoice(choice as TodoCompletionMenuOption);
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

  const choice = await ctx.ui.select(
    `Cleanup scope for "${todo.description}":`,
    [...CLEANUP_SCOPE_OPTIONS],
  );
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

  if (isMissingTodoWorktree(todo)) {
    return null;
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

  if (isMissingTodoWorktree(todo)) {
    return null;
  }

  return `worktree: ${formatCommandError(result, "wt remove failed")}`;
}

async function removeLocalBranch(
  pi: ExtensionAPI,
  repoRoot: string,
  todo: TodoItem,
): Promise<string | null> {
  if (!todo.workBranch) {
    return "missing work branch";
  }

  if (!(await doesLocalBranchExist(pi, repoRoot, todo.workBranch))) {
    return null;
  }

  const result = await runGit(pi, repoRoot, ["branch", "-d", todo.workBranch]);
  if (result.code === 0) {
    return null;
  }

  if (!(await doesLocalBranchExist(pi, repoRoot, todo.workBranch))) {
    return null;
  }

  return `local branch: ${formatCommandError(result, "git branch -d failed")}`;
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

async function isGitWorktreeClean(
  pi: ExtensionAPI,
  repoRoot: string,
): Promise<{ ok: true; clean: boolean } | { ok: false; message: string }> {
  const result = await runGit(pi, repoRoot, ["status", "--porcelain"]);
  if (result.code !== 0) {
    return {
      ok: false,
      message: formatCommandError(result, "Failed to inspect git status"),
    };
  }

  return { ok: true, clean: result.stdout.trim() === "" };
}

function buildFinishMergeArgs(workBranch: string): string[] {
  return ["merge", "--no-commit", "--no-remove", workBranch];
}

function parseRecentCommitLines(output: string): string[] {
  return output
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function confirmRecentCommitsBeforeMerge(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  todo: TodoItem,
): Promise<boolean> {
  if (!ctx.hasUI) {
    ctx.ui.notify(
      "/todo finish merge confirmation requires interactive mode",
      "warning",
    );
    return false;
  }

  const result = await runGit(pi, todo.worktreePath ?? ctx.cwd, [
    "log",
    "-5",
    "--format=%h %s",
  ]).catch((error: unknown) => ({
    code: 1,
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
  }));
  if (result.code !== 0) {
    ctx.ui.notify(
      formatCommandError(result, "Failed to inspect recent TODO commits"),
      "warning",
    );
    return false;
  }

  const commitLines = parseRecentCommitLines(result.stdout);
  if (commitLines.length === 0) {
    ctx.ui.notify("No recent TODO commits found to merge.", "warning");
    return false;
  }

  const confirmed = await ctx.ui.confirm(
    `Merge recent commits from ${todo.workBranch ?? "unknown"}?`,
    commitLines.join("\n"),
  );
  if (!confirmed) {
    ctx.ui.notify("Cancelled", "info");
  }
  return confirmed;
}

async function resolveFinishCommitMessage(
  ctx: ExtensionCommandContext,
  commitMessage?: string,
): Promise<string | null> {
  const providedMessage = trimToNull(commitMessage);
  if (providedMessage) {
    return providedMessage;
  }

  if (!ctx.hasUI) {
    ctx.ui.notify(TODO_FINISH_MESSAGE_USAGE, "warning");
    return null;
  }

  const inputMessage = trimToNull(await ctx.ui.input("Commit message:", ""));
  if (!inputMessage) {
    ctx.ui.notify("Cancelled", "info");
    return null;
  }

  return inputMessage;
}

async function runFinishFlow(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  id?: string,
  commitMessage?: string,
): Promise<void> {
  const target = await selectFinishTarget(ctx.cwd, ctx, id);
  if (!target) {
    return;
  }

  if (!target.workBranch || !target.sourceBranch) {
    ctx.ui.notify(
      `TODO "${target.description}" is missing git metadata.`,
      "error",
    );
    return;
  }

  const finishCommitMessage = await resolveFinishCommitMessage(
    ctx,
    commitMessage,
  );
  if (!finishCommitMessage) {
    return;
  }

  const currentBranch = await getCurrentBranch(pi, ctx);
  if (currentBranch !== target.sourceBranch) {
    ctx.ui.notify(
      `Finish must be run from source branch ${target.sourceBranch}. Current branch: ${currentBranch || "unknown"}. Please switch back to ${target.sourceBranch} and retry.`,
      "warning",
    );
    return;
  }

  if (!target.worktreePath) {
    ctx.ui.notify(
      `TODO "${target.description}" is missing its worktree path.`,
      "error",
    );
    return;
  }

  let skippedMergeForMissingWorktree = false;
  const finished = await runWithWorkingLoader(
    ctx,
    async () => {
      const sourceClean = await isGitWorktreeClean(pi, ctx.cwd);
      if (sourceClean.ok === false) {
        ctx.ui.notify(sourceClean.message, "error");
        return false;
      }
      if (!sourceClean.clean) {
        ctx.ui.notify(
          `Source branch ${target.sourceBranch} has uncommitted changes. Please commit or stash them before finishing.`,
          "warning",
        );
        return false;
      }

      const workClean = await isGitWorktreeClean(pi, target.worktreePath);
      if (workClean.ok === false) {
        if (!fs.existsSync(target.worktreePath)) {
          skippedMergeForMissingWorktree = true;
          return true;
        }

        ctx.ui.notify(workClean.message, "error");
        return false;
      }
      if (!workClean.clean) {
        ctx.ui.notify(
          `Work branch ${target.workBranch} has uncommitted changes. Please commit or stash them before finishing.`,
          "warning",
        );
        return false;
      }

      if (!(await confirmRecentCommitsBeforeMerge(pi, ctx, target))) {
        return false;
      }

      const mergeResult = await runWt(
        pi,
        ctx.cwd,
        buildFinishMergeArgs(target.workBranch),
      );
      if (mergeResult.code !== 0) {
        ctx.ui.notify(
          formatCommandError(mergeResult, "Failed to merge TODO branch"),
          "error",
        );
        return false;
      }

      const commitResult = await runGit(pi, ctx.cwd, [
        "commit",
        "-m",
        finishCommitMessage,
      ]);
      if (commitResult.code !== 0) {
        ctx.ui.notify(
          formatCommandError(commitResult, "Failed to commit TODO merge"),
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
  if (skippedMergeForMissingWorktree) {
    ctx.ui.notify(
      `Worktree path is missing; marked TODO done without merge: ${target.worktreePath}`,
      "warning",
    );
    ctx.ui.notify(`Completed TODO: ${completed.description}`, "info");
    return;
  }

  const cleanupNow = await ctx.ui.confirm(
    `Clean up worktree/branch for "${target.description}"?`,
    `${target.workBranch}${target.worktreePath ? ` • ${target.worktreePath}` : ""}`,
  );
  if (cleanupNow) {
    await runCleanupOneFlow(pi, ctx, target.id);
  }

  ctx.ui.notify(`Completed TODO: ${completed.description}`, "info");
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
      `TODO "${target.description}" is not merged into ${target.sourceBranch} yet.`,
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
    ctx.ui.notify(`Cleaned TODO: ${target.description}`, "info");
    return;
  }

  ctx.ui.notify(
    `Partially cleaned TODO: ${target.description} (${failures.join(" | ")})`,
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
    buildLiteralArgumentCompletionItem(
      "cleanup",
      "--all",
      "cleanup all merged todos",
    ),
    ...candidates.map((todo) =>
      buildTodoArgumentCompletionItem("cleanup", todo),
    ),
  ];
}

export async function getTodoCompletionArgumentCompletions(
  pi: ExtensionAPI,
  argumentPrefix: string,
): Promise<AutocompleteItem[] | null> {
  const { tokens, current } = parseCompletionPrefix(argumentPrefix);
  if (tokens.length === 0) {
    return filterCompletionItems(getTodoCompletionActionItems(), current);
  }

  const repoRoot = process.cwd();
  const [command] = tokens;
  if (command === "finish" && tokens.length === 1) {
    return filterCompletionItems(
      filterTodosForCommand("finish", getDoingTodos(repoRoot)).map((todo) =>
        buildTodoArgumentCompletionItem("finish", todo),
      ),
      current,
    );
  }

  if (command === "cleanup" && tokens.length === 1) {
    const items = await buildCleanupCompletionItems(pi, repoRoot);
    return filterCompletionItems(items, current);
  }

  return null;
}

export async function handleTodoCompletionCommand(
  pi: ExtensionAPI,
  rawArgs: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  let action = parseTodoCompletionArgs(rawArgs);
  if (action.kind === "error") {
    ctx.ui.notify(action.message, "error");
    return;
  }

  if (action.kind === "menu") {
    const selected = await chooseTodoCompletionMenuAction(ctx);
    if (!selected) {
      return;
    }
    action = selected;
  }

  switch (action.kind) {
    case "finish":
      await runFinishFlow(pi, ctx, action.id, action.commitMessage);
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
