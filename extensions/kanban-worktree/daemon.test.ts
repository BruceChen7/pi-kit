import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

import { createTodo, findTodoById } from "../todo-workflow/todo-store.js";
import { KanbanDaemon } from "./daemon.js";

let dir: string;
let repoRoot: string;
let daemon: KanbanDaemon;

async function dispatch(method: string, params?: unknown): Promise<unknown> {
  return (
    daemon as unknown as { dispatch(request: unknown): Promise<unknown> }
  ).dispatch({
    id: method,
    method,
    params,
  });
}

function createGitRunner(stdoutByCommand: Record<string, string>) {
  return (args: string[]) => {
    const key = args.join(" ");
    const stdout = stdoutByCommand[key];
    return stdout === undefined
      ? { exitCode: 1, stdout: "", stderr: "fail" }
      : { exitCode: 0, stdout, stderr: "" };
  };
}

function useGitFixture(stdoutByCommand: Record<string, string>): void {
  daemon = new KanbanDaemon({
    rootDir: dir,
    repoRoot,
    git: createGitRunner(stdoutByCommand),
  });
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "kanban-worktree-daemon-"));
  repoRoot = path.join(dir, "repo");
  daemon = new KanbanDaemon({ rootDir: dir, repoRoot });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("requirements.list returns todo-workflow todos", async () => {
  const todo = createTodo(repoRoot, "Show in kanban", { id: "show-in-kanban" });

  const response = await dispatch("requirements.list");

  expect(response).toEqual({
    id: "requirements.list",
    result: [
      expect.objectContaining({
        issueId: `todo-workflow:${todo.id}`,
        originProvider: "todo-workflow",
        originId: todo.id,
        title: "Show in kanban",
        status: "in-box",
      }),
    ],
  });
});

test("requirements.create writes todo-workflow todos", async () => {
  const response = await dispatch("requirements.create", {
    title: "Created through kanban",
    workBranch: "feature/created-through-kanban",
  });

  expect(response).toEqual({
    id: "requirements.create",
    result: expect.objectContaining({
      originProvider: "todo-workflow",
      title: "Created through kanban",
      status: "in-box",
      baseBranch: "main",
      workBranch: "feature/created-through-kanban",
    }),
  });
  expect(await dispatch("requirements.list")).toEqual(
    expect.objectContaining({
      result: [expect.objectContaining({ title: "Created through kanban" })],
    }),
  );
});

test("requirements.create requires work branch", async () => {
  const response = await dispatch("requirements.create", {
    title: "Missing branch",
  });

  expect(response).toEqual({
    id: "requirements.create",
    error: { message: "requirements.create requires workBranch" },
  });
});

test("requirements.create defaults to detected base branch", async () => {
  useGitFixture({
    "for-each-ref --format=%(refname:short) refs/heads": "master\n",
    "for-each-ref --format=%(refname:short) refs/remotes/origin": "",
  });

  const response = await dispatch("requirements.create", {
    title: "Created on master",
    workBranch: "feature/created-on-master",
  });

  expect(response).toEqual(
    expect.objectContaining({
      result: expect.objectContaining({ baseBranch: "master" }),
    }),
  );
  expect(findTodoById(repoRoot, "created-on-master")).toMatchObject({
    sourceBranch: "master",
  });
});

test("requirements.create persists selected base branch", async () => {
  const response = await dispatch("requirements.create", {
    title: "Created from feature base",
    baseBranch: "feature/base",
    workBranch: "feature/created-from-feature-base",
  });

  expect(response).toEqual(
    expect.objectContaining({
      result: expect.objectContaining({
        baseBranch: "feature/base",
        workBranch: "feature/created-from-feature-base",
      }),
    }),
  );
  expect(findTodoById(repoRoot, "created-from-feature-base")).toMatchObject({
    sourceBranch: "feature/base",
    workBranch: "feature/created-from-feature-base",
  });
});

test("requirements.remove deletes todo-workflow todos", async () => {
  const todo = createTodo(repoRoot, "Delete through kanban", {
    id: "delete-through-kanban",
  });

  const response = await dispatch("requirements.remove", {
    originProvider: "todo-workflow",
    originId: todo.id,
  });

  expect(response).toEqual({
    id: "requirements.remove",
    result: expect.objectContaining({
      originProvider: "todo-workflow",
      originId: todo.id,
      title: "Delete through kanban",
    }),
  });
  expect(findTodoById(repoRoot, todo.id)).toBeNull();
});

test("requirements.remove requires todo-workflow origin provider and id", async () => {
  const response = await dispatch("requirements.remove", {
    originProvider: "other",
    originId: "todo-1",
  });

  expect(response).toEqual({
    id: "requirements.remove",
    error: {
      message: "requirements.remove requires todo-workflow origin provider/id",
    },
  });
});

test("branches.list returns local and remote branches with a default branch", async () => {
  useGitFixture({
    "for-each-ref --format=%(refname:short) refs/heads": "main\nlocal-only\n",
    "for-each-ref --format=%(refname:short) refs/remotes/origin":
      "origin/HEAD\norigin/main\norigin/remote-only\n",
    "symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
  });

  const response = await dispatch("branches.list");

  expect(response).toEqual({
    id: "branches.list",
    result: {
      branches: ["main", "local-only", "remote-only"],
      defaultBranch: "main",
    },
  });
});

test("branches.list falls back to main outside git repos", async () => {
  const response = await dispatch("branches.list");

  expect(response).toEqual({
    id: "branches.list",
    result: {
      branches: ["main"],
      defaultBranch: "main",
    },
  });
});
