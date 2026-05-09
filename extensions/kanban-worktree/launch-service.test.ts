import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import {
  createTodo,
  findTodoById,
  updateTodoStart,
} from "../todo-workflow/todo-store.js";
import { FeatureLaunchService } from "./launch-service.js";
import { TodoWorkflowSource } from "./todo-source.js";

let dir: string;
let repoRoot: string;
let source: TodoWorkflowSource;
let originId: string;

function createGateways() {
  return {
    worktree: {
      ensureFeatureWorktree: vi.fn().mockResolvedValue({
        branch: "feature/implement-launch",
        worktreePath: "/repo/.worktrees/implement-launch",
      }),
    },
    tmux: {
      launchCommand: vi.fn().mockResolvedValue({
        session: "pi-kanban",
        window: "kw-implement-launch",
      }),
    },
  };
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "kanban-worktree-launch-"));
  repoRoot = path.join(dir, "repo");
  source = new TodoWorkflowSource();
  originId = createTodo(repoRoot, "Implement launch", {
    id: "implement-launch",
    workBranch: "feature/implement-launch",
  }).id;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("launches an in-box todo by creating worktree and tmux window", async () => {
  const { worktree, tmux } = createGateways();
  const logger = { info: vi.fn(), error: vi.fn() };
  const service = new FeatureLaunchService({
    rootDir: dir,
    repoRoot,
    issueSource: source,
    worktree,
    tmux,
    logger,
  });

  const run = await service.launch({
    originProvider: "todo-workflow",
    originId,
  });

  expect(worktree.ensureFeatureWorktree).toHaveBeenCalledWith({
    repoRoot,
    slug: "implement-launch",
    baseBranch: "main",
    branch: "feature/implement-launch",
  });
  expect(tmux.launchCommand).toHaveBeenCalledWith({
    cwd: "/repo/.worktrees/implement-launch",
    windowName: "kw-implement-launch",
    command: expect.stringContaining("KANBAN_FEATURE_ID=implement-launch"),
  });
  expect(run).toMatchObject({
    issueId: `todo-workflow:${originId}`,
    originProvider: "todo-workflow",
    originId,
    featureId: "implement-launch",
    state: "running",
    worktreePath: "/repo/.worktrees/implement-launch",
  });
  expect(findTodoById(repoRoot, originId)).toMatchObject({
    status: "doing",
    sourceBranch: "main",
    workBranch: "feature/implement-launch",
    worktreePath: "/repo/.worktrees/implement-launch",
  });
  expect(logger.info).toHaveBeenCalledWith(
    "launch requested",
    expect.objectContaining({ originId }),
  );
});

test("launch uses fallback base branch for todos without source branch", async () => {
  source = new TodoWorkflowSource({ resolveBaseBranch: () => "master" });
  const { worktree, tmux } = createGateways();
  worktree.ensureFeatureWorktree.mockResolvedValue({
    branch: "feature/implement-launch",
    worktreePath: "/repo/.worktrees/implement-launch",
  });
  const service = new FeatureLaunchService({
    rootDir: dir,
    repoRoot,
    issueSource: source,
    worktree,
    tmux,
  });

  await service.launch({ originProvider: "todo-workflow", originId });

  expect(worktree.ensureFeatureWorktree).toHaveBeenCalledWith({
    repoRoot,
    slug: "implement-launch",
    baseBranch: "master",
    branch: "feature/implement-launch",
  });
  expect(findTodoById(repoRoot, originId)).toMatchObject({
    status: "doing",
    sourceBranch: "master",
    workBranch: "feature/implement-launch",
  });
});

test("rejects launch when an old in-box todo has no work branch", async () => {
  const oldOriginId = createTodo(repoRoot, "Old todo without branch", {
    id: "old-todo-without-branch",
  }).id;
  const service = new FeatureLaunchService({
    rootDir: dir,
    repoRoot,
    issueSource: source,
    worktree: { ensureFeatureWorktree: vi.fn() },
    tmux: { launchCommand: vi.fn() },
  });

  await expect(
    service.launch({ originProvider: "todo-workflow", originId: oldOriginId }),
  ).rejects.toThrow("launch work branch is required");
});

test("returns an existing running run without creating duplicate tmux windows", async () => {
  const { tmux, worktree } = createGateways();
  const service = new FeatureLaunchService({
    rootDir: dir,
    repoRoot,
    issueSource: source,
    worktree,
    tmux,
  });

  await service.launch({ originProvider: "todo-workflow", originId });
  const second = await service.launch({
    originProvider: "todo-workflow",
    originId,
  });

  expect(tmux.launchCommand).toHaveBeenCalledTimes(1);
  expect(second.state).toBe("running");
});

test("rejects launch for non in-box todo", async () => {
  updateTodoStart(repoRoot, {
    id: originId,
    sourceBranch: "main",
    workBranch: "feature/implement-launch",
    worktreePath: "/repo/.worktrees/implement-launch",
  });
  const service = new FeatureLaunchService({
    rootDir: dir,
    repoRoot,
    issueSource: source,
    worktree: { ensureFeatureWorktree: vi.fn() },
    tmux: { launchCommand: vi.fn() },
  });

  await expect(
    service.launch({ originProvider: "todo-workflow", originId }),
  ).rejects.toThrow("only in-box issues can be launched");
});
