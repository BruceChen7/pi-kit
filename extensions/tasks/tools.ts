/**
 * Tasks agent tools — registered via pi.registerTool.
 *
 * Imperative Shell: thin layer that wires the pure store to the extension API.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { defaultDbPath, readDb, withDb } from "./db.ts";
import { delegatedAgentLabel, runDelegation } from "./delegate.ts";
import * as S from "./store.ts";

function result(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: {},
    isError: false,
  };
}

function errorResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: {},
    isError: true,
  };
}

/** Resolve a project by id or prefix. */
function resolveProject(db: S.TasksDb, projectRef: string) {
  return (
    db.projects.find(
      (p) =>
        p.prefix.toUpperCase() === projectRef.toUpperCase() ||
        p.id === projectRef,
    ) ?? null
  );
}

export function registerTools(pi: ExtensionAPI, getProjectRoot: () => string) {
  pi.registerTool({
    name: "task_create",
    label: "Create Task",
    description:
      "Create a new task in a project. Returns the task key (e.g. TASK-1) and details.",
    parameters: Type.Object({
      projectId: Type.String({
        description: "Project ID or prefix (e.g. TASK)",
      }),
      title: Type.String({ description: "Task title" }),
      description: Type.Optional(
        Type.String({ description: "Task description" }),
      ),
      status: Type.Optional(
        Type.String({
          description: "backlog|todo|in_progress|in_review|done|canceled",
        }),
      ),
      priority: Type.Optional(
        Type.String({ description: "urgent|high|medium|low|none" }),
      ),
      parentTaskKey: Type.Optional(
        Type.String({
          description:
            "Parent task key to create this as a subtask of (e.g. TASK-1)",
        }),
      ),
      labelNames: Type.Optional(
        Type.Array(
          Type.String({
            description:
              "Label names to attach (must already exist in project)",
          }),
        ),
      ),
    }),
    async execute(_callId, params, _signal, _onUpdate, _ctx) {
      try {
        const dbPath = defaultDbPath(getProjectRoot());
        const { ok, task, error } = await withDb(dbPath, (db) => {
          const project = resolveProject(db, String(params.projectId));
          if (!project) {
            return {
              db,
              result: {
                ok: false,
                task: null,
                error: `Project not found: ${params.projectId}`,
              },
            };
          }
          // Resolve parent task key -> id (optional).
          let parentTaskId: string | null = null;
          if (params.parentTaskKey !== undefined) {
            const parent = S.findTaskByKey(db, String(params.parentTaskKey));
            if (!parent) {
              return {
                db,
                result: {
                  ok: false,
                  task: null,
                  error: `Parent task not found: ${params.parentTaskKey}`,
                },
              };
            }
            parentTaskId = parent.id;
          }
          // Resolve label names -> ids (optional).
          const labelIds: string[] = [];
          if (params.labelNames !== undefined) {
            for (const name of params.labelNames as string[]) {
              const label = db.labels.find(
                (l) =>
                  l.projectId === project.id &&
                  l.name.toLowerCase() === name.toLowerCase(),
              );
              if (!label) {
                return {
                  db,
                  result: {
                    ok: false,
                    task: null,
                    error: `Label not found in project: ${name}`,
                  },
                };
              }
              labelIds.push(label.id);
            }
          }
          const { db: nextDb, task } = S.createTask(db, {
            projectId: project.id,
            title: String(params.title),
            description: String(params.description ?? ""),
            status: (params.status as S.CreateTaskInput["status"]) ?? "backlog",
            priority:
              (params.priority as S.CreateTaskInput["priority"]) ?? "none",
            parentTaskId,
            labelIds,
          });
          return { db: nextDb, result: { ok: true, task, error: null } };
        });
        if (!ok) return errorResult(error);
        return result(`Created ${task.key}: ${task.title} (${task.status})`);
      } catch (err) {
        return errorResult(`Failed to create task: ${err}`);
      }
    },
  });

  pi.registerTool({
    name: "task_list",
    label: "List Tasks",
    description: "List tasks in a project with optional filters.",
    parameters: Type.Object({
      projectId: Type.Optional(
        Type.String({ description: "Project ID or prefix" }),
      ),
      statuses: Type.Optional(
        Type.String({ description: "Comma-separated statuses" }),
      ),
      search: Type.Optional(Type.String({ description: "Search text" })),
      limit: Type.Optional(
        Type.Number({ description: "Max results (default 50)" }),
      ),
    }),
    async execute(_callId, params, _signal, _onUpdate, _ctx) {
      try {
        const dbPath = defaultDbPath(getProjectRoot());
        const tasks = await withDb(dbPath, (db) => {
          const projectRef = params.projectId
            ? String(params.projectId)
            : undefined;
          const project = projectRef
            ? resolveProject(db, projectRef)
            : undefined;
          const statuses = params.statuses
            ? String(params.statuses)
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
            : undefined;
          const items = S.listTasks(db, {
            projectId: project?.id ?? projectRef,
            statuses: statuses as S.ListTasksInput["statuses"],
            search: params.search ? String(params.search) : undefined,
            limit: (params.limit as number) ?? 50,
          });
          return { db, result: items };
        });
        if (tasks.length === 0) return result("No tasks found.");
        const lines = tasks.map(
          (t) => `${t.key}  ${t.status.padEnd(12)} ${t.title}`,
        );
        return result(`Tasks (${tasks.length}):\n${lines.join("\n")}`);
      } catch (err) {
        return errorResult(`Failed to list tasks: ${err}`);
      }
    },
  });

  pi.registerTool({
    name: "task_show",
    label: "Show Task",
    description: "Show task details by key (e.g. TASK-1).",
    parameters: Type.Object({
      taskKey: Type.String({ description: "Task key (e.g. TASK-1)" }),
    }),
    async execute(_callId, params, _signal, _onUpdate, _ctx) {
      try {
        const dbPath = defaultDbPath(getProjectRoot());
        const { task, comments, subtasks } = await withDb(dbPath, (db) => {
          const task = S.findTaskByKey(db, String(params.taskKey));
          if (!task)
            return { db, result: { task: null, comments: [], subtasks: [] } };
          const comments = S.listComments(db, task.id);
          const subtasks = S.listSubtasks(db, task.id);
          return { db, result: { task, comments, subtasks } };
        });
        if (!task) return errorResult(`Task not found: ${params.taskKey}`);
        const lines = [
          `${task.key} · ${task.title}`,
          `Status: ${task.status}  Priority: ${task.priority}`,
          `Description: ${task.description || "(none)"}`,
          `Created: ${task.createdAt}`,
        ];
        if (subtasks.length > 0) {
          lines.push(
            "",
            `Subtasks (${subtasks.length}):`,
            ...subtasks.map(
              (s) => `  ${s.key}  ${s.status.padEnd(12)} ${s.title}`,
            ),
          );
        }
        if (comments.length > 0) {
          lines.push("", `Comments (${comments.length}):`);
          for (const c of comments) {
            lines.push(
              `  [${c.authorName} · ${c.createdAt.slice(0, 10)}] ${c.body}`,
            );
          }
        }
        return result(lines.join("\n"));
      } catch (err) {
        return errorResult(`Failed to show task: ${err}`);
      }
    },
  });

  pi.registerTool({
    name: "task_update",
    label: "Update Task",
    description: "Update a task's status, priority, title, or description.",
    parameters: Type.Object({
      taskKey: Type.String({ description: "Task key (e.g. TASK-1)" }),
      title: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      status: Type.Optional(
        Type.String({
          description: "backlog|todo|in_progress|in_review|done|canceled",
        }),
      ),
      priority: Type.Optional(
        Type.String({ description: "urgent|high|medium|low|none" }),
      ),
    }),
    async execute(_callId, params, _signal, _onUpdate, _ctx) {
      try {
        const dbPath = defaultDbPath(getProjectRoot());
        const { ok, updated, error } = await withDb(dbPath, (db) => {
          const task = S.findTaskByKey(db, String(params.taskKey));
          if (!task) {
            return {
              db,
              result: {
                ok: false,
                updated: null,
                error: `Task not found: ${params.taskKey}`,
              },
            };
          }
          const { db: nextDb, task: updated } = S.updateTask(db, {
            taskId: task.id,
            title:
              params.title !== undefined ? String(params.title) : undefined,
            description:
              params.description !== undefined
                ? String(params.description)
                : undefined,
            status: (params.status as S.UpdateTaskInput["status"]) ?? undefined,
            priority:
              (params.priority as S.UpdateTaskInput["priority"]) ?? undefined,
          });
          return { db: nextDb, result: { ok: true, updated, error: null } };
        });
        if (!ok) return errorResult(error);
        return result(
          `Updated ${updated.key}: ${updated.status} · ${updated.title}`,
        );
      } catch (err) {
        return errorResult(`Failed to update task: ${err}`);
      }
    },
  });

  pi.registerTool({
    name: "task_comment",
    label: "Add Task Comment",
    description: "Add a comment to a task.",
    parameters: Type.Object({
      taskKey: Type.String({ description: "Task key (e.g. TASK-1)" }),
      body: Type.String({ description: "Comment body" }),
      authorName: Type.Optional(
        Type.String({ description: "Author name (default: You)" }),
      ),
    }),
    async execute(_callId, params, _signal, _onUpdate, _ctx) {
      try {
        const dbPath = defaultDbPath(getProjectRoot());
        const { ok, error } = await withDb(dbPath, (db) => {
          const task = S.findTaskByKey(db, String(params.taskKey));
          if (!task) {
            return {
              db,
              result: { ok: false, error: `Task not found: ${params.taskKey}` },
            };
          }
          const { db: nextDb } = S.createComment(db, {
            taskId: task.id,
            body: String(params.body),
            authorName: String(params.authorName ?? "You"),
            kind: "user",
          });
          return { db: nextDb, result: { ok: true, error: null } };
        });
        if (!ok) return errorResult(error);
        return result(`Comment added to ${params.taskKey}`);
      } catch (err) {
        return errorResult(`Failed to add comment: ${err}`);
      }
    },
  });

  pi.registerTool({
    name: "task_project_list",
    label: "List Projects",
    description: "List all task projects.",
    parameters: Type.Object({}),
    async execute() {
      try {
        const dbPath = defaultDbPath(getProjectRoot());
        const projects = await withDb(dbPath, (db) => ({
          db,
          result: S.listProjects(db),
        }));
        if (projects.length === 0) return result("No projects yet.");
        const lines = projects.map((p) => `${p.prefix}  ${p.name}  (${p.id})`);
        return result(`Projects:\n${lines.join("\n")}`);
      } catch (err) {
        return errorResult(`Failed to list projects: ${err}`);
      }
    },
  });

  pi.registerTool({
    name: "task_project_create",
    label: "Create Project",
    description:
      "Create a new task project with a unique uppercase prefix (e.g. TASK).",
    parameters: Type.Object({
      name: Type.String({ description: "Project name" }),
      prefix: Type.String({
        description:
          "Uppercase prefix for task keys, e.g. TASK (1-10 chars, starts with a letter)",
      }),
      color: Type.Optional(
        Type.String({
          description: "Hex color for the project (default #6366f1)",
        }),
      ),
    }),
    async execute(_callId, params, _signal, _onUpdate, _ctx) {
      try {
        const dbPath = defaultDbPath(getProjectRoot());
        const project = await withDb(dbPath, (db) => {
          const r = S.createProject(db, {
            name: String(params.name),
            prefix: String(params.prefix),
            color: String(params.color ?? "#6366f1"),
            folderId: null,
          });
          return { db: r.db, result: r.project };
        });
        return result(`Project created: ${project.prefix} · ${project.name}`);
      } catch (err) {
        return errorResult(`Failed to create project: ${err}`);
      }
    },
  });

  pi.registerTool({
    name: "task_board_move",
    label: "Move Task on Board",
    description:
      "Move a task to a new status column (board drag). Optionally position it before/after a sibling task.",
    parameters: Type.Object({
      taskKey: Type.String({ description: "Task key to move (e.g. TASK-1)" }),
      status: Type.String({
        description:
          "Target status: backlog|todo|in_progress|in_review|done|canceled",
      }),
      beforeTaskKey: Type.Optional(
        Type.String({ description: "Insert before this sibling task key" }),
      ),
      afterTaskKey: Type.Optional(
        Type.String({ description: "Insert after this sibling task key" }),
      ),
    }),
    async execute(_callId, params, _signal, _onUpdate, _ctx) {
      try {
        const dbPath = defaultDbPath(getProjectRoot());
        const { ok, task, error } = await withDb(dbPath, (db) => {
          const task = S.findTaskByKey(db, String(params.taskKey));
          if (!task) {
            return {
              db,
              result: {
                ok: false,
                task: null,
                error: `Task not found: ${params.taskKey}`,
              },
            };
          }
          const beforeTaskId =
            params.beforeTaskKey !== undefined
              ? (S.findTaskByKey(db, String(params.beforeTaskKey))?.id ?? null)
              : undefined;
          const afterTaskId =
            params.afterTaskKey !== undefined
              ? (S.findTaskByKey(db, String(params.afterTaskKey))?.id ?? null)
              : undefined;
          const r = S.boardMove(db, {
            taskId: task.id,
            status: params.status as S.BoardMoveInput["status"],
            beforeTaskId,
            afterTaskId,
          });
          return { db: r.db, result: { ok: true, task: r.task, error: null } };
        });
        if (!ok) return errorResult(error);
        return result(
          `Moved ${task.key} to ${task.status}${task.title ? ` · ${task.title}` : ""}`,
        );
      } catch (err) {
        return errorResult(`Failed to move task: ${err}`);
      }
    },
  });

  pi.registerTool({
    name: "task_delegate",
    label: "Delegate Task",
    description:
      "Delegate a task to a herdr agent: spawns a full pi session in a new herdr tab that works on the task and reports back via task tools. Requires herdr to be available.",
    parameters: Type.Object({
      taskKey: Type.String({
        description: "Task key to delegate (e.g. TASK-1)",
      }),
      instructions: Type.Optional(
        Type.String({
          description: "Extra instructions for the delegated agent",
        }),
      ),
      worktree: Type.Optional(
        Type.Boolean({
          description:
            "Create a git worktree (branch task/<key>-<slug>) and work there instead of the current checkout",
        }),
      ),
    }),
    async execute(_callId, params, _signal, _onUpdate, _ctx) {
      try {
        const dbPath = defaultDbPath(getProjectRoot());
        const projectRoot = getProjectRoot();
        const { ok, task, error } = await withDb<{
          ok: boolean;
          task?: S.Task | null;
          error?: string | null;
        }>(dbPath, (db) => {
          const task = S.findTaskByKey(db, String(params.taskKey));
          if (!task) {
            return {
              db,
              result: {
                ok: false,
                task: null,
                error: `Task not found: ${params.taskKey}`,
              },
            };
          }
          try {
            const r = S.delegateTask(db, {
              taskId: task.id,
              agentId: delegatedAgentLabel(task),
            });
            return {
              db: r.db,
              result: { ok: true, task: r.task, error: null },
            };
          } catch (err) {
            return {
              db,
              result: {
                ok: false,
                task: null,
                error: err instanceof Error ? err.message : String(err),
              },
            };
          }
        });
        if (!ok || !task) {
          return errorResult(error ?? "Delegation failed");
        }
        try {
          const latest = await readDb(dbPath);
          const current = S.findTask(latest, task.id);
          if (!current) return errorResult(`Task disappeared: ${task.key}`);
          const d = await runDelegation(pi, latest, current, {
            projectRoot,
            instructions: params.instructions
              ? String(params.instructions)
              : undefined,
            worktree: params.worktree === true,
          });
          if (d.worktreePath && d.branch && d.workspaceId) {
            await withDb(dbPath, (db) => ({
              db: S.updateDelegationWorktree(db, task.id, {
                worktreePath: d.worktreePath,
                branch: d.branch,
                workspaceId: d.workspaceId,
              }),
              result: null,
            }));
          }
          const wt =
            d.worktreePath && d.branch
              ? ` Worktree: ${d.branch} @ ${d.worktreePath}.`
              : "";
          return result(
            `Delegated ${task.key} to herdr agent "${d.agentLabel}" (tab ${d.tabId}). The agent reports back via task comments.${wt}`,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await withDb(dbPath, (db) => {
            const r = S.createComment(db, {
              taskId: task.id,
              kind: "system",
              authorName: "Tasks",
              body: `Delegation failed: ${message}`,
            });
            return { db: r.db, result: null };
          });
          return errorResult(
            `Delegation failed: ${message}. Task state unchanged (system comment recorded).`,
          );
        }
      } catch (err) {
        return errorResult(`Failed to delegate task: ${err}`);
      }
    },
  });
}
