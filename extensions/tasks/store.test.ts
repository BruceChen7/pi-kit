/**
 * Tasks store — pure function tests.
 *
 * Functional Core: build a Db, call a function, assert the result. No mocks,
 * no IO, no globals.
 */

import { describe, expect, it } from "vitest";
import type { TasksDb } from "./contract.ts";
import * as S from "./store.ts";

function freshDb(): TasksDb {
  return S.emptyDb();
}

function withProject(db: TasksDb, name = "test", prefix = "TST"): TasksDb {
  return S.createProject(db, { name, prefix, color: "#6366f1" }).db;
}

/* ================================================================ */
/*  Folder CRUD                                                      */
/* ================================================================ */

describe("folders", () => {
  it("creates a folder", () => {
    const { db, folder } = S.createFolder(freshDb(), {
      name: "Sprint",
      parentFolderId: null,
    });
    expect(folder.name).toBe("Sprint");
    expect(folder.parentFolderId).toBeNull();
    expect(S.listFolders(db)).toHaveLength(1);
  });

  it("supports nested folders", () => {
    const { db, folder: parent } = S.createFolder(freshDb(), {
      name: "Parent",
      parentFolderId: null,
    });
    const { db: db2 } = S.createFolder(db, {
      name: "Child",
      parentFolderId: parent.id,
    });
    expect(S.listFolders(db2)).toHaveLength(2);
  });

  it("deletes a folder and unlinks projects", () => {
    let db = freshDb();
    const { db: db1, folder } = S.createFolder(db, {
      name: "Sprint",
      parentFolderId: null,
    });
    db = withProject(db1, "p1", "P1");
    db = S.createProject(db, {
      name: "p2",
      prefix: "P2",
      color: "#fff",
      folderId: folder.id,
    }).db;
    const { db: db3, deleted } = S.deleteFolder(db, folder.id);
    expect(deleted).toBe(true);
    expect(S.listFolders(db3)).toHaveLength(0);
    // Projects in the folder are unlinked, not deleted.
    expect(S.listProjects(db3, folder.id)).toHaveLength(0);
    expect(S.listProjects(db3).length).toBe(2);
  });
});

/* ================================================================ */
/*  Project CRUD                                                     */
/* ================================================================ */

describe("projects", () => {
  it("creates a project with auto-increment prefix", () => {
    const { db, project } = S.createProject(freshDb(), {
      name: "pi-kit",
      prefix: "TASK",
      color: "#6366f1",
      folderId: null,
    });
    expect(project.prefix).toBe("TASK");
    expect(project.nextTaskNumber).toBe(1);
    expect(S.listProjects(db)).toHaveLength(1);
  });

  it("rejects duplicate prefix", () => {
    const { db } = S.createProject(freshDb(), {
      name: "a",
      prefix: "TASK",
      color: "#6366f1",
      folderId: null,
    });
    expect(() =>
      S.createProject(db, {
        name: "b",
        prefix: "task",
        color: "#f00",
        folderId: null,
      }),
    ).toThrow("already in use");
  });

  it("deletes project and cascades tasks/labels/comments", () => {
    let db = freshDb();
    const { db: db1, project } = S.createProject(db, {
      name: "p",
      prefix: "P",
      color: "#6366f1",
      folderId: null,
    });
    db = db1;
    const { db: db2, label } = S.createLabel(db, {
      projectId: project.id,
      name: "bug",
      color: "#ef4444",
    });
    db = db2;
    const { db: db3, task } = S.createTask(db, {
      projectId: project.id,
      title: "Fix",
      labelIds: [label.id],
    });
    db = db3;
    const { db: db4 } = S.createComment(db, {
      taskId: task.id,
      kind: "user",
      authorName: "Ming",
      body: "Working",
    });
    db = db4;
    const { db: db5, deleted } = S.deleteProject(db, project.id);
    expect(deleted).toBe(true);
    expect(S.listProjects(db5)).toHaveLength(0);
    expect(S.listLabels(db5, project.id)).toHaveLength(0);
    expect(S.listTasks(db5, { projectId: project.id })).toHaveLength(0);
  });
});

