/**
 * Tasks store — pure CRUD operations over TasksDb.
 *
 * Functional Core: every function takes a TasksDb (value in) and returns a
 * new TasksDb or data derived from it (value out). No IO, no side effects,
 * no globals. Testing is trivial: build a Db, call, assert.
 */

import { randomUUID } from "node:crypto";
import type {
  BoardMoveInput,
  Comment,
  CreateCommentInput,
  CreateFolderInput,
  CreateLabelInput,
  CreateProjectInput,
  CreateTaskInput,
  Folder,
  Label,
  ListTasksInput,
  Project,
  Task,
  TaskSort,
  TasksDb,
  UpdateTaskInput,
} from "./contract.ts";
import { TASK_PRIORITIES, TASK_STATUSES } from "./contract.ts";

export type {
  BoardMoveInput,
  Comment,
  CreateCommentInput,
  CreateFolderInput,
  CreateLabelInput,
  CreateProjectInput,
  CreateTaskInput,
  Folder,
  Label,
  ListTasksInput,
  Project,
  Task,
  TaskSort,
  TasksDb,
  UpdateTaskInput,
} from "./contract.ts";

export function emptyDb(): TasksDb {
  return {
    version: 1,
    folders: [],
    projects: [],
    tasks: [],
    labels: [],
    comments: [],
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function newId(): string {
  return randomUUID();
}

/* ------------------------------------------------------------------ */
/*  Helpers (pure)                                                     */
/* ------------------------------------------------------------------ */

export function findProject(db: TasksDb, projectId: string): Project | null {
  return db.projects.find((p) => p.id === projectId) ?? null;
}

export function findTask(db: TasksDb, taskId: string): Task | null {
  return db.tasks.find((t) => t.id === taskId) ?? null;
}

export function findTaskByKey(db: TasksDb, taskKey: string): Task | null {
  const key = taskKey.trim().toUpperCase();
  return db.tasks.find((t) => t.key.toUpperCase() === key) ?? null;
}

export function findLabel(db: TasksDb, labelId: string): Label | null {
  return db.labels.find((l) => l.id === labelId) ?? null;
}

export function nextTaskNumber(db: TasksDb, projectId: string): number {
  const project = findProject(db, projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);
  return project.nextTaskNumber;
}

export function taskKeyFor(db: TasksDb, projectId: string): string {
  const project = findProject(db, projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);
  return `${project.prefix}-${project.nextTaskNumber}`;
}

/** Keys of top-level tasks ordered by status group then position. */
export function orderedTaskKeys(tasks: readonly Task[]): string[] {
  return [...tasks]
    .sort((a, b) => {
      const statusOrder = [
        "backlog",
        "todo",
        "in_progress",
        "in_review",
        "done",
        "canceled",
      ];
      const sa = statusOrder.indexOf(a.status);
      const sb = statusOrder.indexOf(b.status);
      if (sa !== sb) return sa - sb;
      return a.position - b.position;
    })
    .map((t) => t.key);
}

/* ------------------------------------------------------------------ */
/*  Folder CRUD                                                        */
/* ------------------------------------------------------------------ */

export function createFolder(
  db: TasksDb,
  input: CreateFolderInput,
): { db: TasksDb; folder: Folder } {
  const folder: Folder = {
    id: newId(),
    name: input.name.trim(),
    parentFolderId: input.parentFolderId,
    createdAt: nowIso(),
  };
  return {
    db: { ...db, folders: [...db.folders, folder] },
    folder,
  };
}

export function listFolders(db: TasksDb): Folder[] {
  return db.folders;
}

export function deleteFolder(
  db: TasksDb,
  folderId: string,
): { db: TasksDb; deleted: boolean } {
  if (!db.folders.some((f) => f.id === folderId)) {
    return { db, deleted: false };
  }
  // Unlink projects from this folder; drop nested children.
  return {
    db: {
      ...db,
      folders: db.folders.filter(
        (f) => f.id !== folderId && f.parentFolderId !== folderId,
      ),
      projects: db.projects.map((p) =>
        p.folderId === folderId ? { ...p, folderId: null } : p,
      ),
    },
    deleted: true,
  };
}

/* ------------------------------------------------------------------ */
/*  Project CRUD                                                       */
/* ------------------------------------------------------------------ */

export function createProject(
  db: TasksDb,
  input: CreateProjectInput,
): { db: TasksDb; project: Project } {
  const prefix = input.prefix.toUpperCase();
  if (db.projects.some((p) => p.prefix.toUpperCase() === prefix)) {
    throw new Error(`Project prefix already in use: ${prefix}`);
  }
  const project: Project = {
    id: newId(),
    name: input.name.trim(),
    prefix,
    nextTaskNumber: 1,
    color: input.color,
    folderId: input.folderId ?? null,
    createdAt: nowIso(),
  };
  return { db: { ...db, projects: [...db.projects, project] }, project };
}

export function listProjects(db: TasksDb, folderId?: string): Project[] {
  if (folderId === undefined) return db.projects;
  return db.projects.filter((p) => p.folderId === folderId);
}

export function deleteProject(
  db: TasksDb,
  projectId: string,
): { db: TasksDb; deleted: boolean } {
  if (!findProject(db, projectId)) return { db, deleted: false };
  const taskIds = new Set(
    db.tasks.filter((t) => t.projectId === projectId).map((t) => t.id),
  );
  return {
    db: {
      ...db,
      projects: db.projects.filter((p) => p.id !== projectId),
      tasks: db.tasks.filter((t) => t.projectId !== projectId),
      labels: db.labels.filter((l) => l.projectId !== projectId),
      comments: db.comments.filter((c) => !taskIds.has(c.taskId)),
    },
    deleted: true,
  };
}

/* ------------------------------------------------------------------ */
/*  Label CRUD                                                         */
/* ------------------------------------------------------------------ */

export function createLabel(
  db: TasksDb,
  input: CreateLabelInput,
): { db: TasksDb; label: Label } {
  const label: Label = {
    id: newId(),
    projectId: input.projectId,
    name: input.name.trim(),
    color: input.color,
  };
  return { db: { ...db, labels: [...db.labels, label] }, label };
}

export function listLabels(db: TasksDb, projectId: string): Label[] {
  return db.labels.filter((l) => l.projectId === projectId);
}

export function deleteLabel(
  db: TasksDb,
  labelId: string,
): { db: TasksDb; deleted: boolean } {
  if (!db.labels.some((l) => l.id === labelId)) {
    return { db, deleted: false };
  }
  // Remove the label and strip it from any task's labelIds.
  return {
    db: {
      ...db,
      labels: db.labels.filter((l) => l.id !== labelId),
      tasks: db.tasks.map((t) =>
        t.labelIds.includes(labelId)
          ? { ...t, labelIds: t.labelIds.filter((id) => id !== labelId) }
          : t,
      ),
    },
    deleted: true,
  };
}

/* ------------------------------------------------------------------ */
/*  Task CRUD                                                          */
/* ------------------------------------------------------------------ */

export function createTask(
  db: TasksDb,
  input: CreateTaskInput,
): { db: TasksDb; task: Task } {
  const project = findProject(db, input.projectId);
  if (!project) throw new Error(`Project not found: ${input.projectId}`);
  const parentTaskId = input.parentTaskId ?? null;
  if (parentTaskId !== null && !findTask(db, parentTaskId)) {
    throw new Error(`Parent task not found: ${parentTaskId}`);
  }
  const status = input.status ?? "backlog";
  const priority = input.priority ?? "none";
  if (!TASK_STATUSES.includes(status)) {
    throw new Error(
      `Invalid status: ${status}. Expected one of ${TASK_STATUSES.join("|")}`,
    );
  }
  if (!TASK_PRIORITIES.includes(priority)) {
    throw new Error(
      `Invalid priority: ${priority}. Expected one of ${TASK_PRIORITIES.join("|")}`,
    );
  }
  const labelIds = input.labelIds ?? [];
  // Validate labelIds belong to the project (when provided).
  for (const labelId of labelIds) {
    const label = findLabel(db, labelId);
    if (!label || label.projectId !== input.projectId) {
      throw new Error(`Label not found in project: ${labelId}`);
    }
  }

  const number = project.nextTaskNumber;
  const task: Task = {
    id: newId(),
    projectId: input.projectId,
    number,
    key: `${project.prefix}-${number}`,
    title: input.title.trim(),
    description: input.description ?? "",
    status,
    priority,
    dueDate: input.dueDate ?? null,
    parentTaskId,
    position: 0,
    labelIds,
    delegation: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  // Siblings get positions 0..n in creation order (append at end).
  const siblings = db.tasks
    .filter((t) => t.parentTaskId === parentTaskId && t.status === input.status)
    .map((t) => t.id);
  const position = siblings.length;

  return {
    db: {
      ...db,
      tasks: [
        ...db.tasks.map((t) => (siblings.includes(t.id) ? t : t)),
        { ...task, position },
      ],
      projects: db.projects.map((p) =>
        p.id === input.projectId
          ? { ...p, nextTaskNumber: p.nextTaskNumber + 1 }
          : p,
      ),
    },
    task: { ...task, position },
  };
}

export function updateTask(
  db: TasksDb,
  input: UpdateTaskInput,
): { db: TasksDb; task: Task } {
  const existing = findTask(db, input.taskId);
  if (!existing) throw new Error(`Task not found: ${input.taskId}`);
  if (input.status !== undefined && !TASK_STATUSES.includes(input.status)) {
    throw new Error(
      `Invalid status: ${input.status}. Expected one of ${TASK_STATUSES.join("|")}`,
    );
  }
  if (
    input.priority !== undefined &&
    !TASK_PRIORITIES.includes(input.priority)
  ) {
    throw new Error(
      `Invalid priority: ${input.priority}. Expected one of ${TASK_PRIORITIES.join("|")}`,
    );
  }

  const next: Task = {
    ...existing,
    title: input.title !== undefined ? input.title.trim() : existing.title,
    description:
      input.description !== undefined
        ? input.description
        : existing.description,
    status: input.status ?? existing.status,
    priority: input.priority ?? existing.priority,
    dueDate: input.dueDate !== undefined ? input.dueDate : existing.dueDate,
    labelIds: input.labelIds ?? existing.labelIds,
    updatedAt: nowIso(),
  };

  // Status-driven delegation teardown: leaving in_progress clears it.
  const settled = clearDelegationIfSettled(
    {
      ...db,
      tasks: db.tasks.map((t) => (t.id === next.id ? next : t)),
    },
    next.id,
  );
  return {
    db: settled,
    task: settled.tasks.find((t) => t.id === next.id) ?? next,
  };
}

/* ------------------------------------------------------------------ */
/*  Delegation                                                         */
/* ------------------------------------------------------------------ */

export interface DelegateTaskInput {
  taskId: string;
  /** herdr agent id / pane label */
  agentId: string;
}

/**
 * Delegate a task to a herdr agent.
 *
 * Pure function: validates the task exists and is not already delegated,
 * advances backlog/todo to in_progress, sets the delegation field, and adds
 * a system comment. Throws on invalid state (caller rolls back IO).
 */
export function delegateTask(
  db: TasksDb,
  input: DelegateTaskInput,
): { db: TasksDb; task: Task; comment: Comment } {
  const existing = findTask(db, input.taskId);
  if (!existing) throw new Error(`Task not found: ${input.taskId}`);
  if (existing.delegation != null) {
    throw new Error(
      `Task ${existing.key} is already delegated to ${existing.delegation?.agentId}`,
    );
  }

  const startedAt = nowIso();
  const next: Task = {
    ...existing,
    status:
      existing.status === "backlog" || existing.status === "todo"
        ? "in_progress"
        : existing.status,
    delegation: { agentId: input.agentId, startedAt },
    updatedAt: startedAt,
  };

  const comment: Comment = {
    id: newId(),
    taskId: existing.id,
    kind: "system",
    authorName: "Tasks",
    body: `Delegated to agent "${input.agentId}" at ${startedAt}`,
    createdAt: startedAt,
  };

  return {
    db: {
      ...db,
      tasks: db.tasks.map((t) => (t.id === next.id ? next : t)),
      comments: [...db.comments, comment],
    },
    task: next,
    comment,
  };
}

/**
 * Clear the delegation field once the task leaves in_progress (status-driven
 * teardown). Returns the new db; no-op when there is nothing to clear.
 */
export function clearDelegationIfSettled(db: TasksDb, taskId: string): TasksDb {
  const existing = findTask(db, taskId);
  if (!existing || existing.delegation == null) return db;
  if (existing.status === "in_progress") return db;
  return {
    ...db,
    tasks: db.tasks.map((t) =>
      t.id === taskId ? { ...t, delegation: null, updatedAt: nowIso() } : t,
    ),
  };
}

/**
 * Record worktree info on a task's delegation after the worktree is created.
 * No-op when the task is not delegated. Pure function.
 */
export function updateDelegationWorktree(
  db: TasksDb,
  taskId: string,
  info: { worktreePath: string; branch: string; workspaceId: string },
): TasksDb {
  const existing = findTask(db, taskId);
  if (!existing || existing.delegation == null) return db;
  return {
    ...db,
    tasks: db.tasks.map((t) =>
      t.id === taskId
        ? {
            ...t,
            delegation: {
              agentId: existing.delegation.agentId,
              startedAt: existing.delegation.startedAt,
              worktreePath: info.worktreePath,
              branch: info.branch,
              workspaceId: info.workspaceId,
            },
          }
        : t,
    ),
  };
}

/**
 * Clear only the worktree portion of a task's delegation (after the user
 * removes the worktree). Keeps agentId/startedAt. Returns the new db plus
 * the created system comment, or null when there is no worktree info.
 */
export function clearWorktreeInfo(
  db: TasksDb,
  taskId: string,
): { db: TasksDb; comment: Comment | null } {
  const existing = findTask(db, taskId);
  if (
    !existing ||
    existing.delegation == null ||
    existing.delegation.worktreePath == null
  ) {
    return { db, comment: null };
  }
  const removedPath = existing.delegation.worktreePath;
  const delegation =
    existing.delegation.branch != null ||
    existing.delegation.workspaceId != null
      ? {
          agentId: existing.delegation.agentId,
          startedAt: existing.delegation.startedAt,
        }
      : null;
  const comment: Comment = {
    id: newId(),
    taskId: existing.id,
    kind: "system",
    authorName: "Tasks",
    body: `Worktree removed: ${removedPath}`,
    createdAt: nowIso(),
  };
  return {
    db: {
      ...db,
      tasks: db.tasks.map((t) =>
        t.id === taskId ? { ...t, delegation, updatedAt: nowIso() } : t,
      ),
      comments: [...db.comments, comment],
    },
    comment,
  };
}

export function deleteTask(
  db: TasksDb,
  taskId: string,
): { db: TasksDb; deleted: boolean } {
  if (!findTask(db, taskId)) return { db, deleted: false };
  const descendantIds = new Set<string>([taskId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of db.tasks) {
      if (
        t.parentTaskId !== null &&
        descendantIds.has(t.parentTaskId) &&
        !descendantIds.has(t.id)
      ) {
        descendantIds.add(t.id);
        changed = true;
      }
    }
  }
  return {
    db: {
      ...db,
      tasks: db.tasks.filter((t) => !descendantIds.has(t.id)),
      comments: db.comments.filter((c) => !descendantIds.has(c.taskId)),
    },
    deleted: true,
  };
}

/**
 * Move a task to a new status (board drag). Reorders siblings:
 * - beforeTaskId/afterTaskId both provided: insert between them
 * - only beforeTaskId: insert at that sibling's position
 * - only afterTaskId: insert after that sibling
 * - neither: append at the end of the status group
 */
export function boardMove(
  db: TasksDb,
  input: BoardMoveInput,
): { db: TasksDb; task: Task } {
  const existing = findTask(db, input.taskId);
  if (!existing) throw new Error(`Task not found: ${input.taskId}`);
  if (!TASK_STATUSES.includes(input.status)) {
    throw new Error(
      `Invalid status: ${input.status}. Expected one of ${TASK_STATUSES.join("|")}`,
    );
  }

  const group = db.tasks
    .filter(
      (t) =>
        t.id !== input.taskId &&
        t.parentTaskId === existing.parentTaskId &&
        t.status === input.status,
    )
    .sort((a, b) => a.position - b.position);

  const insertIndex = (() => {
    if (input.afterTaskId !== null && input.afterTaskId !== undefined) {
      const idx = group.findIndex((t) => t.id === input.afterTaskId);
      if (idx !== -1) return idx + 1;
    }
    if (input.beforeTaskId !== null && input.beforeTaskId !== undefined) {
      const idx = group.findIndex((t) => t.id === input.beforeTaskId);
      if (idx !== -1) return idx;
    }
    return group.length;
  })();

  group.splice(insertIndex, 0, { ...existing, position: 0 });

  const moved = group.map((t, i) => ({ ...t, position: i }));
  const updated = { ...existing, status: input.status, updatedAt: nowIso() };

  const nextDb: TasksDb = {
    ...db,
    tasks: db.tasks.map((t) => {
      if (t.id === input.taskId) return updated;
      const replacement = moved.find((m) => m.id === t.id);
      return replacement ?? t;
    }),
  };
  // Status-driven delegation teardown (board drag to done/canceled etc).
  const settled = clearDelegationIfSettled(nextDb, input.taskId);
  return {
    db: settled,
    task: settled.tasks.find((t) => t.id === input.taskId) ?? updated,
  };
}

/* ------------------------------------------------------------------ */
/*  Task listing                                                       */
/* ------------------------------------------------------------------ */

function sortTasks(tasks: Task[], sort: TaskSort): Task[] {
  const sorted = [...tasks];
  switch (sort) {
    case "created":
      sorted.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      break;
    case "updated":
      sorted.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      break;
    case "priority": {
      const order = ["urgent", "high", "medium", "low", "none"];
      sorted.sort(
        (a, b) => order.indexOf(a.priority) - order.indexOf(b.priority),
      );
      break;
    }
    case "due_date":
      sorted.sort((a, b) =>
        (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999"),
      );
      break;
    case "key":
      sorted.sort((a, b) => a.key.localeCompare(b.key));
      break;
    case "manual":
      sorted.sort((a, b) => {
        const statusOrder = [
          "backlog",
          "todo",
          "in_progress",
          "in_review",
          "done",
          "canceled",
        ];
        const sa = statusOrder.indexOf(a.status);
        const sb = statusOrder.indexOf(b.status);
        if (sa !== sb) return sa - sb;
        return a.position - b.position;
      });
      break;
  }
  return sorted;
}

export function listTasks(db: TasksDb, input: ListTasksInput): Task[] {
  let tasks = db.tasks.filter((t) => {
    if (input.projectId !== undefined && t.projectId !== input.projectId)
      return false;
    if (
      input.statuses &&
      input.statuses.length > 0 &&
      !input.statuses.includes(t.status)
    )
      return false;
    if (
      input.priorities &&
      input.priorities.length > 0 &&
      !input.priorities.includes(t.priority)
    )
      return false;
    if (input.labelIds && input.labelIds.length > 0) {
      if (!input.labelIds.every((id) => t.labelIds.includes(id))) return false;
    }
    if (input.parentTaskId !== undefined) {
      if (input.parentTaskId === null) {
        if (t.parentTaskId !== null) return false;
      } else if (t.parentTaskId !== input.parentTaskId) {
        return false;
      }
    }
    if (input.search) {
      const q = input.search.toLowerCase();
      const hay = `${t.key} ${t.title} ${t.description}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  tasks = sortTasks(tasks, input.sort);
  return tasks.slice(0, input.limit);
}

/* ------------------------------------------------------------------ */
/*  Comments                                                           */
/* ------------------------------------------------------------------ */

export function createComment(
  db: TasksDb,
  input: CreateCommentInput,
): { db: TasksDb; comment: Comment } {
  if (!findTask(db, input.taskId)) {
    throw new Error(`Task not found: ${input.taskId}`);
  }
  const comment: Comment = {
    id: newId(),
    taskId: input.taskId,
    kind: input.kind ?? "user",
    authorName: input.authorName ?? "You",
    body: input.body,
    createdAt: nowIso(),
  };
  return { db: { ...db, comments: [...db.comments, comment] }, comment };
}

export function listComments(db: TasksDb, taskId: string): Comment[] {
  return db.comments
    .filter((c) => c.taskId === taskId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/* ------------------------------------------------------------------ */
/*  Subtasks                                                           */
/* ------------------------------------------------------------------ */

export function listSubtasks(db: TasksDb, taskId: string): Task[] {
  return db.tasks
    .filter((t) => t.parentTaskId === taskId)
    .sort((a, b) => a.position - b.position);
}

export function listTopLevelTasks(db: TasksDb, projectId?: string): Task[] {
  return db.tasks
    .filter(
      (t) =>
        t.parentTaskId === null &&
        (projectId === undefined || t.projectId === projectId),
    )
    .sort((a, b) => {
      const statusOrder = [
        "backlog",
        "todo",
        "in_progress",
        "in_review",
        "done",
        "canceled",
      ];
      const sa = statusOrder.indexOf(a.status);
      const sb = statusOrder.indexOf(b.status);
      if (sa !== sb) return sa - sb;
      return a.position - b.position;
    });
}
