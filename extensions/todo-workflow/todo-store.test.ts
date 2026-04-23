import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createTodo,
  listTodos,
  loadTodoStore,
  markTodoDone,
  removeTodo,
  syncTodoDone,
  updateTodoActivation,
  updateTodoStart,
} from "./todo-store.js";

const tempDirs: string[] = [];

const createTempRepo = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-todo-store-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("todo-store", () => {
  it("creates and persists a todo in .pi/todos.json", () => {
    const repoRoot = createTempRepo();

    const created = createTodo(repoRoot, "Fix merge handling");
    const loaded = loadTodoStore(repoRoot);

    expect(created.description).toBe("Fix merge handling");
    expect(created.status).toBe("todo");
    expect(loaded.todos).toHaveLength(1);
    expect(loaded.todos[0]).toMatchObject({
      id: created.id,
      description: "Fix merge handling",
      status: "todo",
    });
    expect(fs.existsSync(path.join(repoRoot, ".pi", "todos.json"))).toBe(true);
  });

  it("keeps doing todos before todo items and sorts active doing first", () => {
    const repoRoot = createTempRepo();
    const alpha = createTodo(repoRoot, "Alpha task");
    const beta = createTodo(repoRoot, "Beta task");
    const gamma = createTodo(repoRoot, "Gamma task");

    updateTodoStart(repoRoot, {
      id: alpha.id,
      sourceBranch: "main",
      workBranch: "alpha-task",
      worktreePath: "/tmp/alpha",
      now: "2026-04-22T10:00:00.000Z",
    });
    updateTodoActivation(repoRoot, {
      id: alpha.id,
      now: "2026-04-22T10:10:00.000Z",
      sessionKey: "session-a",
      activeInSession: false,
    });

    updateTodoStart(repoRoot, {
      id: beta.id,
      sourceBranch: "main",
      workBranch: "beta-task",
      worktreePath: "/tmp/beta",
      now: "2026-04-22T10:01:00.000Z",
    });
    updateTodoActivation(repoRoot, {
      id: beta.id,
      now: "2026-04-22T10:20:00.000Z",
      sessionKey: "session-a",
      activeInSession: true,
    });

    markTodoDone(repoRoot, {
      id: gamma.id,
      now: "2026-04-22T10:30:00.000Z",
    });

    const listed = listTodos(repoRoot, {
      includeDone: false,
      sessionKey: "session-a",
    });

    expect(listed.map((todo) => todo.id)).toEqual([beta.id, alpha.id]);
  });

  it("reads legacy title data as description and migrates it on disk", () => {
    const repoRoot = createTempRepo();

    fs.mkdirSync(path.join(repoRoot, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, ".pi", "todos.json"),
      JSON.stringify(
        {
          todos: [
            {
              id: "legacy",
              title: "Legacy title field",
              status: "todo",
              createdAt: "2026-04-22T10:00:00.000Z",
              updatedAt: "2026-04-22T10:00:00.000Z",
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    expect(loadTodoStore(repoRoot).todos[0]).toMatchObject({
      id: "legacy",
      description: "Legacy title field",
      status: "todo",
    });

    const persisted = JSON.parse(
      fs.readFileSync(path.join(repoRoot, ".pi", "todos.json"), "utf-8"),
    ) as { todos: Array<{ description?: string; title?: string }> };

    expect(persisted.todos[0]).toMatchObject({
      description: "Legacy title field",
    });
    expect(persisted.todos[0]?.title).toBeUndefined();
  });

  it("recovers from an empty todos file by rewriting an empty store", () => {
    const repoRoot = createTempRepo();
    const storePath = path.join(repoRoot, ".pi", "todos.json");

    fs.mkdirSync(path.join(repoRoot, ".pi"), { recursive: true });
    fs.writeFileSync(storePath, "", "utf-8");

    expect(loadTodoStore(repoRoot)).toEqual({ todos: [] });
    expect(fs.readFileSync(storePath, "utf-8")).toBe('{\n  "todos": []\n}\n');
  });

  it("preserves the last valid store when a write fails", () => {
    const repoRoot = createTempRepo();
    const storePath = path.join(repoRoot, ".pi", "todos.json");
    const first = createTodo(repoRoot, "Keep existing todo");
    const originalWriteFileSync = fs.writeFileSync.bind(fs);

    const writeSpy = vi
      .spyOn(fs, "writeFileSync")
      .mockImplementation((filePath, data, options) => {
        const targetPath = String(filePath);
        if (targetPath === storePath) {
          originalWriteFileSync(filePath, "", options);
          throw new Error("simulated write failure");
        }
        if (targetPath.includes("todos.json.tmp")) {
          throw new Error("simulated write failure");
        }
        return originalWriteFileSync(filePath, data, options);
      });

    expect(() => createTodo(repoRoot, "This write should fail")).toThrow(
      /simulated write failure/,
    );

    writeSpy.mockRestore();

    expect(loadTodoStore(repoRoot).todos).toMatchObject([
      {
        id: first.id,
        description: "Keep existing todo",
        status: "todo",
      },
    ]);
  });

  it("removes a todo by id", () => {
    const repoRoot = createTempRepo();
    const first = createTodo(repoRoot, "First todo");
    createTodo(repoRoot, "Second todo");

    const removed = removeTodo(repoRoot, { id: first.id });
    const loaded = loadTodoStore(repoRoot);

    expect(removed).toMatchObject({
      id: first.id,
      description: "First todo",
    });
    expect(loaded.todos).toHaveLength(1);
    expect(loaded.todos[0]?.description).toBe("Second todo");
  });

  it("fails fast when a persisted todo record is invalid", () => {
    const repoRoot = createTempRepo();

    fs.mkdirSync(path.join(repoRoot, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, ".pi", "todos.json"),
      JSON.stringify(
        {
          todos: [
            {
              id: "broken",
              status: "todo",
              createdAt: "2026-04-22T10:00:00.000Z",
              updatedAt: "2026-04-22T10:00:00.000Z",
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    expect(() => loadTodoStore(repoRoot)).toThrow(/invalid todo record/);
  });

  it("preserves doing status when end flow fails upstream", () => {
    const repoRoot = createTempRepo();
    const todo = createTodo(repoRoot, "Handle merge conflict");

    updateTodoStart(repoRoot, {
      id: todo.id,
      sourceBranch: "main",
      workBranch: "handle-merge-conflict",
      worktreePath: "/tmp/merge",
      now: "2026-04-22T10:00:00.000Z",
    });

    const loaded = loadTodoStore(repoRoot);
    expect(loaded.todos[0]?.status).toBe("doing");
    expect(loaded.todos[0]?.completedAt).toBeUndefined();
  });

  it("syncs a stale doing todo to done and preserves the first completion time", () => {
    const repoRoot = createTempRepo();
    const todo = createTodo(repoRoot, "Reconcile merged todo");

    updateTodoStart(repoRoot, {
      id: todo.id,
      sourceBranch: "main",
      workBranch: "reconcile-merged-todo",
      worktreePath: "/tmp/reconcile-merged-todo",
      now: "2026-04-22T10:00:00.000Z",
    });

    const first = syncTodoDone(repoRoot, {
      id: todo.id,
      now: "2026-04-22T10:30:00.000Z",
    });
    const second = syncTodoDone(repoRoot, {
      id: todo.id,
      now: "2026-04-22T10:45:00.000Z",
    });

    expect(first).toMatchObject({
      status: "done",
      completedAt: "2026-04-22T10:30:00.000Z",
    });
    expect(second).toMatchObject({
      status: "done",
      completedAt: "2026-04-22T10:30:00.000Z",
      updatedAt: "2026-04-22T10:45:00.000Z",
    });
  });
});