describe("project update", () => {
  it("updates name/color/folder and keeps prefix stable", () => {
    const db = withProject(freshDb());
    const project = S.listProjects(db)[0];
    const { db: db2, project: updated } = S.updateProject(db, project.id, {
      name: "重命名",
      color: "#22c55e",
      folderId: null,
    });
    expect(updated.name).toBe("重命名");
    expect(updated.color).toBe("#22c55e");
    expect(updated.prefix).toBe(project.prefix);
    expect(S.findProject(db2, project.id)?.name).toBe("重命名");
  });

  it("rejects blank name and unknown project", () => {
    const db = withProject(freshDb());
    const project = S.listProjects(db)[0];
    expect(() => S.updateProject(db, project.id, { name: "  " })).toThrow(
      "不能为空",
    );
    expect(() => S.updateProject(db, "nope", { name: "x" })).toThrow(
      "not found",
    );
  });
});

/* ================================================================ */
/*  Label CRUD                                                       */
/* ================================================================ */

describe("labels", () => {
  it("creates a label scoped to a project", () => {
    const db = withProject(freshDb());
    const project = S.listProjects(db)[0];
    const { db: db2, label } = S.createLabel(db, {
      projectId: project.id,
      name: "bug",
      color: "#ef4444",
    });
    expect(label.name).toBe("bug");
    expect(S.listLabels(db2, project.id)).toHaveLength(1);
  });

  it("deletes a label and strips it from tasks", () => {
    let db = withProject(freshDb());
    const project = S.listProjects(db)[0];
    const { db: db2, label } = S.createLabel(db, {
      projectId: project.id,
      name: "bug",
      color: "#ef4444",
    });
    db = db2;
    const { db: db3, task } = S.createTask(db, {
      projectId: project.id,
      title: "Fix bug",
      labelIds: [label.id],
    });
    db = db3;
    expect(task.labelIds).toContain(label.id);

    const { db: db4, deleted } = S.deleteLabel(db, label.id);
    expect(deleted).toBe(true);
    expect(S.listLabels(db4, project.id)).toHaveLength(0);
    expect(S.findTask(db4, task.id)?.labelIds).not.toContain(label.id);
  });

  it("returns deleted=false for unknown label", () => {
    const db = withProject(freshDb());
    const { deleted } = S.deleteLabel(db, "nonexistent");
    expect(deleted).toBe(false);
  });
});

/* ================================================================ */
/*  Task CRUD                                                        */
/* ================================================================ */

describe("task CRUD", () => {
  it("creates a task with auto-increment key", () => {
    const db = withProject(freshDb());
    const project = S.listProjects(db)[0];
    const { db: db2, task } = S.createTask(db, {
      projectId: project.id,
      title: "My task",
    });
    expect(task.key).toBe("TST-1");
    expect(task.number).toBe(1);
    expect(task.status).toBe("backlog");
    expect(task.priority).toBe("none");
    // Next task number increments.
    expect(S.findProject(db2, project.id).nextTaskNumber).toBe(2);
  });

  it("creates multiple tasks with sequential keys", () => {
    let db = withProject(freshDb());
    const project = S.listProjects(db)[0];
    const { db: db2, task: t1 } = S.createTask(db, {
      projectId: project.id,
      title: "First",
    });
    db = db2;
    const { db: db3, task: t2 } = S.createTask(db, {
      projectId: project.id,
      title: "Second",
    });
    expect(t1.key).toBe("TST-1");
    expect(t2.key).toBe("TST-2");
    expect(S.findProject(db3, project.id).nextTaskNumber).toBe(3);
  });

  it("finds task by key (case-insensitive)", () => {
    let db = withProject(freshDb());
    const project = S.listProjects(db)[0];
    const { db: db2, task } = S.createTask(db, {
      projectId: project.id,
      title: "Test",
    });
    db = db2;
    expect(S.findTaskByKey(db, "tst-1")).not.toBeNull();
    expect(S.findTaskByKey(db, "TST-1")?.id).toBe(task.id);
    expect(S.findTaskByKey(db, "TST-999")).toBeNull();
  });

  it("updates task fields", () => {
    let db = withProject(freshDb());
    const project = S.listProjects(db)[0];
    const { db: db2, task } = S.createTask(db, {
      projectId: project.id,
      title: "Old title",
    });
    db = db2;
    const { db: db3, task: updated } = S.updateTask(db, {
      taskId: task.id,
      title: "New title",
      status: "in_progress",
      priority: "high",
    });
    expect(updated.title).toBe("New title");
    expect(updated.status).toBe("in_progress");
    expect(updated.priority).toBe("high");
    expect(S.findTask(db3, task.id)?.title).toBe("New title");
  });

  it("deletes a task and its comments", () => {
    let db = withProject(freshDb());
    const project = S.listProjects(db)[0];
    const { db: db2, task } = S.createTask(db, {
      projectId: project.id,
      title: "Delete me",
    });
    db = db2;
    const { db: db3 } = S.createComment(db, {
      taskId: task.id,
      kind: "user",
      authorName: "Ming",
      body: "Comment",
    });
    db = db3;
    const { db: db4, deleted } = S.deleteTask(db, task.id);
    expect(deleted).toBe(true);
    expect(S.findTask(db4, task.id)).toBeNull();
    expect(S.listComments(db4, task.id)).toHaveLength(0);
  });

  it("deletes cascading subtasks", () => {
    let db = withProject(freshDb());
    const project = S.listProjects(db)[0];
    const { db: db2, task: parent } = S.createTask(db, {
      projectId: project.id,
      title: "Parent",
    });
    db = db2;
    const { db: db3 } = S.createTask(db, {
      projectId: project.id,
      title: "Child",
      parentTaskId: parent.id,
    });
    db = db3;
    const { db: db4, deleted } = S.deleteTask(db, parent.id);
    expect(deleted).toBe(true);
    expect(S.listTasks(db4, { projectId: project.id })).toHaveLength(0);
  });

  it("rejects update on non-existent task", () => {
    const db = withProject(freshDb());
    expect(() => S.updateTask(db, { taskId: "nonexistent-task-id" })).toThrow(
      "not found",
    );
  });
});

