/**
 * Tasks delegation — Imperative Shell.
 *
 * Orchestrates delegating a task to a herdr pane running a full pi session:
 *  1. pure: buildSeedPrompt() — task snapshot + report-back contract
 *  2. side effects: pi.exec("herdr", ...) to create tab/pane and spawn pi
 *
 * Pure prompt building lives here so it can be tested without herdr.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Comment, Project, Task, TasksDb } from "./contract.ts";
import * as S from "./store.ts";

export const MAX_AGENT_LABEL_LENGTH = 120;

/** Pane/agent display label: "<KEY> · <title>" truncated. */
export function delegatedAgentLabel(task: Task): string {
  const label = `${task.key} · ${task.title}`;
  return label.slice(0, MAX_AGENT_LABEL_LENGTH);
}

/**
 * Slugify a string for branch/path use: lowercase alphanumerics kept,
 * everything else becomes '-', trimmed of leading/trailing dashes.
 * Mirrors herdr's branch_to_path_slug behavior.
 */
export function branchToPathSlug(value: string): string {
  let slug = "";
  let lastWasDash = false;
  for (const ch of value.toLowerCase()) {
    if (/[a-z0-9]/.test(ch)) {
      slug += ch;
      lastWasDash = false;
    } else if (!lastWasDash) {
      slug += "-";
      lastWasDash = true;
    }
  }
  return slug.replace(/^-+|-+$/g, "") || "task";
}

/** Branch name: "task/<KEY>-<title-slug>" (slug truncated to 60 chars). */
export function buildWorktreeBranch(task: Task): string {
  const slug = branchToPathSlug(task.title).slice(0, 60).replace(/-+$/g, "");
  return `task/${task.key.toLowerCase()}-${slug}`;
}

/**
 * Worktree path: "<worktreeDir>/<repoName>.<key-lower>".
 * Matches the legacy todos worktree convention (~/work/<repo>.<slug>).
 */
export function buildWorktreePath(
  worktreeDir: string,
  repoName: string,
  task: Task,
): string {
  const repoSlug = branchToPathSlug(repoName);
  return `${worktreeDir.replace(/\/+$/g, "")}/${repoSlug}.${task.key.toLowerCase()}`;
}

function markdownSection(title: string, body: string): string {
  return `## ${title}\n\n${body}`;
}

function formatSubtasks(db: TasksDb, task: Task): string {
  const subtasks = S.listSubtasks(db, task.id);
  if (subtasks.length === 0) return "None.";
  return subtasks
    .map((s) => `- ${s.key} · ${s.title} (${s.status})`)
    .join("\n");
}

function formatComments(comments: readonly Comment[]): string {
  if (comments.length === 0) return "None.";
  return comments
    .map((c) => `### ${c.authorName} · ${c.kind} · ${c.createdAt}\n\n${c.body}`)
    .join("\n\n");
}

export interface BuildSeedPromptInput {
  task: Task;
  project: Project;
  db: TasksDb;
  /** Repo root where the delegated agent should work (absolute path). */
  projectRoot: string;
  extraInstructions?: string;
  /** Worktree mode: branch + path of the delegated worktree. */
  worktree?: { branch: string; path: string };
}

export function buildSeedPrompt(input: BuildSeedPromptInput): string {
  const sections = [
    `# ${input.task.key} · ${input.task.title}`,
    markdownSection(
      "Description",
      input.task.description.trim() || "No description provided.",
    ),
    markdownSection(
      "Project context",
      [
        `- Project: ${input.project.name} (prefix ${input.project.prefix})`,
        `- Project root: ${input.projectRoot}`,
        `- Working directory: ${input.worktree?.path ?? input.projectRoot}`,
      ].join("\n"),
    ),
  ];

  if (input.worktree) {
    sections.push(
      markdownSection(
        "Worktree",
        [
          `- Branch: ${input.worktree.branch}`,
          `- Path: ${input.worktree.path}`,
          "你在这个 worktree 中工作。所有修改都发生在该 worktree，不要碰主 checkout。",
        ].join("\n"),
      ),
    );
  }

  sections.push(
    markdownSection("Sub-tasks", formatSubtasks(input.db, input.task)),
    markdownSection(
      "Recent comments",
      formatComments(S.listComments(input.db, input.task.id)),
    ),
    markdownSection(
      "Report-back contract",
      [
        `You are delegated to work on task ${input.task.key}.`,
        `Use the task tools (loaded via the tasks extension):`,
        `- task_show (taskKey: "${input.task.key}") — read the full task anytime`,
        `- task_comment (taskKey, body, authorName) — post progress updates`,
        `- task_update (taskKey, status) — set status when done`,
        ``,
        `Required workflow:`,
        `1. Read the task first (task_show ${input.task.key}).`,
        `2. Work on the task with your normal tools.`,
        `3. Leave substantive milestone comments as you progress.`,
        `4. When done: task_update status → in_review, then a final summary comment.`,
        `   If blocked: explain the blockage in a comment and set status to in_review.`,
      ].join("\n"),
    ),
  );

  if (input.extraInstructions?.trim()) {
    sections.push(
      markdownSection("Extra instructions", input.extraInstructions.trim()),
    );
  }

  return `${sections.join("\n\n")}\n`;
}

