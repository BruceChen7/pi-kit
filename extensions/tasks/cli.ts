/**
 * Tasks CLI commands — /issue ...  (Imperative Shell).
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { defaultDbPath, readDb, withDb } from "./db.ts";
import {
  delegatedAgentLabel,
  removeWorktree,
  runDelegation,
} from "./delegate.ts";
import { openTasksBoard } from "./glimpse-host.ts";
import { getDefaultProjectRoot } from "./paths.ts";
import * as S from "./store.ts";

function notify(
  ctx: ExtensionCommandContext,
  lines: string[],
  kind: "info" | "warning" | "error" = "info",
) {
  ctx.ui.notify(lines.join("\n"), kind);
}

function parseArgs(args: string): string[] {
  // Minimal parser: whitespace split with double-quoted groups.
  const tokens: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  for (let m = re.exec(args); m !== null; m = re.exec(args)) {
    tokens.push(m[1] !== undefined ? m[1] : m[2]);
  }
  return tokens;
}

function getProjectRoot(): string {
  return getDefaultProjectRoot();
}

export function registerCommands(pi: ExtensionAPI) {
  pi.registerCommand("issue", {
    description:
      "Manage tasks (tracker): project, label, folder, create, list, show, update, comment, delegate, board",
    getArgumentCompletions(prefix: string) {
      const subcommands = [
        "project create",
        "project list",
        "label create",
        "label list",
        "label delete",
        "folder create",
        "folder list",
        "folder delete",
        "create",
        "list",
        "show",
        "update",
        "comment",
        "board",
        "delegate",
        "worktree-remove",
      ];
      return subcommands
        .filter((c) => c.startsWith(prefix))
        .map((c) => ({ label: c, value: c }));
    },
    async handler(args: string, ctx) {
      const [sub, ...rest] = parseArgs(args);
      const dbPath = defaultDbPath(getProjectRoot());

      switch (sub) {
        case "project": {
          const action = rest[0];
          if (action === "create") {
            const name = rest[1] ?? "";
            const prefix = rest[2] ?? "";
            const color = rest[3] ?? "#6366f1";
            try {
              const created = await withDb(dbPath, (db) => {
                const r = S.createProject(db, {
                  name,
                  prefix,
                  color,
                  folderId: null,
                });
                return { db: r.db, result: r.project };
              });
              notify(ctx, [
                `Project created: ${created.prefix} · ${created.name}`,
              ]);
            } catch (err) {
              notify(ctx, [`Failed: ${err}`], "error");
            }
          } else if (action === "list" || action === undefined) {
            const projects = await withDb(dbPath, (db) => ({
              db,
              result: S.listProjects(db),
            }));
            if (projects.length === 0) {
              notify(ctx, [
                "No projects yet. Use /issue project create <name> <prefix> <color>",
              ]);
            } else {
              notify(
                ctx,
                projects.map((p) => `${p.prefix}  ${p.name}  (${p.id})`),
              );
            }
          } else {
            notify(
              ctx,
              [`Unknown project action: ${action}. Use create or list.`],
              "warning",
            );
          }
          return;
        }

        case "label": {
          const action = rest[0];
          const projectRef = rest[1] ?? "";
          if (action === "create") {
            const name = rest[2] ?? "";
            const color = rest[3] ?? "#3b82f6";
            if (!projectRef || !name) {
              notify(
                ctx,
                ["Usage: /issue label create <prefix> <name> [color]"],
                "warning",
              );
              return;
            }
            try {
              const label = await withDb<{
                ok: boolean;
                label?: import("./contract.ts").Label;
                error?: string;
              }>(dbPath, (db) => {
                const project = db.projects.find(
                  (p) => p.prefix.toUpperCase() === projectRef.toUpperCase(),
                );
                if (!project) {
                  return {
                    db,
                    result: {
                      ok: false,
                      label: undefined,
                      error: `Project not found: ${projectRef}`,
                    },
                  };
                }
                const r = S.createLabel(db, {
                  projectId: project.id,
                  name,
                  color,
                });
                return {
                  db: r.db,
                  result: { ok: true, label: r.label, error: undefined },
                };
              });
              if (!label.ok) {
                notify(ctx, [label.error], "warning");
              } else {
                notify(ctx, [
                  `Label created: ${label.label.name} (${label.label.color})`,
                ]);
              }
            } catch (err) {
              notify(ctx, [`Failed: ${err}`], "error");
            }
          } else if (action === "list") {
            const labels = await withDb<{
              ok: boolean;
              labels?: import("./contract.ts").Label[];
              error?: string;
            }>(dbPath, (db) => {
              const project = db.projects.find(
                (p) => p.prefix.toUpperCase() === projectRef.toUpperCase(),
              );
              if (!project)
                return {
                  db,
                  result: {
                    ok: false,
                    labels: undefined,
                    error: `Project not found: ${projectRef}`,
                  },
                };
              return {
                db,
                result: {
                  ok: true,
                  labels: S.listLabels(db, project.id),
                  error: undefined,
                },
              };
            });
            if (!labels.ok) {
              notify(ctx, [`Project not found: ${projectRef}`], "warning");
            } else if (labels.labels.length === 0) {
              notify(ctx, [
                "No labels yet. Use /issue label create <prefix> <name> <color>",
              ]);
            } else {
              notify(
                ctx,
                labels.labels.map((l) => `${l.name}  ${l.color}`),
              );
            }
          } else if (action === "delete") {
            const name = rest[2] ?? "";
            const result = await withDb<{
              ok: boolean;
              error?: string;
            }>(dbPath, (db) => {
              const project = db.projects.find(
                (p) => p.prefix.toUpperCase() === projectRef.toUpperCase(),
              );
              if (!project) {
                return {
                  db,
                  result: {
                    ok: false,
                    error: `Project not found: ${projectRef}`,
                  },
                };
              }
              const label = db.labels.find(
                (l) =>
                  l.projectId === project.id &&
                  l.name.toLowerCase() === name.toLowerCase(),
              );
              if (!label) {
                return {
                  db,
                  result: { ok: false, error: `Label not found: ${name}` },
                };
              }
              const r = S.deleteLabel(db, label.id);
              return { db: r.db, result: { ok: true, error: undefined } };
            });
            if (!result.ok) {
              notify(ctx, [result.error], "warning");
            } else {
              notify(ctx, [`Label deleted: ${name}`]);
            }
          } else {
            notify(
              ctx,
              [
                "Usage: /issue label create|list|delete <prefix> <name> [color]",
              ],
              "warning",
            );
          }
          return;
        }

        case "folder": {
          const action = rest[0];
          if (action === "create") {
            const name = rest[1] ?? "";
            if (!name) {
              notify(ctx, ["Usage: /issue folder create <name>"], "warning");
              return;
            }
            try {
              const folder = await withDb(dbPath, (db) => {
                const r = S.createFolder(db, { name, parentFolderId: null });
                return { db: r.db, result: r.folder };
              });
              notify(ctx, [`Folder created: ${folder.name}`]);
            } catch (err) {
              notify(ctx, [`Failed: ${err}`], "error");
            }
          } else if (action === "list" || action === undefined) {
            const folders = await withDb(dbPath, (db) => ({
              db,
              result: S.listFolders(db),
            }));
            if (folders.length === 0) {
              notify(ctx, ["No folders yet. Use /issue folder create <name>"]);
            } else {
              notify(
                ctx,
                folders.map((f) => f.name),
              );
            }
          } else if (action === "delete") {
            const name = rest[1] ?? "";
            const result = await withDb<{
              ok: boolean;
              error?: string;
            }>(dbPath, (db) => {
              const folder = db.folders.find((f) => f.name === name);
              if (!folder) {
                return {
                  db,
                  result: { ok: false, error: `Folder not found: ${name}` },
                };
              }
              const r = S.deleteFolder(db, folder.id);
              return { db: r.db, result: { ok: true, error: undefined } };
            });
            if (!result.ok) {
              notify(ctx, [result.error], "warning");
            } else {
              notify(ctx, [`Folder deleted: ${name}`]);
            }
          } else {
            notify(
              ctx,
              ["Usage: /issue folder create|list|delete <name>"],
              "warning",
            );
          }
          return;
        }

        case "create": {
          const title = rest[0] ?? "";
          if (!title) {
            notify(
              ctx,
              [
                "Usage: /issue create <title> [--project PREFIX] [--priority p] [--status s] [--parent KEY] [--label NAME]",
              ],
              "warning",
            );
            return;
          }
          let projectPrefix: string | null = null;
          let priority = "none";
          let status = "backlog";
          let parentKey: string | null = null;
          const labelNames: string[] = [];
          for (let i = 1; i < rest.length; i++) {
            if (rest[i] === "--project") projectPrefix = rest[i + 1] ?? null;
            if (rest[i] === "--priority") priority = rest[i + 1] ?? "none";
            if (rest[i] === "--status") status = rest[i + 1] ?? "backlog";
            if (rest[i] === "--parent") parentKey = rest[i + 1] ?? null;
            if (rest[i] === "--label") {
              const v = rest[i + 1];
              if (v) labelNames.push(v);
            }
          }
          try {
            const task = await withDb<{
              ok: boolean;
              task?: import("./contract.ts").Task;
              error?: string;
            }>(dbPath, (db) => {
              const project = projectPrefix
                ? db.projects.find(
                    (p) =>
                      p.prefix.toUpperCase() === projectPrefix.toUpperCase(),
                  )
                : db.projects[0];
              if (!project) {
                return {
                  db,
                  result: {
                    ok: false,
                    task: undefined,
                    error:
                      "No project found. Create one with /issue project create.",
                  },
                };
              }
              // Resolve optional parent key.
              let parentTaskId: string | null = null;
              if (parentKey) {
                const parent = S.findTaskByKey(db, parentKey);
                if (!parent) {
                  return {
                    db,
                    result: {
                      ok: false,
                      task: undefined,
                      error: `Parent task not found: ${parentKey}`,
                    },
                  };
                }
                parentTaskId = parent.id;
              }
              // Resolve label names.
              const labelIds: string[] = [];
              for (const name of labelNames) {
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
                      task: undefined,
                      error: `Label not found in project: ${name}`,
                    },
                  };
                }
                labelIds.push(label.id);
              }
              const { db: nextDb, task } = S.createTask(db, {
                projectId: project.id,
                title,
                priority: priority as import("./contract.ts").TaskPriority,
                status: status as import("./contract.ts").TaskStatus,
                parentTaskId,
                labelIds,
              });
              return {
                db: nextDb,
                result: { ok: true, task, error: undefined },
              };
            });
            if (task.error) {
              notify(ctx, [task.error], "warning");
            } else if (task.task) {
              notify(ctx, [`Created ${task.task.key}: ${task.task.title}`]);
            }
          } catch (err) {
            notify(ctx, [`Failed: ${err}`], "error");
          }
          return;
        }

        case "list": {
          const projects = await withDb(dbPath, (db) => ({
            db,
            result: S.listProjects(db),
          }));
          const projectId = projects[0]?.id;
          if (!projectId) {
            notify(ctx, ["No projects yet."], "warning");
            return;
          }
          const tasks = await withDb(dbPath, (db) => ({
            db,
            result: S.listTasks(db, { projectId, sort: "manual", limit: 100 }),
          }));
          if (tasks.length === 0) {
            notify(ctx, ["No tasks yet. Use /issue create <title>"]);
          } else {
            notify(
              ctx,
              tasks.map((t) => `${t.key}  ${t.status.padEnd(12)} ${t.title}`),
            );
          }
          return;
        }

        case "show": {
          const key = rest[0] ?? "";
          const { task, comments, subtasks } = await withDb(dbPath, (db) => {
            const t = S.findTaskByKey(db, key);
            if (!t) {
              return {
                db,
                result: { task: null, comments: [], subtasks: [] },
              };
            }
            return {
              db,
              result: {
                task: t,
                comments: S.listComments(db, t.id),
                subtasks: S.listSubtasks(db, t.id),
              },
            };
          });
          if (!task) {
            notify(ctx, [`Task not found: ${key}`], "warning");
          } else {
            const lines = [
              `${task.key} · ${task.title}`,
              `Status: ${task.status}  Priority: ${task.priority}`,
              `Description: ${task.description || "(none)"}`,
              `Created: ${task.createdAt}`,
            ];
            if (subtasks.length > 0) {
              lines.push("", `Subtasks (${subtasks.length}):`);
              for (const s of subtasks) {
                lines.push(`  ${s.key}  ${s.status.padEnd(12)} ${s.title}`);
              }
            }
            if (comments.length > 0) {
              lines.push("", `Comments (${comments.length}):`);
              for (const c of comments) {
                lines.push(
                  `  [${c.authorName} · ${c.createdAt.slice(0, 10)}] ${c.body}`,
                );
              }
            }
            notify(ctx, lines);
          }
          return;
        }

        case "update": {
          const key = rest[0] ?? "";
          if (!key) {
            notify(
              ctx,
              [
                "Usage: /issue update <key> [--status s] [--priority p] [--title t]",
              ],
              "warning",
            );
            return;
          }
          let status: string | undefined;
          let priority: string | undefined;
          let title: string | undefined;
          for (let i = 1; i < rest.length; i++) {
            if (rest[i] === "--status") status = rest[i + 1];
            if (rest[i] === "--priority") priority = rest[i + 1];
            if (rest[i] === "--title") title = rest[i + 1];
          }
          try {
            const result = await withDb<{
              ok: boolean;
              updated?: import("./contract.ts").Task;
              error?: string;
            }>(dbPath, (db) => {
              const task = S.findTaskByKey(db, key);
              if (!task)
                return {
                  db,
                  result: {
                    ok: false,
                    updated: undefined,
                    error: "Task not found",
                  },
                };
              const { db: nextDb, task: updated } = S.updateTask(db, {
                taskId: task.id,
                status: status as import("./contract.ts").TaskStatus,
                priority: priority as import("./contract.ts").TaskPriority,
                title,
              });
              return {
                db: nextDb,
                result: { ok: true, updated, error: undefined },
              };
            });
            if (result.error) {
              notify(ctx, [result.error], "warning");
            } else if (result.updated) {
              const u = result.updated;
              notify(ctx, [`Updated ${u.key}: ${u.status} · ${u.title}`]);
            }
          } catch (err) {
            notify(ctx, [`Failed: ${err}`], "error");
          }
          return;
        }

        case "comment": {
          const key = rest[0] ?? "";
          const body = rest[1] ?? "";
          if (!key || !body) {
            notify(ctx, ["Usage: /issue comment <key> <body>"], "warning");
            return;
          }
          try {
            const result = await withDb<{ ok: boolean; error?: string }>(
              dbPath,
              (db) => {
                const task = S.findTaskByKey(db, key);
                if (!task)
                  return { db, result: { ok: false, error: "Task not found" } };
                const { db: nextDb } = S.createComment(db, {
                  taskId: task.id,
                  body,
                  authorName: "You",
                  kind: "user",
                });
                return { db: nextDb, result: { ok: true, error: undefined } };
              },
            );
            if (result.error) {
              notify(ctx, [result.error], "warning");
            } else {
              notify(ctx, [`Comment added to ${key}`]);
            }
          } catch (err) {
            notify(ctx, [`Failed: ${err}`], "error");
          }
          return;
        }

        case "worktree-remove": {
          const key = rest[0] ?? "";
          if (!key) {
            notify(
              ctx,
              ["Usage: /issue worktree-remove <key> [--force]"],
              "warning",
            );
            return;
          }
          let force = false;
          for (let i = 1; i < rest.length; i++) {
            if (rest[i] === "--force") force = true;
          }
          try {
            const task = await withDb<import("./contract.ts").Task | null>(
              dbPath,
              (db) => ({ db, result: S.findTaskByKey(db, key) }),
            );
            if (!task) {
              notify(ctx, [`Task not found: ${key}`], "warning");
              return;
            }
            if (!task.delegation?.worktreePath) {
              notify(ctx, [`Task ${key} has no worktree to remove`], "warning");
              return;
            }
            await removeWorktree(pi, task, { force });
            const cleared = await withDb<{ ok: boolean; error?: string }>(
              dbPath,
              (db) => {
                const r = S.clearWorktreeInfo(db, task.id);
                if (!r.comment) {
                  return {
                    db,
                    result: { ok: false, error: "No worktree info to clear" },
                  };
                }
                return { db: r.db, result: { ok: true } };
              },
            );
            if (!cleared.ok) {
              notify(
                ctx,
                [cleared.error ?? "Failed to clear worktree info"],
                "warning",
              );
              return;
            }
            notify(ctx, [
              `Worktree removed: ${task.delegation.worktreePath}`,
              `Branch ${task.delegation.branch ?? ""} left for review/merge.`,
            ]);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await withDb(dbPath, (db) => {
              const r = S.createComment(db, {
                taskId: S.findTaskByKey(db, key)?.id ?? "",
                kind: "system",
                authorName: "Tasks",
                body: `Worktree removal failed: ${message}`,
              });
              return { db: r.db, result: null };
            });
            notify(ctx, [`Worktree removal failed: ${message}`], "error");
          }
          return;
        }

        case "board": {
          notify(ctx, ["Opening board view..."]);
          try {
            await openTasksBoard(getProjectRoot());
          } catch (err) {
            notify(ctx, [`Failed to open board: ${err}`], "error");
          }
          return;
        }

        case "delegate": {
          const key = rest[0] ?? "";
          if (!key) {
            notify(
              ctx,
              ['Usage: /issue delegate <key> [--instructions "..."]'],
              "warning",
            );
            return;
          }
          let instructions: string | undefined;
          let useWorktree = false;
          for (let i = 1; i < rest.length; i++) {
            if (rest[i] === "--instructions") instructions = rest[i + 1];
            if (rest[i] === "--worktree") useWorktree = true;
          }
          const projectRoot = getProjectRoot();
          try {
            const result = await withDb<{
              ok: boolean;
              task?: import("./contract.ts").Task;
              error?: string;
            }>(dbPath, (db) => {
              const task = S.findTaskByKey(db, key);
              if (!task) {
                return {
                  db,
                  result: {
                    ok: false,
                    task: undefined,
                    error: `Task not found: ${key}`,
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
                  result: { ok: true, task: r.task, error: undefined },
                };
              } catch (err) {
                return {
                  db,
                  result: {
                    ok: false,
                    task: undefined,
                    error: err instanceof Error ? err.message : String(err),
                  },
                };
              }
            });
            if (!result.ok || !result.task) {
              notify(ctx, [result.error ?? "Delegation failed"], "warning");
              return;
            }
            // Store committed; now spawn (side effects). On spawn failure,
            // roll back the store and record a failure comment.
            try {
              const d = await runDelegation(
                pi,
                await readDb(dbPath),
                result.task,
                {
                  projectRoot,
                  instructions,
                  worktree: useWorktree,
                },
              );
              if (d.worktreePath && d.branch && d.workspaceId && result.task) {
                await withDb(dbPath, (db) => ({
                  db: S.updateDelegationWorktree(db, result.task.id, {
                    worktreePath: d.worktreePath,
                    branch: d.branch,
                    workspaceId: d.workspaceId,
                  }),
                  result: null,
                }));
              }
              const lines = [
                `Delegated ${result.task.key} to herdr agent "${delegatedAgentLabel(result.task)}".`,
                "The agent is working in a new herdr tab; progress lands in task comments.",
              ];
              if (d.worktreePath && d.branch) {
                lines.push(
                  `Worktree: ${d.branch} @ ${d.worktreePath}`,
                  "Clean up later with /issue worktree-remove " +
                    result.task.key +
                    ".",
                );
              }
              notify(ctx, lines);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              await withDb(dbPath, (db) => {
                const r = S.createComment(db, {
                  taskId: result.task?.id ?? "",
                  kind: "system",
                  authorName: "Tasks",
                  body: `Delegation failed: ${message}`,
                });
                return { db: r.db, result: null };
              });
              notify(
                ctx,
                [`Delegation failed: ${message}`, "Task state unchanged."],
                "error",
              );
            }
          } catch (err) {
            notify(ctx, [`Failed: ${err}`], "error");
          }
          return;
        }

        default:
          notify(
            ctx,
            [
              "Usage: /issue <command>",
              "  project create <name> <prefix> [color]",
              "  project list",
              "  label create|list|delete <prefix> <name> [color]",
              "  folder create|list|delete <name>",
              "  create <title> [--project P] [--priority p] [--status s] [--parent KEY] [--label NAME]",
              "  list",
              "  show <key>",
              "  update <key> [--status s] [--priority p] [--title t]",
              "  comment <key> <body>",
              '  delegate <key> [--instructions "..."]',
              "  board",
            ],
            "info",
          );
      }
    },
  });
}