/* ================================================================ */
/*  Board move                                                       */
/* ================================================================ */

describe("board move", () => {
  it("moves task to a new status group", () => {
    let db = withProject(freshDb());
    const project = S.listProjects(db)[0];
    const { db: db2, task } = S.createTask(db, {
      projectId: project.id,
      title: "Move me",
      status: "todo",
    });
    db = db2;
    const { db: db3, task: moved } = S.boardMove(db, {
      taskId: task.id,
      status: "in_progress",
    });
    expect(moved.status).toBe("in_progress");
    expect(S.findTask(db3, task.id)?.status).toBe("in_progress");
  });
});

/* ================================================================ */
/*  Task listing                                                     */
/* ================================================================ */

describe("task listing", () => {
  it("filters by project", () => {
    let db = freshDb();
    const { db: db1, project: p1 } = S.createProject(db, {
      name: "p1",
      prefix: "P1",
      color: "#6366f1",
      folderId: null,
    });
    const { db: db2, project: p2 } = S.createProject(db1, {
      name: "p2",
      prefix: "P2",
      color: "#f00",
      folderId: null,
    });
    db = S.createTask(db2, { projectId: p1.id, title: "T1" }).db;
    db = S.createTask(db, { projectId: p2.id, title: "T2" }).db;
    const tasksP1 = S.listTasks(db, { projectId: p1.id });
    expect(tasksP1).toHaveLength(1);
    expect(tasksP1[0].title).toBe("T1");
  });

  it("filters by status", () => {
    let db = withProject(freshDb());
    const project = S.listProjects(db)[0];
    db = S.createTask(db, {
      projectId: project.id,
      title: "T1",
      status: "todo",
    }).db;
    db = S.createTask(db, {
      projectId: project.id,
      title: "T2",
      status: "done",
    }).db;
    const todos = S.listTasks(db, {
      projectId: project.id,
      statuses: ["todo"],
    });
    expect(todos).toHaveLength(1);
  });

  it("searches by text", () => {
    let db = withProject(freshDb());
    const project = S.listProjects(db)[0];
    db = S.createTask(db, { projectId: project.id, title: "Fix login bug" }).db;
    db = S.createTask(db, { projectId: project.id, title: "Add feature" }).db;
    const results = S.listTasks(db, { projectId: project.id, search: "bug" });
    expect(results).toHaveLength(1);
  });

  it("sorts by manual (status group + position)", () => {
    let db = withProject(freshDb());
    const project = S.listProjects(db)[0];
    db = S.createTask(db, {
      projectId: project.id,
      title: "A",
      status: "done",
    }).db;
    db = S.createTask(db, {
      projectId: project.id,
      title: "B",
      status: "todo",
    }).db;
    db = S.createTask(db, {
      projectId: project.id,
      title: "C",
      status: "in_progress",
    }).db;
    const sorted = S.listTasks(db, { projectId: project.id, sort: "manual" });
    expect(sorted[0].title).toBe("B"); // todo
    expect(sorted[1].title).toBe("C"); // in_progress
    expect(sorted[2].title).toBe("A"); // done
  });
});

