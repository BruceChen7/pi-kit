/**
 * Tasks UI bridge — Imperative Shell.
 *
 * Host side of the Glimpse ↔ window message channel:
 *  - window → host: "message" events (via window.glimpse.send)
 *  - host → window: send(js) evaluating window.dispatchEvent(CustomEvent)
 *
 * Every write goes through store pure functions + writeDb, then a full
 * snapshot is broadcast to every registered window. fs.watch catches
 * cross-session writes (herdr child agents) and broadcasts too.
 */

import { watch } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GlimpseWindow } from "../shared/glimpse-window.ts";
import type {
  CreateFolderInput,
  CreateProjectInput,
  CreateTaskInput,
  Task,
  TasksDb,
} from "./contract.ts";
import { readDb, writeDb } from "./db.ts";
import {
  buildSeedPrompt,
  type DelegateOptions,
  runDelegation,
} from "./delegate.ts";
import * as S from "./store.ts";

/* ------------------------------------------------------------------ */
/*  Window registry + broadcast                                        */
/* ------------------------------------------------------------------ */

export type TasksBridgeContext = {
  pi: ExtensionAPI;
  projectRoot: string;
  dbPath: string;
};

const windows = new Map<string, GlimpseWindow>();

export function registerWindow(
  windowId: string,
  win: GlimpseWindow,
  ctx: TasksBridgeContext,
): void {
  windows.set(windowId, win);
  win.on("message", (message) => {
    void handleInbound(ctx, windowId, message);
  });
  // No "closed" event in the shared GlimpseWindow type; dead windows are
  // tolerated by send() try/catch and pruned lazily.
}

function broadcast(
  event: { type: "snapshot"; db: TasksDb } | { type: "error"; message: string },
): void {
  const js = `window.dispatchEvent(new CustomEvent("tasks:${event.type}", { detail: ${escapeJson(event.type === "snapshot" ? event.db : event.message)} }));`;
  for (const win of windows.values()) {
    try {
      win.send?.(js);
    } catch {
      // window may be gone; closed handler will clean up
    }
  }
}

function escapeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/* ------------------------------------------------------------------ */
/*  Inbound protocol                                                   */
/* ------------------------------------------------------------------ */