/* ------------------------------------------------------------------ */
/*  Orchestration (side effects)                                       */
/* ------------------------------------------------------------------ */

export interface DelegateOptions {
  projectRoot: string;
  instructions?: string;
  /** Worktree mode: create a git worktree and spawn the agent there. */
  worktree?: boolean;
}

export interface DelegateResult {
  tabId: string;
  paneId: string;
  agentLabel: string;
  /** Worktree mode: created worktree info. */
  worktreePath?: string;
  branch?: string;
  workspaceId?: string;
}

/**
 * Resolve the herdr worktree directory: prefer the HERDR_WORKTREE_DIR env,
 * else ~/work (legacy convention), else ~/.herdr/worktrees.
 */
export function worktreeDirectory(): string {
  const env = process.env.HERDR_WORKTREE_DIR;
  if (env) return env;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  const legacy = `${home}/work`;
  const fs = require("node:fs") as typeof import("node:fs");
  return fs.existsSync(legacy) ? legacy : `${home}/.herdr/worktrees`;
}

/**
 * Run the actual delegation: create a herdr tab + pane (or worktree + tab in
 * worktree mode), write the seed prompt, and spawn a full pi session in the
 * pane.
 *
 * All steps are side-effecting; on failure the caller rolls back the store
 * (delegation field + status stay untouched) and records a system comment.
 */