/* ================================================================ */
/*  Comments                                                         */
/* ================================================================ */

describe("comments", () => {
  it("creates and lists comments in chronological order", () => {
    let db = withProject(freshDb());
    const project = S.listProjects(db)[0];
    const { db: db2, task } = S.createTask(db, {
      projectId: project.id,
      title: "Test",
    });
    db = db2;
    const { db: db3 } = S.createComment(db, {
      taskId: task.id,
      kind: "user",
      authorName: "Ming",
      body: "First",
    });
    const { db: db4 } = S.createComment(db3, {
      taskId: task.id,
      kind: "agent",
      authorName: "Bot",
      body: "Second",
    });
    const comments = S.listComments(db4, task.id);
    expect(comments).toHaveLength(2);
    expect(comments[0].authorName).toBe("Ming");
    expect(comments[1].authorName).toBe("Bot");
  });
});

/* ================================================================ */
/*  Subtasks                                                         */
/* ================================================================ */

describe("subtasks", () => {
  it("lists subtasks of a parent task", () => {
    let db = withProject(freshDb());
    const project = S.listProjects(db)[0];
    const { db: db2, task: parent } = S.createTask(db, {
      projectId: project.id,
      title: "Parent",
    });
    db = db2;
    const { db: db3, task: child } = S.createTask(db, {
      projectId: project.id,
      title: "Child",
      parentTaskId: parent.id,
    });
    db = db3;
    const subtasks = S.listSubtasks(db, parent.id);
    expect(subtasks).toHaveLength(1);
    expect(subtasks[0].id).toBe(child.id);
  });

  it("top-level tasks exclude subtasks", () => {
    let db = withProject(freshDb());
    const project = S.listProjects(db)[0];
    const { db: db2, task: parent } = S.createTask(db, {
      projectId: project.id,
      title: "Parent",
    });
    db = db2;
    S.createTask(db, {
      projectId: project.id,
      title: "Child",
      parentTaskId: parent.id,
    });
    const topLevel = S.listTopLevelTasks(db, project.id);
    expect(topLevel).toHaveLength(1);
    expect(topLevel[0].id).toBe(parent.id);
  });
});

/* ================================================================ */
/*  Delegation                                                       */
/* ================================================================ */

describe("delegation", () => {
  it("delegates a todo task: advances status, sets field, adds system comment", () => {
    let db = withProject(freshDb());
    const project = S.listProjects(db)[0];
    const { db: db2, task } = S.createTask(db, {
      projectId: project.id,
      title: "Delegate me",
      status: "todo",
    });
    db = db2;
    const {
      db: db3,
      task: delegated,
      comment,
    } = S.delegateTask(db, {
      taskId: task.id,
      agentId: "TASK-1 · Delegate me",
    });
    expect(delegated.status).toBe("in_progress");
    expect(delegated.delegation).toEqual({
      agentId: "TASK-1 · Delegate me",
      startedAt: comment.createdAt,
    });
    expect(comment.kind).toBe("system");
    expect(comment.body).toContain("Delegated to agent");
    expect(S.listComments(db3, task.id)).toHaveLength(1);
  });

  it("keeps in_progress status when delegating an already-active task", () => {
    let db = withProject(freshDb());
    const project = S.listProjects(db)[0];
    const { db: db2, task } = S.createTask(db, {
      projectId: project.id,
      title: "Active",
      status: "in_progress",
    });
    db = db2;
    const { task: delegated } = S.delegateTask(db, {
      taskId: task.id,
      agentId: "agent-x",
    });
    expect(delegated.status).toBe("in_progress");
    expect(delegated.delegation?.agentId).toBe("agent-x");
  });

  it("rejects delegating an already-delegated task", () => {
    let db = withProject(freshDb());
    const project = S.listProjects(db)[0];
    const { db: db2, task } = S.createTask(db, {
      projectId: project.id,
      title: "Busy",
    });
    db = db2;
    db = S.delegateTask(db, { taskId: task.id, agentId: "agent-1" }).db;
    expect(() =>
      S.delegateTask(db, { taskId: task.id, agentId: "agent-2" }),
    ).toThrow("already delegated");
  });

  it("rejects delegating a nonexistent task", () => {
    const db = withProject(freshDb());
    expect(() => S.delegateTask(db, { taskId: "nope", agentId: "x" })).toThrow(
      "not found",
    );
  });

  it("clears delegation when task leaves in_progress via update", () => {
    let db = withProject(freshDb());
    const project = S.listProjects(db)[0];
    const { db: db2, task } = S.createTask(db, {
      projectId: project.id,
      title: "Done soon",
    });
    db = db2;
    db = S.delegateTask(db, { taskId: task.id, agentId: "agent-1" }).db;
    const { db: db3, task: done } = S.updateTask(db, {
      taskId: task.id,
      status: "in_review",
    });
    expect(done.delegation).toBeNull();
    expect(S.findTask(db3, task.id)?.delegation).toBeNull();
  });

  it("keeps delegation while still in_progress", () => {
    let db = withProject(freshDb());
    const project = S.listProjects(db)[0];
    const { db: db2, task } = S.createTask(db, {
      projectId: project.id,
      title: "Still working",
    });
    db = db2;
    db = S.delegateTask(db, { taskId: task.id, agentId: "agent-1" }).db;
    const { db: db3, task: still } = S.updateTask(db, {
      taskId: task.id,
      priority: "high",
    });
    expect(still.delegation?.agentId).toBe("agent-1");
    expect(S.findTask(db3, task.id)?.delegation).not.toBeNull();
  });

  it("clears delegation on board move to done", () => {
    let db = withProject(freshDb());
    const project = S.listProjects(db)[0];
    const { db: db2, task } = S.createTask(db, {
      projectId: project.id,
      title: "Move me",
    });
    db = db2;
    db = S.delegateTask(db, { taskId: task.id, agentId: "agent-1" }).db;
    const { db: db3, task: moved } = S.boardMove(db, {
      taskId: task.id,
      status: "done",
    });
    expect(moved.delegation).toBeNull();
    expect(S.findTask(db3, task.id)?.delegation).toBeNull();
  });
});

