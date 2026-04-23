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

    expect(commands.sort()).toEqual(["end_todo", "todo"]);
  });

  it("offers end_todo argument completions for finish and cleanup flows", async () => {
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

    const handler = commands.get("end_todo");
    expect(handler?.getArgumentCompletions).toBeTypeOf("function");
    if (!handler?.getArgumentCompletions) return;

    try {
      process.chdir(repoRoot);

      const rootCompletions = await handler.getArgumentCompletions("");
      expect(rootCompletions?.map((item) => item.value)).toEqual(
        expect.arrayContaining(["finish", "cleanup"]),
      );

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
      message: 'Added TODO: "Fix status banner"',
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
    const { custom, renders } = createUiCustomMock("todo-1");
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
    const { custom, renders } = createUiCustomMock("todo-1");
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
      expect(replacementSetStatus).not.toHaveBeenCalled();
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

    const handler = commands.get("end_todo");
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

    const handler = commands.get("end_todo");
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

    const handler = commands.get("end_todo");
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

    const handler = commands.get("end_todo");
    expect(handler).toBeTypeOf("function");
    if (!handler) return;

    const select = vi
      .fn<() => Promise<string | undefined>>()
      .mockResolvedValueOnce("Finish a todo")
      .mockResolvedValueOnce("Finish merge flow");

    await handler("", {
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