export async function runDelegation(
  pi: ExtensionAPI,
  db: TasksDb,
  task: Task,
  options: DelegateOptions,
): Promise<DelegateResult> {
  const project = db.projects.find((p) => p.id === task.projectId);
  if (!project) throw new Error(`Project not found: ${task.projectId}`);

  const agentLabel = delegatedAgentLabel(task);
  const runDir = await mkdtemp(path.join(tmpdir(), "tasks-delegate-"));

  // Worktree mode: create the worktree first (side effect), then build the
  // prompt with the worktree context and spawn in its tab.
  let worktreePath: string | undefined;
  let branch: string | undefined;
  let workspaceId = "";
  let tabId: string | undefined;

  try {
    if (options.worktree) {
      branch = buildWorktreeBranch(task);
      const repoName = path.basename(options.projectRoot);
      worktreePath = buildWorktreePath(worktreeDirectory(), repoName, task);
      const wtResponse = await pi.exec(
        "herdr",
        [
          "worktree",
          "create",
          "--cwd",
          options.projectRoot,
          "--branch",
          branch,
          "--path",
          worktreePath,
          "--label",
          agentLabel,
          "--focus",
        ],
        { timeout: 30_000 },
      );
      if (wtResponse.code !== 0) {
        throw new Error(
          (
            wtResponse.stderr ||
            wtResponse.stdout ||
            "worktree create failed"
          ).trim(),
        );
      }
      const created = parseCreatedResponse(wtResponse.stdout);
      workspaceId = created.workspaceId;
      tabId = created.tabId;
    }

    const promptPath = path.join(runDir, "prompt.md");
    const prompt = buildSeedPrompt({
      task,
      project,
      db,
      projectRoot: options.projectRoot,
      extraInstructions: options.instructions,
      worktree:
        options.worktree && branch && worktreePath
          ? { branch, path: worktreePath }
          : undefined,
    });
    await writeFile(promptPath, prompt, "utf8");

    // Non-worktree mode: create a tab (with cwd so the pane starts in the
    // project root). Worktree mode: reuse the tab herdr just opened.
    if (!options.worktree) {
      const tabResponse = await pi.exec(
        "herdr",
        [
          "tab",
          "create",
          "--cwd",
          options.projectRoot,
          "--label",
          agentLabel,
          "--env",
          `HERDR_TASK_DELEGATED=1`,
        ],
        { timeout: 10_000 },
      );
      if (tabResponse.code !== 0) {
        throw new Error(
          (
            tabResponse.stderr ||
            tabResponse.stdout ||
            "tab create failed"
          ).trim(),
        );
      }
      const created = parseCreatedResponse(tabResponse.stdout);
      workspaceId = created.workspaceId;
      tabId = created.tabId;
    }

    // The created tab's root pane is where we spawn the agent. For tabs
    // created by us (both modes), root_pane is the single fresh pane.
    const paneId = await resolvePaneId(pi, workspaceId, tabId);

    // Rename the pane to the agent label.
    await pi.exec("herdr", ["pane", "rename", paneId, agentLabel], {
      timeout: 10_000,
    });

    // Spawn a full pi session in the pane. No --tools whitelist: the
    // delegated agent loads all extensions (task tools included) and has
    // normal edit/bash capabilities.
    const command = [
      "env",
      `HERDR_TASK_DELEGATED=1`,
      `HERDR_TASK_KEY=${task.key}`,
      "pi",
      "--name",
      agentLabel,
      "--no-skills",
      "--no-prompt-templates",
      `@${promptPath}`,
    ]
      .map(shellQuote)
      .join(" ");

    const runResponse = await pi.exec(
      "herdr",
      ["pane", "run", paneId, command],
      {
        timeout: 15_000,
      },
    );
    if (runResponse.code !== 0) {
      throw new Error(
        (runResponse.stderr || runResponse.stdout || "pane run failed").trim(),
      );
    }

    return {
      tabId,
      paneId,
      agentLabel,
      worktreePath,
      branch,
      workspaceId: workspaceId || undefined,
    };
  } catch (error) {
    // Clean up the temp prompt dir; the tab/pane/worktree are left for inspection.
    await rm(runDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Remove a task's worktree via herdr: resolve the workspace id (from the
 * delegation record, falling back to `worktree list --cwd`), then remove.
 */
export async function removeWorktree(
  pi: ExtensionAPI,
  task: Task,
  options: { force?: boolean } = {},
): Promise<void> {
  const worktreePath = task.delegation?.worktreePath;
  if (!worktreePath) {
    throw new Error(`Task ${task.key} has no worktree to remove`);
  }
  let workspaceId = task.delegation?.workspaceId ?? "";

  if (!workspaceId) {
    const listResponse = await pi.exec(
      "herdr",
      ["worktree", "list", "--cwd", worktreePath],
      { timeout: 10_000 },
    );
    if (listResponse.code !== 0) {
      throw new Error(
        (
          listResponse.stderr ||
          listResponse.stdout ||
          "worktree list failed"
        ).trim(),
      );
    }
    const listJson = parseJson(listResponse.stdout) ?? {};
    const listResult =
      typeof listJson.result === "object" && listJson.result !== null
        ? (listJson.result as Record<string, unknown>)
        : {};
    const worktrees = (listResult.worktrees ?? []) as Array<
      Record<string, unknown>
    >;
    // Each entry carries open_workspace_id (herdr worktree_list schema).
    const entry = worktrees.find((w) => w.path === worktreePath);
    workspaceId = String(entry?.open_workspace_id ?? entry?.workspace_id ?? "");
  }

  if (!workspaceId) {
    throw new Error(`Could not resolve herdr workspace for ${worktreePath}`);
  }

  const args = ["worktree", "remove", "--workspace", workspaceId];
  if (options.force) args.push("--force");
  const removeResponse = await pi.exec("herdr", args, { timeout: 15_000 });
  if (removeResponse.code !== 0) {
    throw new Error(
      (
        removeResponse.stderr ||
        removeResponse.stdout ||
        "worktree remove failed"
      ).trim(),
    );
  }
}

function parseJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Extract tab/workspace/pane ids from a herdr "created" response. Real
 * response shape (herdr api/schema/response.rs):
 *   result: { tab: { tab_id, workspace_id, ... },
 *             root_pane: { pane_id, tab_id, workspace_id, ... },
 *             workspace: { id, ... }, worktree: {...} }
 * Both `tab create` (TabCreated) and `worktree create` (WorktreeCreated)
 * share this shape.
 */
function parseCreatedResponse(raw: string): {
  tabId: string;
  workspaceId: string;
  paneId: string;
} {
  const json = parseJson(raw) ?? {};
  const result =
    typeof json.result === "object" && json.result !== null
      ? (json.result as Record<string, unknown>)
      : {};
  const tab =
    typeof result.tab === "object" && result.tab !== null
      ? (result.tab as Record<string, unknown>)
      : {};
  const rootPane =
    typeof result.root_pane === "object" && result.root_pane !== null
      ? (result.root_pane as Record<string, unknown>)
      : {};
  const workspace =
    typeof result.workspace === "object" && result.workspace !== null
      ? (result.workspace as Record<string, unknown>)
      : {};
  return {
    tabId: String(tab.tab_id ?? ""),
    workspaceId: String(
      workspace.id ?? tab.workspace_id ?? rootPane.workspace_id ?? "",
    ),
    paneId: String(rootPane.pane_id ?? ""),
  };
}

/**
 * Resolve the pane to spawn in for a tab. Prefers the root pane reported at
 * creation (fresh tab = single pane), falling back to a pane list lookup.
 */
async function resolvePaneId(
  pi: ExtensionAPI,
  workspaceId: string,
  tabId: string,
): Promise<string> {
  // Try pane list first (authoritative current state).
  const paneResponse = await pi.exec(
    "herdr",
    ["pane", "list", "--workspace", workspaceId],
    { timeout: 10_000 },
  );
  if (paneResponse.code === 0) {
    const paneJson = parseJson(paneResponse.stdout) ?? {};
    const paneResult =
      typeof paneJson.result === "object" && paneJson.result !== null
        ? (paneJson.result as Record<string, unknown>)
        : {};
    const panes = (paneResult.panes ?? []) as Array<Record<string, unknown>>;
    const pane = panes.find((p) => p.tab_id === tabId);
    if (pane?.pane_id) return String(pane.pane_id);
  }
  throw new Error(`No pane found for tab ${tabId}`);
}

export function shellQuote(value: string): string {
  // Simple POSIX quoting: wrap in single quotes, escaping embedded quotes.
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