describe("updateDelegationWorktree", () => {
  it("records worktree info on a delegated task", () => {
    let db = withProject(freshDb());
    const project = S.listProjects(db)[0];
    const { db: db2, task } = S.createTask(db, {
      projectId: project.id,
      title: "WT task",
    });
    db = db2;
    db = S.delegateTask(db, { taskId: task.id, agentId: "agent-1" }).db;
    db = S.updateDelegationWorktree(db, task.id, {
      worktreePath: "/Users/ming.chen/work/pi-kit.task-1",
      branch: "task/task-1-wt-task",
      workspaceId: "ws-9",
    });
    const d = S.findTask(db, task.id)?.delegation;
    expect(d?.worktreePath).toBe("/Users/ming.chen/work/pi-kit.task-1");
    expect(d?.branch).toBe("task/task-1-wt-task");
    expect(d?.workspaceId).toBe("ws-9");
    expect(d?.agentId).toBe("agent-1");
  });

  it("is a no-op when task is not delegated", () => {
    const db = withProject(freshDb());
    const project = S.listProjects(db)[0];
    const { db: db2, task } = S.createTask(db, {
      projectId: project.id,
      title: "Plain",
    });
    const next = S.updateDelegationWorktree(db2, task.id, {
      worktreePath: "/tmp/x",
      branch: "task/x",
      workspaceId: "ws-0",
    });
    expect(S.findTask(next, task.id)?.delegation).toBeNull();
  });
});

describe("clearWorktreeInfo", () => {
  it("clears worktree fields but keeps agentId/startedAt", () => {
    let db = withProject(freshDb());
    const project = S.listProjects(db)[0];
    const { db: db2, task } = S.createTask(db, {
      projectId: project.id,
      title: "With worktree",
    });
    db = db2;
    db = S.delegateTask(db, { taskId: task.id, agentId: "agent-1" }).db;
    // Simulate worktree delegation: patch fields directly.
    db = {
      ...db,
      tasks: db.tasks.map((t) =>
        t.id === task.id
          ? {
              ...t,
              delegation: {
                agentId: "agent-1",
                startedAt: t.delegation?.startedAt ?? "",
                worktreePath: "/Users/ming.chen/work/pi-kit.task-1",
                branch: "task/task-1-x",
                workspaceId: "ws-1",
              },
            }
          : t,
      ),
    };
    const { db: db3, comment } = S.clearWorktreeInfo(db, task.id);
    expect(comment?.body).toContain("Worktree removed");
    const d = S.findTask(db3, task.id)?.delegation;
    expect(d?.worktreePath).toBeUndefined();
    expect(d?.branch).toBeUndefined();
    expect(d?.workspaceId).toBeUndefined();
    expect(d?.agentId).toBe("agent-1");
  });

  it("returns null comment when no worktree info", () => {
    let db = withProject(freshDb());
    const project = S.listProjects(db)[0];
    const { db: db2, task } = S.createTask(db, {
      projectId: project.id,
      title: "Plain",
    });
    db = db2;
    db = S.delegateTask(db, { taskId: task.id, agentId: "agent-1" }).db;
    const { comment } = S.clearWorktreeInfo(db, task.id);
    expect(comment).toBeNull();
  });

  it("sets delegation to null when only worktree info existed", () => {
    let db = withProject(freshDb());
    const project = S.listProjects(db)[0];
    const { db: db2, task } = S.createTask(db, {
      projectId: project.id,
      title: "Only wt",
    });
    db = db2;
    // Worktree delegation without agent (edge case): only worktree fields.
    db = {
      ...db,
      tasks: db.tasks.map((t) =>
        t.id === task.id
          ? {
              ...t,
              delegation: {
                agentId: "agent-1",
                startedAt: "2026-08-07T00:00:00.000Z",
                worktreePath: "/tmp/x",
              },
            }
          : t,
      ),
    };
    const { db: db3 } = S.clearWorktreeInfo(db, task.id);
    expect(S.findTask(db3, task.id)?.delegation).toBeNull();
  });
});