type Inbound =
  | { type: "get-snapshot" }
  | {
      type: "create-task";
      title: string;
      projectPrefix: string;
      priority?: string;
      status?: string;
      description?: string;
      labelNames?: string[];
      parentKey?: string;
    }
  | {
      type: "create-project";
      name: string;
      prefix: string;
      color: string;
      folderId?: string;
    }
  | {
      type: "update-project";
      projectId: string;
      name?: string;
      color?: string;
      folderId?: string;
    }
  | { type: "delete-project"; projectId: string }
  | { type: "create-folder"; name: string; parentFolderId?: string }
  | {
      type: "update-task";
      taskKey: string;
      status?: string;
      priority?: string;
      title?: string;
      description?: string;
    }
  | {
      type: "board-move";
      taskKey: string;
      status: string;
      beforeKey?: string;
      afterKey?: string;
    }
  | { type: "comment"; taskKey: string; body: string }
  | {
      type: "delegate";
      taskKey: string;
      instructions?: string;
      worktree?: boolean;
      baseBranch?: string;
      branch?: string;
    }
  | { type: "reclaim"; taskKey: string }
  | { type: "delete-task"; taskKey: string }
  | { type: "worktree-remove"; taskKey: string; force?: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readInbound(message: unknown): Inbound | null {
  if (!isRecord(message) || typeof message.type !== "string") return null;
  switch (message.type) {
    case "get-snapshot":
      return { type: "get-snapshot" };
    case "create-task":
      if (typeof message.title !== "string") return null;
      return {
        type: "create-task",
        title: message.title,
        projectPrefix:
          typeof message.projectPrefix === "string"
            ? message.projectPrefix
            : "",
        priority:
          typeof message.priority === "string" ? message.priority : undefined,
        status: typeof message.status === "string" ? message.status : undefined,
        description:
          typeof message.description === "string"
            ? message.description
            : undefined,
        labelNames: Array.isArray(message.labelNames)
          ? message.labelNames.filter((x): x is string => typeof x === "string")
          : undefined,
        parentKey:
          typeof message.parentKey === "string" ? message.parentKey : undefined,
      };
    case "create-project":
      if (
        typeof message.name !== "string" ||
        typeof message.prefix !== "string" ||
        typeof message.color !== "string"
      )
        return null;
      return {
        type: "create-project",
        name: message.name,
        prefix: message.prefix,
        color: message.color,
        folderId:
          typeof message.folderId === "string" ? message.folderId : undefined,
      };
    case "update-project":
      if (typeof message.projectId !== "string") return null;
      return {
        type: "update-project",
        projectId: message.projectId,
        name: typeof message.name === "string" ? message.name : undefined,
        color: typeof message.color === "string" ? message.color : undefined,
        folderId:
          typeof message.folderId === "string" ? message.folderId : undefined,
      };
    case "delete-project":
      if (typeof message.projectId !== "string") return null;
      return { type: "delete-project", projectId: message.projectId };
    case "create-folder":
      if (typeof message.name !== "string") return null;
      return {
        type: "create-folder",
        name: message.name,
        parentFolderId:
          typeof message.parentFolderId === "string"
            ? message.parentFolderId
            : undefined,
      };
    case "update-task":
      if (typeof message.taskKey !== "string") return null;
      return {
        type: "update-task",
        taskKey: message.taskKey,
        status: typeof message.status === "string" ? message.status : undefined,
        priority:
          typeof message.priority === "string" ? message.priority : undefined,
        title: typeof message.title === "string" ? message.title : undefined,
        description:
          typeof message.description === "string"
            ? message.description
            : undefined,
      };
    case "board-move":
      if (
        typeof message.taskKey !== "string" ||
        typeof message.status !== "string"
      )
        return null;
      return {
        type: "board-move",
        taskKey: message.taskKey,
        status: message.status,
        beforeKey:
          typeof message.beforeKey === "string" ? message.beforeKey : undefined,
        afterKey:
          typeof message.afterKey === "string" ? message.afterKey : undefined,
      };
    case "comment":
      if (
        typeof message.taskKey !== "string" ||
        typeof message.body !== "string"
      )
        return null;
      return { type: "comment", taskKey: message.taskKey, body: message.body };
    case "delegate":
      if (typeof message.taskKey !== "string") return null;
      return {
        type: "delegate",
        taskKey: message.taskKey,
        instructions:
          typeof message.instructions === "string"
            ? message.instructions
            : undefined,
        worktree:
          typeof message.worktree === "boolean" ? message.worktree : undefined,
        baseBranch:
          typeof message.baseBranch === "string"
            ? message.baseBranch
            : undefined,
        branch: typeof message.branch === "string" ? message.branch : undefined,
      };
    case "reclaim":
      if (typeof message.taskKey !== "string") return null;
      return { type: "reclaim", taskKey: message.taskKey };
    case "delete-task":
      if (typeof message.taskKey !== "string") return null;
      return { type: "delete-task", taskKey: message.taskKey };
    case "worktree-remove":
      if (typeof message.taskKey !== "string") return null;
      return {
        type: "worktree-remove",
        taskKey: message.taskKey,
        force: typeof message.force === "boolean" ? message.force : undefined,
      };
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Handlers                                                           */
/* ------------------------------------------------------------------ */

async function handleInbound(
  ctx: TasksBridgeContext,
  _windowId: string,
  message: unknown,
): Promise<void> {
  const inbound = readInbound(message);
  if (!inbound) return;

  try {
    switch (inbound.type) {
      case "get-snapshot": {
        const db = await readDb(ctx.dbPath);
        broadcast({ type: "snapshot", db });
        return;
      }

      case "create-task": {
        const db = await readDb(ctx.dbPath);
        const project = S.findProjectByPrefix(db, inbound.projectPrefix);
        if (!project) {
          broadcast({
            type: "error",
            message: `项目不存在: ${inbound.projectPrefix}`,
          });
          return;
        }
        const labelIds = resolveLabelIds(db, project.id, inbound.labelNames);
        const input: CreateTaskInput = {
          projectId: project.id,
          title: inbound.title,
          description: inbound.description ?? "",
          status: (inbound.status as CreateTaskInput["status"]) ?? "backlog",
          priority: (inbound.priority as CreateTaskInput["priority"]) ?? "none",
          labelIds,
          parentTaskId: inbound.parentKey
            ? (S.findTaskByKey(db, inbound.parentKey)?.id ?? null)
            : null,
        };
        await writeTask(ctx, (current) => {
          const r = S.createTask(current, input);
          return { db: r.db, task: r.task };
        });
        return;
      }

      case "create-project": {
        const input: CreateProjectInput = {
          name: inbound.name,
          prefix: inbound.prefix,
          color: inbound.color,
          folderId: inbound.folderId ?? null,
        };
        await withBroadcast(ctx, (db) => S.createProject(db, input));
        return;
      }

      case "update-project": {
        await withBroadcast(ctx, (db) =>
          S.updateProject(db, inbound.projectId, {
            name: inbound.name,
            color: inbound.color,
            folderId: inbound.folderId ?? null,
          }),
        );
        return;
      }

      case "delete-project": {
        await withBroadcast(ctx, (db) => {
          if (!S.findProject(db, inbound.projectId)) {
            throw new Error(`Project not found: ${inbound.projectId}`);
          }
          return S.deleteProject(db, inbound.projectId);
        });
        return;
      }

      case "create-folder": {
        const input: CreateFolderInput = {
          name: inbound.name,
          parentFolderId: inbound.parentFolderId ?? null,
        };
        await withBroadcast(ctx, (db) => S.createFolder(db, input));
        return;
      }

      case "update-task": {
        await withBroadcast(ctx, (db) => {
          const task = S.findTaskByKey(db, inbound.taskKey);
          if (!task) throw new Error(`Task not found: ${inbound.taskKey}`);
          return S.updateTask(db, {
            taskId: task.id,
            title: inbound.title,
            description: inbound.description,
            status: inbound.status as never,
            priority: inbound.priority as never,
          });
        });
        return;
      }

      case "board-move": {
        await withBroadcast(ctx, (db) => {
          const task = S.findTaskByKey(db, inbound.taskKey);
          if (!task) throw new Error(`Task not found: ${inbound.taskKey}`);
          const before = inbound.beforeKey
            ? S.findTaskByKey(db, inbound.beforeKey)
            : null;
          const after = inbound.afterKey
            ? S.findTaskByKey(db, inbound.afterKey)
            : null;
          return S.boardMove(db, {
            taskId: task.id,
            status: inbound.status as never,
            beforeTaskId: before?.id ?? null,
            afterTaskId: after?.id ?? null,
          });
        });
        return;
      }

      case "comment": {
        await withBroadcast(ctx, (db) => {
          const task = S.findTaskByKey(db, inbound.taskKey);
          if (!task) throw new Error(`Task not found: ${inbound.taskKey}`);
          return S.createComment(db, {
            taskId: task.id,
            kind: "user",
            authorName: "You",
            body: inbound.body,
          });
        });
        return;
      }

      case "reclaim": {
        await withBroadcast(ctx, (db) => {
          const task = S.findTaskByKey(db, inbound.taskKey);
          if (!task) throw new Error(`Task not found: ${inbound.taskKey}`);
          return S.updateTask(db, { taskId: task.id, status: "todo" });
        });
        return;
      }

      case "delete-task": {
        await withBroadcast(ctx, (db) => {
          const task = S.findTaskByKey(db, inbound.taskKey);
          if (!task) throw new Error(`Task not found: ${inbound.taskKey}`);
          const tasksToDelete = collectTaskTree(db, task.id);
          if (
            tasksToDelete.some(
              (candidate) =>
                candidate.status !== "backlog" || candidate.delegation,
            )
          ) {
            throw new Error("仅可删除未委托的 Backlog 任务及其子任务");
          }
          return S.deleteTask(db, task.id);
        });
        return;
      }

      case "delegate": {
        await handleDelegate(ctx, inbound);
        return;
      }

      case "worktree-remove": {
        await handleWorktreeRemove(ctx, inbound.taskKey, inbound.force);
        return;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    broadcast({ type: "error", message });
  }
}

function collectTaskTree(db: TasksDb, taskId: string): Task[] {
  const taskIds = new Set([taskId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of db.tasks) {
      if (
        task.parentTaskId &&
        taskIds.has(task.parentTaskId) &&
        !taskIds.has(task.id)
      ) {
        taskIds.add(task.id);
        changed = true;
      }
    }
  }
  return db.tasks.filter((task) => taskIds.has(task.id));
}

/* ------------------------------------------------------------------ */
/*  Delegate + worktree (side effects, rollback on failure)            */
/* ------------------------------------------------------------------ */

async function handleDelegate(
  ctx: TasksBridgeContext,
  inbound: Extract<Inbound, { type: "delegate" }>,
): Promise<void> {
  const db = await readDb(ctx.dbPath);
  const task = S.findTaskByKey(db, inbound.taskKey);
  if (!task) throw new Error(`Task not found: ${inbound.taskKey}`);
  if (task.delegation != null) {
    throw new Error(`Task ${task.key} is already delegated`);
  }

  const previousStatus = task.status;
  const r = S.delegateTask(db, {
    taskId: task.id,
    agentId: delegateLabel(task),
  });
  await writeDb(ctx.dbPath, r.db);

  try {
    const options: DelegateOptions = {
      projectRoot: ctx.projectRoot,
      instructions: inbound.instructions,
      worktree: inbound.worktree ?? false,
      branch: inbound.branch,
      baseBranch: inbound.baseBranch,
    };
    const d = await runDelegation(
      ctx.pi,
      await readDb(ctx.dbPath),
      r.task,
      options,
    );
    if (d.worktreePath && d.branch && d.workspaceId) {
      const updated = S.updateDelegationWorktree(
        await readDb(ctx.dbPath),
        task.id,
        {
          worktreePath: d.worktreePath,
          branch: d.branch,
          baseBranch: d.baseBranch,
          workspaceId: d.workspaceId,
        },
      );
      await writeDb(ctx.dbPath, updated);
    }
  } catch (err) {
    // Roll back store, keep a failure comment.
    const message = err instanceof Error ? err.message : String(err);
    const rolledBack = S.rollbackDelegation(
      await readDb(ctx.dbPath),
      task.id,
      previousStatus,
    );
    const withComment = S.createComment(rolledBack, {
      taskId: task.id,
      kind: "system",
      authorName: "Tasks",
      body: `Delegation failed: ${message}`,
    });
    await writeDb(ctx.dbPath, withComment.db);
    throw new Error(`Delegation failed: ${message}`);
  }

  broadcastSnapshot(ctx);
}

async function handleWorktreeRemove(
  ctx: TasksBridgeContext,
  taskKey: string,
  force?: boolean,
): Promise<void> {
  const db = await readDb(ctx.dbPath);
  const task = S.findTaskByKey(db, taskKey);
  if (!task) throw new Error(`Task not found: ${taskKey}`);

  await runDelegationRemoveWorktree(ctx.pi, task, { force });

  const result = S.clearWorktreeInfo(await readDb(ctx.dbPath), task.id);
  if (result.comment) {
    await writeDb(ctx.dbPath, result.db);
  }
  broadcastSnapshot(ctx);
}

async function runDelegationRemoveWorktree(
  pi: ExtensionAPI,
  task: Task,
  options: { force?: boolean },
): Promise<void> {
  // Re-exported from delegate.ts to keep side effects in one place.
  const { removeWorktree } = await import("./delegate.ts");
  await removeWorktree(pi, task, options);
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function delegateLabel(task: Task): string {
  return `${task.key} · ${task.title}`.slice(0, 120);
}

function resolveLabelIds(
  db: TasksDb,
  projectId: string,
  names: string[] | undefined,
): string[] {
  if (!names || names.length === 0) return [];
  return db.labels
    .filter((l) => l.projectId === projectId && names.includes(l.name))
    .map((l) => l.id);
}

async function withBroadcast(
  ctx: TasksBridgeContext,
  mutate: (db: TasksDb) => { db: TasksDb },
): Promise<void> {
  const current = await readDb(ctx.dbPath);
  const { db: next } = mutate(current);
  await writeDb(ctx.dbPath, next);
  await broadcastSnapshot(ctx);
}

async function writeTask(
  ctx: TasksBridgeContext,
  mutate: (db: TasksDb) => { db: TasksDb; task: Task },
): Promise<void> {
  const current = await readDb(ctx.dbPath);
  const { db: next } = mutate(current);
  await writeDb(ctx.dbPath, next);
  broadcastSnapshot(ctx);
}

async function broadcastSnapshot(ctx: TasksBridgeContext): Promise<void> {
  const db = await readDb(ctx.dbPath);
  broadcast({ type: "snapshot", db });
}

/* ------------------------------------------------------------------ */
/*  fs.watch: cross-session writes (herdr agents) → broadcast          */
/* ------------------------------------------------------------------ */
//
// Watches the .pi/tasks/ DIRECTORY, not the file: db.ts writes atomically
// (tmp file + rename), and a file-level watcher stops firing after the
// inode is replaced. Directory watchers fire for renames inside the dir.

import { mkdirSync } from "node:fs";
import path from "node:path";
import { TASKS_FILE_NAME } from "./db.ts";

const watchers = new Map<string, ReturnType<typeof watch>>();
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

export function startDbWatcher(ctx: TasksBridgeContext): void {
  if (watchers.has(ctx.dbPath)) return;

  const dir = path.dirname(ctx.dbPath);
  try {
    mkdirSync(dir, { recursive: true });
    const watcher = watch(dir, { persistent: false }, (_event, filename) => {
      if (filename === TASKS_FILE_NAME) {
        scheduleBroadcast(ctx);
      }
    });
    watchers.set(ctx.dbPath, watcher);
  } catch {
    startPolling(ctx);
  }
}

function startPolling(ctx: TasksBridgeContext): void {
  if (pollTimers.has(ctx.dbPath)) return;
  let lastMtime = 0;
  const timer = setInterval(async () => {
    try {
      const { stat } = await import("node:fs/promises");
      const st = await stat(ctx.dbPath);
      if (st.mtimeMs !== lastMtime) {
        lastMtime = st.mtimeMs;
        await broadcastSnapshot(ctx);
      }
    } catch {
      // file missing; keep polling
    }
  }, 3000);
  pollTimers.set(ctx.dbPath, timer);
}

const pollTimers = new Map<string, ReturnType<typeof setInterval>>();

function scheduleBroadcast(ctx: TasksBridgeContext): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void broadcastSnapshot(ctx).catch(() => {});
  }, 100);
}

export function stopDbWatcher(dbPath: string): void {
  const w = watchers.get(dbPath);
  w?.close();
  watchers.delete(dbPath);
  const t = pollTimers.get(dbPath);
  if (t) clearInterval(t);
  pollTimers.delete(dbPath);
}

// Re-export for tests
export { buildSeedPrompt };
