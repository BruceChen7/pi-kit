import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

import {
  createTodo,
  findTodoById,
  updateTodoStart,
} from "../todo-workflow/todo-store.js";
import { TodoWorkflowSource } from "./todo-source.js";

let repoRoot: string;
let source: TodoWorkflowSource;

beforeEach(async () => {
  repoRoot = await mkdtemp(path.join(tmpdir(), "kanban-worktree-todo-source-"));
  source = new TodoWorkflowSource({ resolveBaseBranch: () => "main" });
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

test("projects todo-workflow todos into kanban issues", async () => {
  const todo = createTodo(repoRoot, "Implement local todo source", {
    id: "local-source",
    now: "2026-05-09T00:00:00.000Z",
  });

  const issues = await source.list(repoRoot);

  expect(issues).toEqual([
    expect.objectContaining({
      issueId: `todo-workflow:${todo.id}`,
      originProvider: "todo-workflow",
      originId: todo.id,
      title: "Implement local todo source",
      status: "in-box",
      repoRoot,
      slug: todo.id,
      baseBranch: "main",
      updatedAt: "2026-05-09T00:00:00.000Z",
    }),
  ]);
});

test("uses fallback base branch for todos without source branch", async () => {
  source = new TodoWorkflowSource({ resolveBaseBranch: () => "master" });
  const todo = createTodo(repoRoot, "Launch from current branch", {
    id: "current-branch",
  });

  const issue = await source.get(repoRoot, todo.id);

  expect(issue).toMatchObject({
    issueId: `todo-workflow:${todo.id}`,
    originProvider: "todo-workflow",
    originId: todo.id,
    status: "in-box",
    baseBranch: "master",
  });
});

test("maps doing todo metadata onto kanban issue fields", async () => {
  const todo = createTodo(repoRoot, "Resume existing work", {
    id: "resume-work",
    now: "2026-05-09T00:00:00.000Z",
  });
  updateTodoStart(repoRoot, {
    id: todo.id,
    sourceBranch: "feature/base",
    workBranch: "feature/resume-work",
    worktreePath: "/tmp/resume-work",
    now: "2026-05-09T01:00:00.000Z",
  });

  const issue = await source.get(repoRoot, todo.id);

  expect(issue).toMatchObject({
    issueId: `todo-workflow:${todo.id}`,
    originProvider: "todo-workflow",
    originId: todo.id,
    status: "doing",
    baseBranch: "feature/base",
    workBranch: "feature/resume-work",
    worktreePath: "/tmp/resume-work",
  });
});

test("creates todo-workflow todos for kanban create", async () => {
  const issue = await source.create(repoRoot, "Create from kanban", {
    workBranch: "feature/create-from-kanban",
  });

  expect(issue).toMatchObject({
    originProvider: "todo-workflow",
    title: "Create from kanban",
    status: "in-box",
    workBranch: "feature/create-from-kanban",
  });
  expect(await source.list(repoRoot)).toHaveLength(1);
});

test("removes todo-workflow todos for kanban delete", async () => {
  const todo = createTodo(repoRoot, "Delete from kanban", {
    id: "delete-from-kanban",
  });

  const issue = await source.remove(repoRoot, todo.id);

  expect(issue).toMatchObject({
    originProvider: "todo-workflow",
    originId: todo.id,
    title: "Delete from kanban",
    status: "in-box",
  });
  expect(findTodoById(repoRoot, todo.id)).toBeNull();
});
