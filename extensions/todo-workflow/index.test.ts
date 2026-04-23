import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  type ExtensionAPI,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@mariozechner/pi-ai", () => ({
  complete: vi.fn(),
}));

import { complete } from "@mariozechner/pi-ai";
import extension from "./index.js";

const tempDirs: string[] = [];

type LoaderComponent = {
  render: (width: number) => string[];
  dispose?: () => void;
};

type LoaderFactory = (
  tui: { requestRender(): void },
  theme: { fg(color: string, text: string): string },
  keybindings: unknown,
  done: (value: unknown) => void,
) => LoaderComponent;

function createUiCustomMock(...initialResults: unknown[]) {
  const queuedResults = [...initialResults];
  const renders: string[] = [];
  const custom = vi.fn(async (factory: LoaderFactory) => {
    if (queuedResults.length > 0) {
      return queuedResults.shift();
    }

    let component: LoaderComponent | undefined;
    const result = await new Promise<unknown>((resolve) => {
      component = factory(
        { requestRender() {} },
        {
          fg(_color: string, text: string) {
            return text;
          },
        },
        {},
        (value: unknown) => resolve(value),
      );

      renders.push(component.render(80).join("\n"));
    });

    component?.dispose?.();
    return result;
  });

  return { custom, renders };
}

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
  vi.mocked(complete).mockReset();
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

    expect(commands.sort()).toEqual(["todo"]);
  });

  it("delegates finish and cleanup completions through the unified /todo entry", async () => {
    const initialCwd = process.cwd();
    const repoRoot = createTempRepo();

    fs.writeFileSync(
      path.join(repoRoot, ".pi", "todos.json"),
      JSON.stringify(
        {
          todos: [
            {
              id: "cleanup-merged-task",
              title: "Cleanup merged task",
              status: "doing",
              sourceBranch: "main",
              workBranch: "cleanup-merged-task",
              worktreePath: "/tmp/cleanup-merged-task",
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
      {
        handler: (args: string, ctx: unknown) => Promise<void>;
        getArgumentCompletions?: (
          prefix: string,
        ) =>
          | Promise<Array<{ value: string }> | null>
          | Array<{ value: string }>
          | null;
      }
    >();
    const exec = vi.fn(async (_command: string, args: string[]) => {
      if (args.includes("rev-parse")) {
        return { code: 0, stdout: "sha\n", stderr: "" };
      }
      if (args.includes("merge-base")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected exec args: ${args.join(" ")}`);
    });

    extension({
      registerCommand(
        name: string,
        definition: {
          handler: (args: string, ctx: unknown) => Promise<void>;
          getArgumentCompletions?: (
            prefix: string,
          ) =>
            | Promise<Array<{ value: string }> | null>
            | Array<{ value: string }>
            | null;
        },
      ) {
        commands.set(name, definition);
      },
      on() {
        // no-op
      },
      exec,
    } as unknown as ExtensionAPI);

    const handler = commands.get("todo");
    expect(handler?.getArgumentCompletions).toBeTypeOf("function");
    if (!handler?.getArgumentCompletions) return;

    try {
      process.chdir(repoRoot);

      const cleanupCompletions =
        await handler.getArgumentCompletions("cleanup ");
      expect(cleanupCompletions?.map((item) => item.value)).toEqual(
        expect.arrayContaining(["--all", "cleanup-merged-task"]),
      );
    } finally {
      process.chdir(initialCwd);
    }
  });

  it("creates a todo from /todo add using an AI-generated id from the description", async () => {
    const repoRoot = createTempRepo();
    const commands = new Map<
      string,
      (args: string, ctx: unknown) => Promise<void>
    >();
    const notifications: Array<{ message: string; level: string }> = [];

    vi.mocked(complete).mockResolvedValue({
      stopReason: "stop",
      content: [{ type: "text", text: "status-banner-fix" }],
    } as never);

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

    const model = {
      id: "test-model",
      provider: "openai",
      api: "openai-responses",
      reasoning: true,
    };

    await handler("add Fix status banner", {
      cwd: repoRoot,
      hasUI: true,
      model,
      modelRegistry: {
        getApiKeyAndHeaders: vi.fn(async () => ({
          ok: true,
          apiKey: "test-key",
          headers: { "x-test": "1" },
        })),
      },
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
    ) as { todos: Array<{ id: string; description: string; status: string }> };

    expect(complete).toHaveBeenCalled();
    expect(store.todos).toHaveLength(1);
    expect(store.todos[0]).toMatchObject({
      id: "status-banner-fix",
      description: "Fix status banner",
      status: "todo",
    });
    expect(notifications).toContainEqual({
      message: 'Added TODO: "Fix status banner" [status-banner-fix]',
      level: "info",
    });
  });

  it("starts a newly added todo when using /todo add --start", async () => {
    const repoRoot = createTempRepo();
    initGitRepo(repoRoot);
    const worktreePath = path.join(repoRoot, ".wt", "fix-status-banner");
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
      if (args.includes("switch") && args.includes("--create")) {
        fs.mkdirSync(worktreePath, { recursive: true });
        return {
          code: 0,
          stdout: JSON.stringify({ action: "created", path: worktreePath }),
          stderr: "",
        };
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

    fs.mkdirSync(path.join(repoRoot, ".config"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, ".config", "wt.toml"), "", "utf-8");
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

    await handler("add --start Fix status banner", {
      cwd: repoRoot,
      hasUI: true,
      ui: {
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
    ) as {
      todos: Array<{
        id: string;
        status: string;
        workBranch?: string;
        sourceBranch?: string;
      }>;
    };

    expect(store.todos[0]).toMatchObject({
      id: "fix-status-banner",
      status: "doing",
      workBranch: "fix-status-banner",
      sourceBranch: "main",
    });
    expect(
      notifications.some(
        (item) =>
          item.message.includes("fix-status-banner") &&
          item.message.includes("branch"),
      ),
    ).toBe(true);
  });

  it("prompts to create a todo when /todo is opened with no existing tasks", async () => {
    const repoRoot = createTempRepo();
    const commands = new Map<
      string,
      (args: string, ctx: unknown) => Promise<void>
    >();
    const notifications: Array<{ message: string; level: string }> = [];
    const input = vi.fn(async () => "Write docs");
    const confirm = vi.fn(async () => false);

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
        throw new Error("exec should not run during todo creation prompt");
      },
    } as unknown as ExtensionAPI);

    const handler = commands.get("todo");
    expect(handler).toBeTypeOf("function");
    if (!handler) return;

    await handler("", {
      cwd: repoRoot,
      hasUI: true,
      ui: {
        input,
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
      switchSession: vi.fn(async () => ({ cancelled: false })),
    });

    const store = JSON.parse(
      fs.readFileSync(path.join(repoRoot, ".pi", "todos.json"), "utf-8"),
    ) as { todos: Array<{ id: string; status: string; description: string }> };

    expect(input).toHaveBeenCalledWith("New TODO:", "");
    expect(confirm).toHaveBeenCalledWith(
      'Start TODO "Write docs" now?',
      expect.stringContaining("write-docs"),
    );
    expect(store.todos[0]).toMatchObject({
      id: "write-docs",
      description: "Write docs",
      status: "todo",
    });
    expect(notifications).toContainEqual({
      message: 'Added TODO: "Write docs" [write-docs]',
      level: "info",
    });
  });

  it("lists todos with id, status, and branch details", async () => {
    const repoRoot = createTempRepo();
    const commands = new Map<
      string,
      (args: string, ctx: unknown) => Promise<void>
    >();
    const notifications: Array<{ message: string; level: string }> = [];

    fs.writeFileSync(
      path.join(repoRoot, ".pi", "todos.json"),
      JSON.stringify(
        {
          todos: [
            {
              id: "todo-1",
              title: "Write docs",
              status: "todo",
              createdAt: "2026-04-22T10:00:00.000Z",
              updatedAt: "2026-04-22T10:00:00.000Z",
            },
            {
              id: "todo-2",
              title: "Fix merge flow",
              status: "doing",
              sourceBranch: "main",
              workBranch: "fix-merge-flow",
              worktreePath: "/tmp/fix-merge-flow",
              createdAt: "2026-04-22T10:00:00.000Z",
              updatedAt: "2026-04-22T10:00:00.000Z",
              startedAt: "2026-04-22T10:01:00.000Z",
            },
            {
              id: "todo-3",
              title: "Ship release",
              status: "done",
              createdAt: "2026-04-22T10:00:00.000Z",
              updatedAt: "2026-04-22T10:00:00.000Z",
              completedAt: "2026-04-22T10:30:00.000Z",
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

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
        throw new Error("exec should not run during todo list");
      },
    } as unknown as ExtensionAPI);

    const handler = commands.get("todo");
    expect(handler).toBeTypeOf("function");
    if (!handler) return;

    await handler("list", {
      cwd: repoRoot,
      hasUI: false,
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

    expect(notifications).toContainEqual({
      message: expect.stringContaining("Write docs [todo-1] • todo"),
      level: "info",
    });
    expect(notifications[0]?.message).toContain(
      "Fix merge flow [todo-2] • doing • fix-merge-flow",
    );
    expect(notifications[0]?.message).toContain("Ship release [todo-3] • done");
  });

  it("shows detailed todo metadata for /todo show <id>", async () => {
    const repoRoot = createTempRepo();
    const commands = new Map<
      string,
      (args: string, ctx: unknown) => Promise<void>
    >();
    const notifications: Array<{ message: string; level: string }> = [];

    fs.writeFileSync(
      path.join(repoRoot, ".pi", "todos.json"),
      JSON.stringify(
        {
          todos: [
            {
              id: "todo-1",
              title: "Fix merge flow",
              status: "doing",
              sourceBranch: "main",
              workBranch: "fix-merge-flow",
              worktreePath: "/tmp/fix-merge-flow",
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
        throw new Error("exec should not run during todo show");
      },
    } as unknown as ExtensionAPI);

    const handler = commands.get("todo");
    expect(handler).toBeTypeOf("function");
    if (!handler) return;

    await handler("show todo-1", {
      cwd: repoRoot,
      hasUI: false,
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

    expect(notifications).toContainEqual({
      message: expect.stringContaining("id: todo-1"),
      level: "info",
    });
    expect(notifications[0]?.message).toContain("status: doing");
    expect(notifications[0]?.message).toContain("work branch: fix-merge-flow");
    expect(notifications[0]?.message).toContain("source branch: main");
  });

  it("removes a non-doing todo with /todo remove <id>", async () => {
    const repoRoot = createTempRepo();
    const commands = new Map<
      string,
      (args: string, ctx: unknown) => Promise<void>
    >();
    const notifications: Array<{ message: string; level: string }> = [];

    fs.writeFileSync(
      path.join(repoRoot, ".pi", "todos.json"),
      JSON.stringify(
        {
          todos: [
            {
              id: "write-docs",
              title: "Write docs",
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
        throw new Error("exec should not run during todo remove");
      },
    } as unknown as ExtensionAPI);

    const handler = commands.get("todo");
    expect(handler).toBeTypeOf("function");
    if (!handler) return;

    await handler("remove write-docs", {
      cwd: repoRoot,
      hasUI: false,
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
    ) as { todos: Array<{ id: string }> };

    expect(store.todos).toEqual([]);
    expect(notifications).toContainEqual({
      message: 'Removed TODO: "Write docs" [write-docs]',
      level: "info",
    });
  });

  it("disambiguates finish selection when multiple todos share the same description", async () => {
    const repoRoot = createTempRepo();
    const commands = new Map<
      string,
      (args: string, ctx: unknown) => Promise<void>
    >();
    const notifications: Array<{ message: string; level: string }> = [];
    const select = vi
      .fn<() => Promise<string | undefined>>()
      .mockResolvedValueOnce("Same task [todo-2] • doing • branch-2");
    const confirm = vi.fn(async () => false);
    const exec = vi.fn(async (command: string, args: string[]) => {
      if (
        command === "git" &&
        args[2] === "branch" &&
        args[3] === "--show-current"
      ) {
        return { code: 0, stdout: "branch-2\n", stderr: "" };
      }
      if (command === "wt" && args[2] === "merge") {
        return { code: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected ${command} args: ${args.join(" ")}`);
    });

    fs.writeFileSync(
      path.join(repoRoot, ".pi", "todos.json"),
      JSON.stringify(
        {
          todos: [
            {
              id: "todo-1",
              title: "Same task",
              status: "doing",
              sourceBranch: "main",
              workBranch: "branch-1",
              worktreePath: "/tmp/branch-1",
              createdAt: "2026-04-22T10:00:00.000Z",
              updatedAt: "2026-04-22T10:00:00.000Z",
              startedAt: "2026-04-22T10:01:00.000Z",
            },
            {
              id: "todo-2",
              title: "Same task",
              status: "doing",
              sourceBranch: "main",
              workBranch: "branch-2",
              worktreePath: "/tmp/branch-2",
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

    await handler("finish", {
      cwd: repoRoot,
      hasUI: true,
      ui: {
        select,
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
      switchSession: vi.fn(async () => ({ cancelled: false })),
    });

    expect(select).toHaveBeenCalledWith("Finish TODO:", [
      "Same task [todo-1] • doing • branch-1",
      "Same task [todo-2] • doing • branch-2",
    ]);
    expect(exec).toHaveBeenCalledWith("wt", [
      "-C",
      "/tmp/branch-2",
      "merge",
      "--no-remove",
      "main",
    ]);
    expect(notifications).toContainEqual({
      message: "Completed TODO: Same task",
      level: "info",
    });
  });

  it("falls back to the local slug id when AI id generation is unavailable", async () => {
    const repoRoot = createTempRepo();
    const commands = new Map<
      string,
      (args: string, ctx: unknown) => Promise<void>
    >();

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
        notify() {},
      },
      sessionManager: {
        getSessionFile() {
          return path.join(repoRoot, ".pi", "sessions", "current.jsonl");
        },
      },
    });

    const store = JSON.parse(
      fs.readFileSync(path.join(repoRoot, ".pi", "todos.json"), "utf-8"),
    ) as { todos: Array<{ id: string; description: string; status: string }> };

    expect(store.todos[0]).toMatchObject({
      id: "fix-status-banner",
      description: "Fix status banner",
      status: "todo",
    });
  });

  it("restores the current todo in the status bar on session start", async () => {
    const repoRoot = createTempRepo();
    const lifecycleHandlers = new Map<
      string,
      (event: unknown, ctx: unknown) => Promise<void>
    >();
    const setStatus = vi.fn();
    const sessionFile = path.join(repoRoot, ".pi", "sessions", "current.jsonl");

    fs.writeFileSync(
      path.join(repoRoot, ".pi", "todos.json"),
      JSON.stringify(
        {
          todos: [
            {
              id: "todo-1",
              title: "Resume worktree session",
              status: "doing",
              sourceBranch: "main",
              workBranch: "resume-worktree-session",
              worktreePath: "/tmp/resume-worktree-session",
              activeSessionKey: sessionFile,
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

    extension({
      registerCommand() {
        // no-op
      },
      on(
        event: string,
        handler: (event: unknown, ctx: unknown) => Promise<void>,
      ) {
        lifecycleHandlers.set(event, handler);
      },
      exec() {
        throw new Error("exec should not run during session lifecycle restore");
      },
    } as unknown as ExtensionAPI);

    const handler = lifecycleHandlers.get("session_start");
    expect(handler).toBeTypeOf("function");
    if (!handler) return;

    await handler(
      {},
      {
        cwd: repoRoot,
        hasUI: true,
        ui: {
          notify() {},
          setStatus,
        },
        sessionManager: {
          getSessionFile() {
            return sessionFile;
          },
        },
      },
    );

    expect(setStatus).toHaveBeenCalledWith(
      "todo-workflow",
      "TODO: Resume worktree session • resume-worktree-session",
    );
  });

  it("shows a working loader when starting a todo worktree", async () => {
    const repoRoot = createTempRepo();
    initGitRepo(repoRoot);
    const worktreePath = path.join(repoRoot, ".wt", "todo-1");

    fs.mkdirSync(path.join(repoRoot, ".config"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, ".config", "wt.toml"), "", "utf-8");
    fs.writeFileSync(
      path.join(repoRoot, ".pi", "todos.json"),
      JSON.stringify(
        {
          todos: [
            {
              id: "todo-1",
              title: "Start worktree todo",
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
    const { custom, renders } = createUiCustomMock();
    const select = vi.fn(async () => "Start a queued TODO");
    const setStatus = vi.fn();
    const exec = vi.fn(async (_command: string, args: string[]) => {
      if (
        args[0] === "-C" &&
        args[2] === "branch" &&
        args[3] === "--show-current"
      ) {
        return { code: 0, stdout: "main\n", stderr: "" };
      }
      if (args.includes("switch") && args.includes("--create")) {
        fs.mkdirSync(worktreePath, { recursive: true });
        return {
          code: 0,
          stdout: JSON.stringify({ action: "created", path: worktreePath }),
          stderr: "",
        };
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
        custom,
        select,
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
        setStatus,
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
    ) as {
      todos: Array<{
        status: string;
        workBranch?: string;
        sourceBranch?: string;
      }>;
    };

    expect(select).toHaveBeenCalledTimes(1);
    expect(renders).toHaveLength(1);
    expect(renders[0]).toContain("Working...");
    expect(store.todos[0]).toMatchObject({
      status: "doing",
      workBranch: "todo-1",
      sourceBranch: "main",
    });
    expect(notifications).toContainEqual({
      message: "doing: Start worktree todo",
      level: "info",
    });
    expect(setStatus).toHaveBeenCalledWith(
      "todo-workflow",
      "TODO: Start worktree todo • todo-1",
    );
  });

  it("uses the replacement session context after auto-switching a started todo", async () => {
    const initialCwd = process.cwd();
    const repoRoot = createTempRepo();
    initGitRepo(repoRoot);
    const worktreePath = path.join(repoRoot, ".wt", "todo-1");

    fs.mkdirSync(path.join(repoRoot, ".config"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, ".config", "wt.toml"), "", "utf-8");
    fs.writeFileSync(
      path.join(repoRoot, ".pi", "todos.json"),
      JSON.stringify(
        {
          todos: [
            {
              id: "todo-1",
              title: "Start worktree todo",
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
              autoSwitchToWorktreeSession: true,
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
    const { custom, renders } = createUiCustomMock();
    const select = vi.fn(async () => "Start a queued TODO");
    const setStatus = vi.fn();
    const replacementNotifications: Array<{ message: string; level: string }> =
      [];
    const replacementSetStatus = vi.fn();
    const sourceSession = SessionManager.create(repoRoot);
    sourceSession.appendCustomEntry("test", { ready: true });

    let activeSessionFile = sourceSession.getSessionFile() as string;
    const sessionManager = {
      getSessionFile() {
        return activeSessionFile;
      },
      getHeader() {
        return sourceSession.getHeader();
      },
      getEntries() {
        return sourceSession.getEntries();
      },
    };
    let stale = false;
    const switchSession = vi.fn(
      async (
        sessionPath: string,
        options?: {
          withSession?: (ctx: {
            cwd: string;
            hasUI: true;
            ui: {
              notify: (message: string, level: string) => void;
              setStatus: ReturnType<typeof vi.fn>;
            };
            sessionManager: typeof sessionManager;
          }) => Promise<void>;
        },
      ) => {
        activeSessionFile = sessionPath;
        stale = true;
        await options?.withSession?.({
          cwd: repoRoot,
          hasUI: true,
          ui: {
            notify(message: string, level: string) {
              replacementNotifications.push({ message, level });
            },
            setStatus: replacementSetStatus,
          },
          sessionManager,
        });
        return { cancelled: false };
      },
    );
    const exec = vi.fn(async (_command: string, args: string[]) => {
      if (
        args[0] === "-C" &&
        args[2] === "branch" &&
        args[3] === "--show-current"
      ) {
        return { code: 0, stdout: "main\n", stderr: "" };
      }
      if (args.includes("switch") && args.includes("--create")) {
        fs.mkdirSync(worktreePath, { recursive: true });
        return {
          code: 0,
          stdout: JSON.stringify({ action: "created", path: worktreePath }),
          stderr: "",
        };
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

    try {
      await expect(
        handler("", {
          get cwd() {
            if (stale) {
              throw new Error(
                "This extension instance is stale after session replacement or reload. Use the provided replacement-session context instead.",
              );
            }
            return repoRoot;
          },
          hasUI: true,
          ui: {
            custom,
            select,
            notify(message: string, level: string) {
              if (stale) {
                throw new Error(
                  "This extension instance is stale after session replacement or reload. Use the provided replacement-session context instead.",
                );
              }
              notifications.push({ message, level });
            },
            setStatus(...args: Parameters<typeof setStatus>) {
              if (stale) {
                throw new Error(
                  "This extension instance is stale after session replacement or reload. Use the provided replacement-session context instead.",
                );
              }
              return setStatus(...args);
            },
          },
          sessionManager,
          switchSession,
        }),
      ).resolves.toBeUndefined();

      const store = JSON.parse(
        fs.readFileSync(path.join(repoRoot, ".pi", "todos.json"), "utf-8"),
      ) as {
        todos: Array<{
          status: string;
          workBranch?: string;
          sourceBranch?: string;
          activeSessionKey?: string;
        }>;
      };

      expect(select).toHaveBeenCalledTimes(1);
      expect(renders).toHaveLength(1);
      expect(renders[0]).toContain("Working...");
      expect(switchSession).toHaveBeenCalledTimes(1);
      expect(store.todos[0]).toMatchObject({
        status: "doing",
        workBranch: "todo-1",
        sourceBranch: "main",
        activeSessionKey: activeSessionFile,
      });
      expect(setStatus).not.toHaveBeenCalled();
      expect(replacementSetStatus).toHaveBeenCalledWith(
        "todo-workflow",
        "TODO: Start worktree todo • todo-1",
      );
      expect(notifications).toEqual([]);
      expect(replacementNotifications).toContainEqual({
        message: "doing: Start worktree todo",
        level: "info",
      });
      expect(fs.realpathSync(process.cwd())).toBe(
        fs.realpathSync(worktreePath),
      );
    } finally {
      process.chdir(initialCwd);
    }
  });

  it("switches to an existing todo branch instead of failing to recreate it", async () => {
    const repoRoot = createTempRepo();
    initGitRepo(repoRoot);
    const worktreePath = path.join(repoRoot, ".wt", "improve-todo-view");

    fs.mkdirSync(path.join(repoRoot, ".config"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, ".config", "wt.toml"), "", "utf-8");
    fs.writeFileSync(
      path.join(repoRoot, ".pi", "todos.json"),
      JSON.stringify(
        {
          todos: [
            {
              id: "improve-todo-view",
              title: "Improve todo view",
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
    const { custom, renders } = createUiCustomMock();
    const select = vi.fn(async () => "Start a queued TODO");
    const exec = vi.fn(async (_command: string, args: string[]) => {
      if (
        args[0] === "-C" &&
        args[2] === "branch" &&
        args[3] === "--show-current"
      ) {
        return { code: 0, stdout: "main\n", stderr: "" };
      }
      if (args.includes("switch") && args.includes("--create")) {
        return {
          code: 1,
          stdout: "",
          stderr:
            "✗ Branch improve-todo-view already exists\n ↳ To switch to the existing branch, run without --create: wt switch improve-todo-view",
        };
      }
      if (
        args[0] === "-C" &&
        args[2] === "switch" &&
        !args.includes("--create")
      ) {
        fs.mkdirSync(worktreePath, { recursive: true });
        return {
          code: 0,
          stdout: JSON.stringify({ action: "switched", path: worktreePath }),
          stderr: "",
        };
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
        custom,
        select,
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
    ) as {
      todos: Array<{
        status: string;
        workBranch?: string;
        sourceBranch?: string;
      }>;
    };

    expect(select).toHaveBeenCalledTimes(1);
    expect(renders).toHaveLength(1);
    expect(renders[0]).toContain("Working...");
    expect(exec.mock.calls).toContainEqual([
      "wt",
      expect.arrayContaining([
        "switch",
        "--create",
        "improve-todo-view",
        "--base",
        "main",
        "--no-cd",
        "--yes",
      ]),
    ]);
    expect(exec.mock.calls).toContainEqual([
      "wt",
      expect.arrayContaining([
        "switch",
        "improve-todo-view",
        "--no-cd",
        "--yes",
      ]),
    ]);
    expect(store.todos[0]).toMatchObject({
      status: "doing",
      workBranch: "improve-todo-view",
      sourceBranch: "main",
    });
    expect(notifications).toContainEqual({
      message: "doing: Improve todo view",
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
        select: async () => "Start a queued TODO",
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
        select: async () => "Resume current TODO",
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

  it("switches to the worktree session when resuming a doing todo", async () => {
    const initialCwd = process.cwd();
    const repoRoot = createTempRepo();
    const worktreePath = createTempRepo();

    fs.writeFileSync(
      path.join(repoRoot, ".pi", "todos.json"),
      JSON.stringify(
        {
          todos: [
            {
              id: "todo-1",
              title: "Resume worktree session",
              status: "doing",
              sourceBranch: "main",
              workBranch: "resume-worktree-session",
              worktreePath,
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
    const { custom, renders } = createUiCustomMock();
    const select = vi.fn(async () => "Resume current TODO");
    const setStatus = vi.fn();
    const sourceSession = SessionManager.create(repoRoot);
    sourceSession.appendCustomEntry("test", { ready: true });

    let activeSessionFile = sourceSession.getSessionFile() as string;
    const sessionManager = {
      getSessionFile() {
        return activeSessionFile;
      },
      getHeader() {
        return sourceSession.getHeader();
      },
      getEntries() {
        return sourceSession.getEntries();
      },
    };
    let stale = false;
    const replacementNotifications: Array<{ message: string; level: string }> =
      [];
    const replacementSetStatus = vi.fn();
    const switchSession = vi.fn(
      async (
        sessionPath: string,
        options?: {
          withSession?: (ctx: {
            cwd: string;
            hasUI: true;
            ui: {
              notify: (message: string, level: string) => void;
              setStatus: ReturnType<typeof vi.fn>;
            };
            sessionManager: typeof sessionManager;
          }) => Promise<void>;
        },
      ) => {
        activeSessionFile = sessionPath;
        stale = true;
        await options?.withSession?.({
          cwd: repoRoot,
          hasUI: true,
          ui: {
            notify(message: string, level: string) {
              replacementNotifications.push({ message, level });
            },
            setStatus: replacementSetStatus,
          },
          sessionManager,
        });
        return { cancelled: false };
      },
    );
    const exec = vi.fn(async (_command: string, args: string[]) => {
      if (args[2] === "switch") {
        return {
          code: 0,
          stdout: JSON.stringify({ path: worktreePath }),
          stderr: "",
        };
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

    try {
      await handler("", {
        cwd: repoRoot,
        hasUI: true,
        ui: {
          custom,
          select,
          notify(message: string, level: string) {
            if (stale) {
              throw new Error(
                "This extension instance is stale after session replacement or reload. Use the provided replacement-session context instead.",
              );
            }
            notifications.push({ message, level });
          },
          setStatus(...args: Parameters<typeof setStatus>) {
            if (stale) {
              throw new Error(
                "This extension instance is stale after session replacement or reload. Use the provided replacement-session context instead.",
              );
            }
            return setStatus(...args);
          },
        },
        sessionManager,
        switchSession,
      });

      const store = JSON.parse(
        fs.readFileSync(path.join(repoRoot, ".pi", "todos.json"), "utf-8"),
      ) as { todos: Array<{ activeSessionKey?: string; status: string }> };

      expect(select).toHaveBeenCalledTimes(1);
      expect(renders).toHaveLength(1);
      expect(renders[0]).toContain("Working...");
      expect(exec).toHaveBeenCalledWith("wt", [
        "-C",
        repoRoot,
        "switch",
        "resume-worktree-session",
        "--no-cd",
        "--yes",
      ]);
      expect(switchSession).toHaveBeenCalledTimes(1);
      expect(store.todos[0]).toMatchObject({
        status: "doing",
        activeSessionKey: activeSessionFile,
      });
      expect(setStatus).not.toHaveBeenCalled();
      expect(replacementSetStatus).toHaveBeenCalledWith(
        "todo-workflow",
        "TODO: Resume worktree session • resume-worktree-session",
      );
      expect(notifications).toEqual([]);
      expect(replacementNotifications).toContainEqual({
        message: "doing: Resume worktree session",
        level: "info",
      });
      expect(fs.realpathSync(process.cwd())).toBe(
        fs.realpathSync(worktreePath),
      );
    } finally {
      process.chdir(initialCwd);
    }
  });

  it("finishes a specific todo id and skips target selection", async () => {
    const repoRoot = createTempRepo();
    fs.writeFileSync(
      path.join(repoRoot, ".pi", "todos.json"),
      JSON.stringify(
        {
          todos: [
            {
              id: "todo-1",
              title: "Finish explicit todo",
              status: "doing",
              sourceBranch: "main",
              workBranch: "finish-explicit-todo",
              worktreePath: "/tmp/finish-explicit-todo",
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
    const { custom, renders } = createUiCustomMock();
    const select = vi.fn(async () => "should-not-run");
    const confirm = vi.fn(async () => false);
    const exec = vi.fn(async (command: string, args: string[]) => {
      if (
        command === "git" &&
        args[2] === "branch" &&
        args[3] === "--show-current"
      ) {
        return { code: 0, stdout: "finish-explicit-todo\n", stderr: "" };
      }
      if (command === "wt" && args[2] === "merge") {
        return { code: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected ${command} args: ${args.join(" ")}`);
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

    await handler("finish todo-1", {
      cwd: repoRoot,
      hasUI: true,
      ui: {
        custom,
        select,
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
      switchSession: vi.fn(async () => ({ cancelled: false })),
    });

    const store = JSON.parse(
      fs.readFileSync(path.join(repoRoot, ".pi", "todos.json"), "utf-8"),
    ) as { todos: Array<{ status: string; completedAt?: string }> };

    expect(renders).toHaveLength(1);
    expect(renders[0]).toContain("Merging...");
    expect(select).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith("wt", [
      "-C",
      "/tmp/finish-explicit-todo",
      "merge",
      "--no-remove",
      "main",
    ]);
    expect(store.todos[0]?.status).toBe("done");
    expect(store.todos[0]?.completedAt).toBeTruthy();
    expect(notifications).toContainEqual({
      message: "Completed TODO: Finish explicit todo",
      level: "info",
    });
  });

  it("cleans up one merged todo and reconciles it to done", async () => {
    const repoRoot = createTempRepo();
    fs.writeFileSync(
      path.join(repoRoot, ".pi", "todos.json"),
      JSON.stringify(
        {
          todos: [
            {
              id: "todo-1",
              title: "Cleanup merged todo",
              status: "doing",
              sourceBranch: "main",
              workBranch: "cleanup-merged-todo",
              worktreePath: "/tmp/cleanup-merged-todo",
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
    const { custom, renders } = createUiCustomMock();
    const select = vi.fn(async () => "Local worktree + local branch");
    const exec = vi.fn(async (_command: string, args: string[]) => {
      if (args.includes("rev-parse")) {
        return { code: 0, stdout: "sha\n", stderr: "" };
      }
      if (args.includes("merge-base")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "-C" && args[2] === "remove") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[2] === "branch" && args[3] === "-d") {
        return { code: 0, stdout: "", stderr: "" };
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

    await handler("cleanup todo-1", {
      cwd: repoRoot,
      hasUI: true,
      ui: {
        custom,
        select,
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
    ) as {
      todos: Array<{
        status: string;
        completedAt?: string;
        activeSessionKey?: string;
      }>;
    };

    expect(renders).toHaveLength(1);
    expect(renders[0]).toContain("Cleaning...");
    expect(select).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith("wt", [
      "-C",
      repoRoot,
      "remove",
      "cleanup-merged-todo",
      "--yes",
      "--foreground",
    ]);
    expect(exec).toHaveBeenCalledWith("git", [
      "-C",
      repoRoot,
      "branch",
      "-d",
      "cleanup-merged-todo",
    ]);
    expect(store.todos[0]).toMatchObject({
      status: "done",
      completedAt: expect.any(String),
    });
    expect(
      notifications.some((item) =>
        item.message.includes("Cleanup merged todo"),
      ),
    ).toBe(true);
  });

  it("cleans up all merged todos and skips the rest", async () => {
    const repoRoot = createTempRepo();
    fs.writeFileSync(
      path.join(repoRoot, ".pi", "todos.json"),
      JSON.stringify(
        {
          todos: [
            {
              id: "merged-todo",
              title: "Merged todo",
              status: "doing",
              sourceBranch: "main",
              workBranch: "merged-todo",
              worktreePath: "/tmp/merged-todo",
              createdAt: "2026-04-22T10:00:00.000Z",
              updatedAt: "2026-04-22T10:00:00.000Z",
              startedAt: "2026-04-22T10:01:00.000Z",
            },
            {
              id: "not-merged-todo",
              title: "Not merged todo",
              status: "doing",
              sourceBranch: "main",
              workBranch: "not-merged-todo",
              worktreePath: "/tmp/not-merged-todo",
              createdAt: "2026-04-22T10:00:00.000Z",
              updatedAt: "2026-04-22T10:00:00.000Z",
              startedAt: "2026-04-22T10:01:00.000Z",
            },
            {
              id: "missing-meta",
              title: "Missing metadata",
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

    const commands = new Map<
      string,
      (args: string, ctx: unknown) => Promise<void>
    >();
    const notifications: Array<{ message: string; level: string }> = [];
    const { custom, renders } = createUiCustomMock();
    const confirm = vi.fn(async () => true);
    const exec = vi.fn(async (_command: string, args: string[]) => {
      const branch = args[args.length - 2];
      if (args.includes("rev-parse")) {
        return { code: 0, stdout: "sha\n", stderr: "" };
      }
      if (args.includes("merge-base")) {
        return branch === "merged-todo"
          ? { code: 0, stdout: "", stderr: "" }
          : { code: 1, stdout: "", stderr: "" };
      }
      if (args[0] === "-C" && args[2] === "remove") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[2] === "branch" && args[3] === "-d") {
        return { code: 0, stdout: "", stderr: "" };
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

    await handler("cleanup --all", {
      cwd: repoRoot,
      hasUI: true,
      ui: {
        custom,
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
      switchSession: vi.fn(async () => ({ cancelled: false })),
    });

    const store = JSON.parse(
      fs.readFileSync(path.join(repoRoot, ".pi", "todos.json"), "utf-8"),
    ) as { todos: Array<{ id: string; status: string; completedAt?: string }> };

    const mergedTodo = store.todos.find((todo) => todo.id === "merged-todo");
    const notMergedTodo = store.todos.find(
      (todo) => todo.id === "not-merged-todo",
    );
    const missingMetaTodo = store.todos.find(
      (todo) => todo.id === "missing-meta",
    );

    expect(renders).toHaveLength(1);
    expect(renders[0]).toContain("Cleaning...");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(mergedTodo).toMatchObject({
      status: "done",
      completedAt: expect.any(String),
    });
    expect(notMergedTodo?.status).toBe("doing");
    expect(missingMetaTodo?.status).toBe("todo");
    expect(
      notifications.some(
        (item) =>
          item.message.includes("cleaned 1") &&
          item.message.includes("skipped not merged 1") &&
          item.message.includes("skipped invalid 1"),
      ),
    ).toBe(true);
  });

  it("reports finish usage with /todo wording instead of leaking legacy command names", async () => {
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
        throw new Error("exec should not run for usage validation");
      },
    } as unknown as ExtensionAPI);

    const handler = commands.get("todo");
    expect(handler).toBeTypeOf("function");
    if (!handler) return;

    await handler("finish todo-1 extra", {
      cwd: repoRoot,
      hasUI: false,
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

    expect(notifications).toContainEqual({
      message: "Usage: /todo [finish [<todo-id>] | cleanup [<todo-id>|--all]]",
      level: "error",
    });
  });

  it("keeps todo doing when /todo finish merge fails", async () => {
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
    const exec = vi.fn(async (command: string, args: string[]) => {
      if (
        command === "git" &&
        args[2] === "branch" &&
        args[3] === "--show-current"
      ) {
        return { code: 0, stdout: "other-branch\n", stderr: "" };
      }
      if (command === "wt" && args[2] === "list") {
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
      if (command === "wt" && args[2] === "switch") {
        return {
          code: 0,
          stdout: JSON.stringify({ path: "/tmp/finish-merge-flow" }),
          stderr: "",
        };
      }
      if (command === "wt" && args[2] === "merge") {
        return { code: 1, stdout: "", stderr: "conflict" };
      }
      throw new Error(`Unexpected ${command} args: ${args.join(" ")}`);
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

    const select = vi
      .fn<() => Promise<string | undefined>>()
      .mockResolvedValueOnce(
        "Finish merge flow [todo-1] • doing • finish-merge-flow",
      );

    await handler("finish", {
      cwd: repoRoot,
      hasUI: true,
      ui: {
        select,
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

    expect(exec).toHaveBeenCalledWith("wt", [
      "-C",
      "/tmp/finish-merge-flow",
      "merge",
      "--no-remove",
      "main",
    ]);
    expect(store.todos[0]?.status).toBe("doing");
    expect(store.todos[0]?.completedAt).toBeUndefined();
    expect(notifications.some((item) => item.level === "error")).toBe(true);
  });
});
