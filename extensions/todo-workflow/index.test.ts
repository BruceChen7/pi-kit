import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import extension from "./index.js";

const tempDirs: string[] = [];

const createTempRepo = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-todo-extension-"));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
  return dir;
};

const initGitRepo = (repoRoot: string): void => {
  spawnSync("git", ["init"], { cwd: repoRoot, encoding: "utf-8" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "test\n", "utf-8");
  spawnSync("git", ["add", "README.md"], {
    cwd: repoRoot,
    encoding: "utf-8",
  });
  spawnSync("git", ["commit", "-m", "init"], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test User",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test User",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  spawnSync("git", ["branch", "-M", "main"], {
    cwd: repoRoot,
    encoding: "utf-8",
  });
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("todo-workflow extension", () => {
  it("registers expected commands", () => {
    const commands: string[] = [];

    extension({
      registerCommand(name: string) {
        commands.push(name);
      },
      on() {
        // no-op
      },
      exec() {
        throw new Error("exec should not run during registration");
      },
    } as unknown as ExtensionAPI);

    expect(commands.sort()).toEqual(["end_todo", "todo"]);
  });

  it("creates a todo from /todo add", async () => {
    const repoRoot = createTempRepo();
    const commands = new Map<
      string,
      (args: string, ctx: unknown) => Promise<void>
    >();
    const notifications: Array<{ message: string; level: string }> = [];

    extension({
      registerCommand(
        name: string,
        definition: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) {
        commands.set(name, definition.handler);
      },
      on() {
        // no-op
      },
      exec() {
        throw new Error("exec should not run during todo add");
      },
    } as unknown as ExtensionAPI);

    const handler = commands.get("todo");
    expect(handler).toBeTypeOf("function");
    if (!handler) return;

    await handler("add Fix status banner", {
      cwd: repoRoot,
      hasUI: true,
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
      sessionManager: {
        getSessionFile() {
          return path.join(repoRoot, ".pi", "sessions", "current.jsonl");
        },
      },
    });

    const store = JSON.parse(
      fs.readFileSync(path.join(repoRoot, ".pi", "todos.json"), "utf-8"),
    ) as { todos: Array<{ title: string; status: string }> };

    expect(store.todos).toHaveLength(1);
    expect(store.todos[0]).toMatchObject({
      title: "Fix status banner",
      status: "todo",
    });
    expect(notifications).toContainEqual({
      message: 'Added TODO: "Fix status banner"',
      level: "info",
    });
  });

  it("does not mark todo as doing when feature start preconditions fail", async () => {
    const repoRoot = createTempRepo();
    initGitRepo(repoRoot);

    fs.writeFileSync(
      path.join(repoRoot, ".pi", "todos.json"),
      JSON.stringify(
        {
          todos: [
            {
              id: "todo-1",
              title: "Fix merge flow",
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
    fs.writeFileSync(
      path.join(repoRoot, ".pi", "third_extension_settings.json"),
      JSON.stringify(
        {
          featureWorkflow: {
            guards: {
              requireCleanWorkspace: false,
              requireFreshBase: false,
            },
            defaults: {
              autoSwitchToWorktreeSession: false,
            },
            ignoredSync: {
              enabled: false,
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const commands = new Map<
      string,
      (args: string, ctx: unknown) => Promise<void>
    >();
    const notifications: Array<{ message: string; level: string }> = [];
    const exec = vi.fn(async (_command: string, args: string[]) => {
      if (
        args[0] === "-C" &&
        args[2] === "branch" &&
        args[3] === "--show-current"
      ) {
        return { code: 0, stdout: "main\n", stderr: "" };
      }
      throw new Error(`Unexpected exec args: ${args.join(" ")}`);
    });

    extension({
      registerCommand(
        name: string,
        definition: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) {
        commands.set(name, definition.handler);
      },
      on() {
        // no-op
      },
      exec,
    } as unknown as ExtensionAPI);

    const handler = commands.get("todo");
    expect(handler).toBeTypeOf("function");
    if (!handler) return;

    await handler("", {
      cwd: repoRoot,
      hasUI: true,
      ui: {
        custom: async () => "todo-1",
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
        setStatus: vi.fn(),
      },
      sessionManager: {
        getSessionFile() {
          return path.join(repoRoot, ".pi", "sessions", "current.jsonl");
        },
      },
      switchSession: vi.fn(async () => ({ cancelled: false })),
    });

    const store = JSON.parse(
      fs.readFileSync(path.join(repoRoot, ".pi", "todos.json"), "utf-8"),
    ) as { todos: Array<{ status: string }> };

    expect(store.todos[0]?.status).toBe("todo");
    expect(notifications).toContainEqual({
      message:
        "feature-start requires local setup-managed files that are missing: .config/wt.toml. Run /feature-setup first.",
      level: "warning",
    });
  });

  it("asks for confirmation before rebuilding a missing worktree during resume", async () => {
    const repoRoot = createTempRepo();
    fs.writeFileSync(
      path.join(repoRoot, ".pi", "todos.json"),
      JSON.stringify(
        {
          todos: [
            {
              id: "todo-1",
              title: "Resume missing worktree",
              status: "doing",
              sourceBranch: "main",
              workBranch: "resume-missing-worktree",
              worktreePath: path.join(
                repoRoot,
                ".worktrees",
                "resume-missing-worktree",
              ),
              createdAt: "2026-04-22T10:00:00.000Z",
              updatedAt: "2026-04-22T10:00:00.000Z",
              startedAt: "2026-04-22T10:01:00.000Z",
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const commands = new Map<
      string,
      (args: string, ctx: unknown) => Promise<void>
    >();
    const notifications: Array<{ message: string; level: string }> = [];
    const confirm = vi.fn(async () => false);
    const exec = vi.fn(async () => {
      throw new Error("wt should not run when rebuild is declined");
    });

    extension({
      registerCommand(
        name: string,
        definition: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) {
        commands.set(name, definition.handler);
      },
      on() {
        // no-op
      },
      exec,
    } as unknown as ExtensionAPI);

    const handler = commands.get("todo");
    expect(handler).toBeTypeOf("function");
    if (!handler) return;

    await handler("", {
      cwd: repoRoot,
      hasUI: true,
      ui: {
        custom: async () => "todo-1",
        confirm,
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
        setStatus: vi.fn(),
      },
      sessionManager: {
        getSessionFile() {
          return path.join(repoRoot, ".pi", "sessions", "current.jsonl");
        },
      },
      switchSession: vi.fn(),
    });

    expect(confirm).toHaveBeenCalledWith(
      'Rebuild missing worktree for "Resume missing worktree"?',
      expect.stringContaining("Expected worktree path:"),
    );
    expect(exec).not.toHaveBeenCalled();
    expect(notifications).toContainEqual({
      message: "Cancelled",
      level: "info",
    });
  });

  it("keeps todo doing when end_todo merge fails", async () => {
    const repoRoot = createTempRepo();
    fs.writeFileSync(
      path.join(repoRoot, ".pi", "todos.json"),
      JSON.stringify(
        {
          todos: [
            {
              id: "todo-1",
              title: "Finish merge flow",
              status: "doing",
              sourceBranch: "main",
              workBranch: "finish-merge-flow",
              worktreePath: "/tmp/finish-merge-flow",
              createdAt: "2026-04-22T10:00:00.000Z",
              updatedAt: "2026-04-22T10:00:00.000Z",
              startedAt: "2026-04-22T10:01:00.000Z",
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const commands = new Map<
      string,
      (args: string, ctx: unknown) => Promise<void>
    >();
    const notifications: Array<{ message: string; level: string }> = [];
    const exec = vi.fn(async (_command: string, args: string[]) => {
      if (args[2] === "branch" && args[3] === "--show-current") {
        return { code: 0, stdout: "other-branch\n", stderr: "" };
      }
      if (args[2] === "list") {
        return {
          code: 0,
          stdout: JSON.stringify([
            {
              branch: "finish-merge-flow",
              path: "/tmp/finish-merge-flow",
              is_main: false,
            },
          ]),
          stderr: "",
        };
      }
      if (args[2] === "switch") {
        return {
          code: 0,
          stdout: JSON.stringify({ path: "/tmp/finish-merge-flow" }),
          stderr: "",
        };
      }
      if (args[2] === "checkout") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[2] === "merge") {
        return { code: 1, stdout: "", stderr: "conflict" };
      }
      throw new Error(`Unexpected git args: ${args.join(" ")}`);
    });

    extension({
      registerCommand(
        name: string,
        definition: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) {
        commands.set(name, definition.handler);
      },
      on() {
        // no-op
      },
      exec,
    } as unknown as ExtensionAPI);

    const handler = commands.get("end_todo");
    expect(handler).toBeTypeOf("function");
    if (!handler) return;

    await handler("", {
      cwd: repoRoot,
      hasUI: true,
      ui: {
        select: async () => "Finish merge flow",
        confirm: async () => true,
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
        setStatus: vi.fn(),
      },
      sessionManager: {
        getSessionFile() {
          return path.join(repoRoot, ".pi", "sessions", "current.jsonl");
        },
      },
      switchSession: vi.fn(async () => ({ cancelled: false })),
    });

    const store = JSON.parse(
      fs.readFileSync(path.join(repoRoot, ".pi", "todos.json"), "utf-8"),
    ) as { todos: Array<{ status: string; completedAt?: string }> };

    expect(store.todos[0]?.status).toBe("doing");
    expect(store.todos[0]?.completedAt).toBeUndefined();
    expect(notifications.some((item) => item.level === "error")).toBe(true);
  });
});
