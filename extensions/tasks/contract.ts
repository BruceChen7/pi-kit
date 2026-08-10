/**
 * Tasks plugin — shared types & validation.
 *
 * Functional Core: pure data shapes, no IO. Mirrors the bb Tasks contract
 * (Linear-style tracker) scoped down to phase 1.
 */

import { z } from "zod";

export const TASK_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "canceled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = [
  "urgent",
  "high",
  "medium",
  "low",
  "none",
] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const COMMENT_KINDS = ["user", "agent", "system"] as const;
export type CommentKind = (typeof COMMENT_KINDS)[number];

export const TASK_SORTS = [
  "created",
  "updated",
  "priority",
  "due_date",
  "key",
  "manual",
] as const;
export type TaskSort = (typeof TASK_SORTS)[number];

export const STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  canceled: "Canceled",
};

export const PRIORITY_LABELS: Record<TaskPriority, string> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
  none: "None",
};

/* ------------------------------------------------------------------ */
/*  Schemas                                                             */
/* ------------------------------------------------------------------ */

const idSchema = z.string().min(1);
const nonBlankSchema = z.string().trim().min(1, "must not be blank");

const projectPrefixSchema = nonBlankSchema
  .max(10)
  .regex(
    /^[A-Z][A-Z0-9]*$/,
    "must be uppercase alphanumeric, start with a letter",
  );

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");

const colorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "must be a hex color");

export const folderSchema = z.object({
  id: idSchema,
  name: nonBlankSchema,
  parentFolderId: idSchema.nullable(),
  createdAt: z.string(),
});

export const projectSchema = z.object({
  id: idSchema,
  name: nonBlankSchema,
  prefix: projectPrefixSchema,
  nextTaskNumber: z.number().int().positive(),
  color: colorSchema,
  folderId: idSchema.nullable(),
  createdAt: z.string(),
});

export const taskSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  number: z.number().int().positive(),
  key: z.string(),
  title: nonBlankSchema,
  description: z.string(),
  status: z.enum(TASK_STATUSES),
  priority: z.enum(TASK_PRIORITIES),
  dueDate: isoDateSchema.nullable(),
  parentTaskId: idSchema.nullable(),
  /** Board position within the status group (ascending). */
  position: z.number(),
  labelIds: z.array(idSchema),
  /** Delegation info: set while the task is delegated to a herdr agent. */
  delegation: z
    .object({
      /** herdr agent id / pane label */
      agentId: z.string(),
      /** Delegation start time ISO */
      startedAt: z.string(),
      /** worktree 模式：worktree 绝对路径 */
      worktreePath: z.string().optional(),
      /** worktree 模式：分支名，如 task/TASK-1-implement-board */
      branch: z.string().optional(),
      /** worktree 模式：worktree 切出的基础分支（herdr worktree create --base） */
      baseBranch: z.string().optional(),
      /** worktree 模式：herdr workspace id（用于 remove） */
      workspaceId: z.string().optional(),
    })
    .nullable()
    .default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const labelSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  name: nonBlankSchema,
  color: colorSchema,
});

export const commentSchema = z.object({
  id: idSchema,
  taskId: idSchema,
  kind: z.enum(COMMENT_KINDS),
  authorName: z.string(),
  body: z.string(),
  createdAt: z.string(),
});

export const tasksDbSchema = z.object({
  version: z.literal(1),
  folders: z.array(folderSchema),
  projects: z.array(projectSchema),
  tasks: z.array(taskSchema),
  labels: z.array(labelSchema),
  comments: z.array(commentSchema),
});

export type Folder = z.infer<typeof folderSchema>;
export type Project = z.infer<typeof projectSchema>;
export type Task = z.infer<typeof taskSchema>;
export type Label = z.infer<typeof labelSchema>;
export type Comment = z.infer<typeof commentSchema>;
export type TasksDb = z.infer<typeof tasksDbSchema>;

/* ------------------------------------------------------------------ */
/*  Input schemas (CRUD operations)                                    */
/* ------------------------------------------------------------------ */

export const createFolderInputSchema = z.object({
  name: nonBlankSchema,
  parentFolderId: idSchema.nullable().default(null),
});
export type CreateFolderInput = z.input<typeof createFolderInputSchema>;

export const createProjectInputSchema = z.object({
  name: nonBlankSchema,
  prefix: projectPrefixSchema,
  color: colorSchema,
  folderId: idSchema.nullable().default(null),
});
export type CreateProjectInput = z.input<typeof createProjectInputSchema>;

export const createTaskInputSchema = z.object({
  projectId: idSchema,
  title: nonBlankSchema,
  description: z.string().default(""),
  status: z.enum(TASK_STATUSES).default("backlog"),
  priority: z.enum(TASK_PRIORITIES).default("none"),
  dueDate: isoDateSchema.nullable().default(null),
  parentTaskId: idSchema.nullable().default(null),
  labelIds: z.array(idSchema).default([]),
});
export type CreateTaskInput = z.input<typeof createTaskInputSchema>;

export const updateTaskInputSchema = z
  .object({
    taskId: idSchema,
    title: nonBlankSchema.optional(),
    description: z.string().optional(),
    status: z.enum(TASK_STATUSES).optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    dueDate: isoDateSchema.nullable().optional(),
    labelIds: z.array(idSchema).optional(),
  })
  .refine(
    (i) =>
      i.title !== undefined ||
      i.description !== undefined ||
      i.status !== undefined ||
      i.priority !== undefined ||
      i.dueDate !== undefined ||
      i.labelIds !== undefined,
    { message: "at least one field must be provided" },
  );
export type UpdateTaskInput = z.input<typeof updateTaskInputSchema>;

export const boardMoveInputSchema = z.object({
  taskId: idSchema,
  status: z.enum(TASK_STATUSES),
  /** Insert before/after these sibling keys (both optional). */
  beforeTaskId: idSchema.nullable().optional(),
  afterTaskId: idSchema.nullable().optional(),
});
export type BoardMoveInput = z.input<typeof boardMoveInputSchema>;

export const listTasksInputSchema = z.object({
  projectId: idSchema.optional(),
  statuses: z.array(z.enum(TASK_STATUSES)).optional(),
  priorities: z.array(z.enum(TASK_PRIORITIES)).optional(),
  labelIds: z.array(idSchema).optional(),
  parentTaskId: idSchema.nullable().optional(),
  search: z.string().optional(),
  sort: z.enum(TASK_SORTS).default("manual"),
  limit: z.number().int().min(1).max(500).default(100),
});
export type ListTasksInput = z.input<typeof listTasksInputSchema>;

export const createLabelInputSchema = z.object({
  projectId: idSchema,
  name: nonBlankSchema,
  color: colorSchema,
});
export type CreateLabelInput = z.input<typeof createLabelInputSchema>;

export const createCommentInputSchema = z.object({
  taskId: idSchema,
  kind: z.enum(COMMENT_KINDS).default("user"),
  authorName: z.string().default("You"),
  body: z.string(),
});
export type CreateCommentInput = z.input<typeof createCommentInputSchema>;