describe("status/priority validation", () => {
  it("rejects invalid priority on create", () => {
    const db = withProject(freshDb());
    const project = S.listProjects(db)[0];
    expect(() =>
      S.createTask(db, {
        projectId: project.id,
        title: "Bad priority",
        priority: "hi" as unknown as import("./contract.ts").TaskPriority,
      }),
    ).toThrow("Invalid priority: hi");
  });

  it("rejects invalid status on create", () => {
    const db = withProject(freshDb());
    const project = S.listProjects(db)[0];
    expect(() =>
      S.createTask(db, {
        projectId: project.id,
        title: "Bad status",
        status: "wip" as unknown as import("./contract.ts").TaskStatus,
      }),
    ).toThrow("Invalid status: wip");
  });

  it("rejects invalid priority on update", () => {
    let db = withProject(freshDb());
    const project = S.listProjects(db)[0];
    const { db: db2, task } = S.createTask(db, {
      projectId: project.id,
      title: "T",
    });
    db = db2;
    expect(() =>
      S.updateTask(db, {
        taskId: task.id,
        priority: "hi" as unknown as import("./contract.ts").TaskPriority,
      }),
    ).toThrow("Invalid priority: hi");
  });

  it("rejects invalid status on board move", () => {
    let db = withProject(freshDb());
    const project = S.listProjects(db)[0];
    const { db: db2, task } = S.createTask(db, {
      projectId: project.id,
      title: "T",
    });
    db = db2;
    expect(() =>
      S.boardMove(db, {
        taskId: task.id,
        status: "nope" as unknown as import("./contract.ts").TaskStatus,
      }),
    ).toThrow("Invalid status: nope");
  });

  it("accepts valid priorities and statuses", () => {
    const db = withProject(freshDb());
    const project = S.listProjects(db)[0];
    for (const priority of ["urgent", "high", "medium", "low", "none"]) {
      const r = S.createTask(db, {
        projectId: project.id,
        title: `p-${priority}`,
        priority: priority as import("./contract.ts").TaskPriority,
      });
      expect(r.task.priority).toBe(priority);
    }
    for (const status of [
      "backlog",
      "todo",
      "in_progress",
      "in_review",
      "done",
      "canceled",
    ]) {
      const r = S.createTask(db, {
        projectId: project.id,
        title: `s-${status}`,
        status: status as import("./contract.ts").TaskStatus,
      });
      expect(r.task.status).toBe(status);
    }
  });
});

describe("rollbackDelegation", () => {
  it("restores status and clears delegation", () => {
    let db = withProject(freshDb());
    const project = S.listProjects(db)[0];
    const { db: db2, task } = S.createTask(db, {
      projectId: project.id,
      title: "Rollback me",
      status: "todo",
    });
    db = db2;
    db = S.delegateTask(db, { taskId: task.id, agentId: "agent-1" }).db;
    const db3 = S.rollbackDelegation(db, task.id, "todo");
    expect(S.findTask(db3, task.id)?.status).toBe("todo");
    expect(S.findTask(db3, task.id)?.delegation).toBeNull();
  });

  it("is a no-op for unknown tasks", () => {
    const db = withProject(freshDb());
    const next = S.rollbackDelegation(db, "nope", "backlog");
    expect(next.tasks).toHaveLength(0);
  });
});
