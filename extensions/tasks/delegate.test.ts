/**
 * Tasks delegation — pure function tests (seed prompt, agent label, shell quote).
 */

import { describe, expect, it } from "vitest";
import {
  branchToPathSlug,
  buildSeedPrompt,
  buildWorktreeBranch,
  buildWorktreePath,
  delegatedAgentLabel,
  MAX_AGENT_LABEL_LENGTH,
  shellQuote,
} from "./delegate.ts";
import * as S from "./store.ts";
import { emptyDb } from "./store.ts";

function makeDb() {
  let db = emptyDb();
  const { db: db1, project } = S.createProject(db, {
    name: "pi-kit",
    prefix: "TASK",
    color: "#6366f1",
    folderId: null,
  });
  db = db1;
  return { db, project };
}

describe("delegatedAgentLabel", () => {
  it("formats as KEY · title", () => {
    const { db, project } = makeDb();
    const { task } = S.createTask(db, {
      projectId: project.id,
      title: "Implement board",
    });
    expect(delegatedAgentLabel(task)).toBe("TASK-1 · Implement board");
  });

  it("truncates long titles to 120 chars", () => {
    const { db, project } = makeDb();
    const { task } = S.createTask(db, {
      projectId: project.id,
      title: "x".repeat(200),
    });
    expect(delegatedAgentLabel(task).length).toBeLessThanOrEqual(
      MAX_AGENT_LABEL_LENGTH,
    );
  });
});

describe("buildSeedPrompt", () => {
  it("includes task snapshot, project root, subtasks, comments, and contract", () => {
    let { db, project } = makeDb();
    const { db: db2, task } = S.createTask(db, {
      projectId: project.id,
      title: "Implement board",
      description: "Build drag-and-drop.",
      status: "in_progress",
    });
    db = db2;
    const { db: db3 } = S.createTask(db, {
      projectId: project.id,
      title: "Write tests",
      parentTaskId: task.id,
    });
    db = db3;
    const { db: db4 } = S.createComment(db, {
      taskId: task.id,
      kind: "user",
      authorName: "Ming",
      body: "Started DnD logic.",
    });
    db = db4;

    const prompt = buildSeedPrompt({
      task,
      project,
      db,
      projectRoot: "/Users/ming.chen/work/pi-kit",
    });

    expect(prompt).toContain("# TASK-1 · Implement board");
    expect(prompt).toContain("Build drag-and-drop.");
    expect(prompt).toContain("Project root: /Users/ming.chen/work/pi-kit");
    expect(prompt).toContain("Working directory: /Users/ming.chen/work/pi-kit");
    expect(prompt).toContain("TASK-2 · Write tests (backlog)");
    expect(prompt).toContain("Started DnD logic.");
    expect(prompt).toContain("task_show");
    expect(prompt).toContain("task_comment");
    expect(prompt).toContain("task_update");
    expect(prompt).toContain("status → in_review");
  });

  it("appends extra instructions when provided", () => {
    const { db, project } = makeDb();
    const { task } = S.createTask(db, {
      projectId: project.id,
      title: "T",
    });
    const prompt = buildSeedPrompt({
      task,
      project,
      db,
      projectRoot: "/repo",
      extraInstructions: "Use vitest for tests.",
    });
    expect(prompt).toContain("## Extra instructions");
    expect(prompt).toContain("Use vitest for tests.");
  });

  it("handles missing description/comments/subtasks gracefully", () => {
    const { db, project } = makeDb();
    const { task } = S.createTask(db, {
      projectId: project.id,
      title: "Empty task",
    });
    const prompt = buildSeedPrompt({
      task,
      project,
      db,
      projectRoot: "/repo",
    });
    expect(prompt).toContain("No description provided.");
    expect(prompt).toContain("None.");
  });
});

describe("shellQuote", () => {
  it("wraps simple values in single quotes", () => {
    expect(shellQuote("pi")).toBe("'pi'");
  });

  it("escapes embedded single quotes", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});

describe("worktree helpers", () => {
  it("branchToPathSlug lowercases and replaces non-alphanumerics", () => {
    expect(branchToPathSlug("Implement Board Drag-and-Drop!")).toBe(
      "implement-board-drag-and-drop",
    );
    expect(branchToPathSlug("  spaced  out  ")).toBe("spaced-out");
    expect(branchToPathSlug("!!!")).toBe("task");
  });

  it("buildWorktreeBranch formats task/<key>-<slug>", () => {
    const { db, project } = makeDb();
    const { task } = S.createTask(db, {
      projectId: project.id,
      title: "Implement board drag-and-drop",
    });
    expect(buildWorktreeBranch(task)).toBe(
      "task/task-1-implement-board-drag-and-drop",
    );
  });

  it("buildWorktreePath formats <dir>/<repo>.<key-lower>", () => {
    const { db, project } = makeDb();
    const { task } = S.createTask(db, {
      projectId: project.id,
      title: "Fix bug",
    });
    expect(buildWorktreePath("/Users/ming.chen/work", "pi-kit", task)).toBe(
      "/Users/ming.chen/work/pi-kit.task-1",
    );
  });

  it("buildSeedPrompt includes Worktree section in worktree mode", () => {
    const { db, project } = makeDb();
    const { task } = S.createTask(db, {
      projectId: project.id,
      title: "Worktree task",
    });
    const prompt = buildSeedPrompt({
      task,
      project,
      db,
      projectRoot: "/Users/ming.chen/work/pi-kit",
      worktree: {
        branch: "task/task-1-worktree-task",
        path: "/Users/ming.chen/work/pi-kit.task-1",
      },
    });
    expect(prompt).toContain("## Worktree");
    expect(prompt).toContain("Branch: task/task-1-worktree-task");
    expect(prompt).toContain("Path: /Users/ming.chen/work/pi-kit.task-1");
    expect(prompt).toContain("不要碰主 checkout");
    expect(prompt).toContain(
      "Working directory: /Users/ming.chen/work/pi-kit.task-1",
    );
  });
});
