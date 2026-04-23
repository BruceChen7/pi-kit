import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  type ExtensionAPI,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { clearSettingsCache } from "../shared/settings.js";
import extension from "./index.js";
import {
  FEATURE_WORKFLOW_RECOMMENDED_WORKTREE_PATH_TEMPLATE,
  getFeatureWorkflowWorktrunkUserConfigPath,
} from "./setup.js";

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

const runGit = (cwd: string, args: string[]) =>
  spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test User",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test User",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });

const createTempRepo = (): string => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-kit-feature-workflow-"),
  );
  tempDirs.push(dir);
  runGit(dir, ["init"]);
  return dir;
};

const createTempRepoWithMainBranch = (): string => {
  const dir = createTempRepo();
  fs.writeFileSync(path.join(dir, "README.md"), "test\n", "utf-8");
  runGit(dir, ["add", "README.md"]);
  runGit(dir, ["commit", "-m", "init"]);
  runGit(dir, ["branch", "-M", "main"]);
  return dir;
};

afterEach(() => {
  clearSettingsCache();
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("feature-workflow extension", () => {
  it("registers expected commands", () => {
    const commands: string[] = [];

    extension({
      registerCommand(name: string) {
        commands.push(name);
      },
      exec() {
        throw new Error("exec should not run during registration");
      },
      on() {
        // no-op
      },
    } as unknown as ExtensionAPI);

    expect(commands.sort()).toEqual([
      "feature-list",
      "feature-prune-merged",
      "feature-setup",
      "feature-start",
      "feature-switch",
      "feature-validate",
    ]);
  });

  it("warns and stops feature-start when local wt.toml is missing", async () => {
    const repoRoot = createTempRepo();
    const commands = new Map<
      string,
      (args: string, ctx: unknown) => Promise<void>
    >();
    const exec = vi.fn();
    const notifications: Array<{ message: string; level: string }> = [];

    extension({
      registerCommand(
        name: string,
        definition: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) {
        commands.set(name, definition.handler);
      },
      exec,
      on() {
        // no-op
      },
    } as unknown as ExtensionAPI);

    const handler = commands.get("feature-start");
    expect(handler).toBeTypeOf("function");
    if (!handler) return;

    await handler("", {
      cwd: repoRoot,
      hasUI: false,
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    });

    expect(notifications).toEqual([
      {
        message:
          "feature-start requires local setup-managed files that are missing: .config/wt.toml. Run /feature-setup first.",
        level: "warning",
      },
    ]);
    expect(exec).not.toHaveBeenCalled();
  });

  it("allows /feature-start when the workspace has only untracked files", async () => {
    const repoRoot = createTempRepoWithMainBranch();
    fs.mkdirSync(path.join(repoRoot, ".config"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, ".config", "wt.toml"), "", "utf-8");
    fs.mkdirSync(path.join(repoRoot, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, ".pi", "third_extension_settings.json"),
      JSON.stringify(
        {
          featureWorkflow: {
            guards: {
              requireCleanWorkspace: true,
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
    runGit(repoRoot, [
      "add",
      ".config/wt.toml",
      ".pi/third_extension_settings.json",
    ]);
    runGit(repoRoot, ["commit", "-m", "setup"]);
    fs.writeFileSync(path.join(repoRoot, "notes.txt"), "scratch\n", "utf-8");

    const resolvedRepoRoot = runGit(repoRoot, [
      "rev-parse",
      "--show-toplevel",
    ]).stdout.trim();
    const worktreePath = path.join(repoRoot, ".wt", "fix-untracked-create");
    const commands = new Map<
      string,
      (args: string, ctx: unknown) => Promise<void>
    >();
    const notifications: Array<{ message: string; level: string }> = [];
    const exec = vi.fn(async (_command: string, args: string[]) => {
      if (args.includes("switch") && args.includes("--create")) {
        fs.mkdirSync(worktreePath, { recursive: true });
        return {
          code: 0,
          stdout: JSON.stringify({ action: "created", path: worktreePath }),
          stderr: "",
        };
      }

      throw new Error(`Unexpected wt args: ${args.join(" ")}`);
    });

    extension({
      registerCommand(
        name: string,
        definition: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) {
        commands.set(name, definition.handler);
      },
      exec,
      on() {
        // no-op
      },
    } as unknown as ExtensionAPI);

    const handler = commands.get("feature-start");
    expect(handler).toBeTypeOf("function");
    if (!handler) return;

    await handler("", {
      cwd: repoRoot,
      hasUI: true,
      ui: {
        async input(prompt: string) {
          if (prompt === "Branch slug:") {
            return "fix-untracked-create";
          }
          throw new Error(`Unexpected input prompt: ${prompt}`);
        },
        async select(prompt: string) {
          if (prompt === "Base branch:") {
            return "main";
          }
          throw new Error(`Unexpected select prompt: ${prompt}`);
        },
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
      sessionManager: {
        getSessionFile() {
          return null;
        },
      },
      async switchSession() {
        return { cancelled: false };
      },
    });

    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith("wt", [
      "-C",
      resolvedRepoRoot,
      "switch",
      "--create",
      "fix-untracked-create",
      "--base",
      "main",
      "--no-cd",
      "--yes",
    ]);
    expect(notifications).toContainEqual({
      message:
        "Workspace has only untracked files (notes.txt). Continuing /feature-start.",
      level: "info",
    });
  });

  it("blocks /feature-start when tracked changes are present", async () => {
    const repoRoot = createTempRepoWithMainBranch();
    fs.mkdirSync(path.join(repoRoot, ".config"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, ".config", "wt.toml"), "", "utf-8");
    fs.mkdirSync(path.join(repoRoot, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, ".pi", "third_extension_settings.json"),
      JSON.stringify(
        {
          featureWorkflow: {
            guards: {
              requireCleanWorkspace: true,
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
    runGit(repoRoot, [
      "add",
      ".config/wt.toml",
      ".pi/third_extension_settings.json",
    ]);
    runGit(repoRoot, ["commit", "-m", "setup"]);
    fs.writeFileSync(path.join(repoRoot, "README.md"), "changed\n", "utf-8");
    fs.writeFileSync(path.join(repoRoot, "scratch.txt"), "scratch\n", "utf-8");

    const commands = new Map<
      string,
      (args: string, ctx: unknown) => Promise<void>
    >();
    const notifications: Array<{ message: string; level: string }> = [];
    const exec = vi.fn();

    extension({
      registerCommand(
        name: string,
        definition: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) {
        commands.set(name, definition.handler);
      },
      exec,
      on() {
        // no-op
      },
    } as unknown as ExtensionAPI);

    const handler = commands.get("feature-start");
    expect(handler).toBeTypeOf("function");
    if (!handler) return;

    await handler("", {
      cwd: repoRoot,
      hasUI: true,
      ui: {
        async input(prompt: string) {
          throw new Error(`input should not run: ${prompt}`);
        },
        async select(prompt: string) {
          throw new Error(`select should not run: ${prompt}`);
        },
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    });

    expect(exec).not.toHaveBeenCalled();
    expect(notifications).toEqual([
      {
        message:
          "Repository is dirty (staged 0, unstaged 1, untracked 1). Commit/stash first.",
        level: "warning",
      },
    ]);
  });

  it("shows a blocking working loader during /feature-start in UI mode", async () => {
    const repoRoot = createTempRepoWithMainBranch();
    fs.mkdirSync(path.join(repoRoot, ".config"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, ".config", "wt.toml"), "", "utf-8");
    fs.mkdirSync(path.join(repoRoot, ".pi"), { recursive: true });
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

    const worktreePath = path.join(repoRoot, ".wt", "fix-loader-start");
    const commands = new Map<
      string,
      (args: string, ctx: unknown) => Promise<void>
    >();
    const notifications: Array<{ message: string; level: string }> = [];
    const loaderRenders: string[] = [];
    const exec = vi.fn(async (_command: string, args: string[]) => {
      if (args.includes("switch") && args.includes("--create")) {
        fs.mkdirSync(worktreePath, { recursive: true });
        return {
          code: 0,
          stdout: JSON.stringify({ action: "created", path: worktreePath }),
          stderr: "",
        };
      }

      throw new Error(`Unexpected wt args: ${args.join(" ")}`);
    });

    extension({
      registerCommand(
        name: string,
        definition: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) {
        commands.set(name, definition.handler);
      },
      exec,
      on() {
        // no-op
      },
    } as unknown as ExtensionAPI);

    const handler = commands.get("feature-start");
    expect(handler).toBeTypeOf("function");
    if (!handler) return;

    await handler("", {
      cwd: repoRoot,
      hasUI: true,
      ui: {
        async input(prompt: string) {
          if (prompt === "Branch slug:") {
            return "fix-loader-start";
          }
          throw new Error(`Unexpected input prompt: ${prompt}`);
        },
        async select(prompt: string) {
          if (prompt === "Base branch:") {
            return "main";
          }
          throw new Error(`Unexpected select prompt: ${prompt}`);
        },
        async custom(factory: LoaderFactory) {
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

            loaderRenders.push(component.render(80).join("\n"));
          });

          component?.dispose?.();
          return result;
        },
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
      sessionManager: {
        getSessionFile() {
          return null;
        },
      },
      async switchSession() {
        return { cancelled: false };
      },
    });

    expect(loaderRenders).toHaveLength(1);
    expect(loaderRenders[0]).toContain("Working...");
    expect(
      notifications.some((item) =>
        item.message.includes("Creating worktree for"),
      ),
    ).toBe(false);
    expect(notifications).toContainEqual({
      message: "Feature worktree created: fix-loader-start",
      level: "info",
    });
  });

  it("creates a slug-only feature branch from the selected slug without local registry persistence", async () => {
    const repoRoot = createTempRepoWithMainBranch();
    fs.mkdirSync(path.join(repoRoot, ".config"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, ".config", "wt.toml"), "", "utf-8");
    fs.mkdirSync(path.join(repoRoot, ".pi"), { recursive: true });
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

    const resolvedRepoRoot = runGit(repoRoot, [
      "rev-parse",
      "--show-toplevel",
    ]).stdout.trim();
    const worktreePath = path.join(repoRoot, ".wt", "fix-annotate-auto-last");
    const commands = new Map<
      string,
      (args: string, ctx: unknown) => Promise<void>
    >();
    const notifications: Array<{ message: string; level: string }> = [];
    const inputs: string[] = [];
    const selects: Array<{ prompt: string; options: string[] }> = [];
    const exec = vi.fn(async (_command: string, args: string[]) => {
      if (args.at(-3) === "list" || args.includes("list")) {
        return { code: 0, stdout: "[]", stderr: "" };
      }

      if (args.includes("switch") && args.includes("--create")) {
        fs.mkdirSync(worktreePath, { recursive: true });
        return {
          code: 0,
          stdout: JSON.stringify({ action: "created", path: worktreePath }),
          stderr: "",
        };
      }

      throw new Error(`Unexpected wt args: ${args.join(" ")}`);
    });

    extension({
      registerCommand(
        name: string,
        definition: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) {
        commands.set(name, definition.handler);
      },
      exec,
      on() {
        // no-op
      },
    } as unknown as ExtensionAPI);

    const handler = commands.get("feature-start");
    expect(handler).toBeTypeOf("function");
    if (!handler) return;

    await handler("", {
      cwd: repoRoot,
      hasUI: true,
      ui: {
        async input(prompt: string) {
          inputs.push(prompt);
          if (prompt === "Branch slug:") {
            return "fix-annotate-auto-last";
          }
          throw new Error(`Unexpected input prompt: ${prompt}`);
        },
        async select(prompt: string, options: string[]) {
          selects.push({ prompt, options });
          if (prompt === "Base branch:") {
            return "main";
          }
          throw new Error(`Unexpected select prompt: ${prompt}`);
        },
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
      sessionManager: {
        getSessionFile() {
          return null;
        },
      },
      async switchSession() {
        return { cancelled: false };
      },
    });

    expect(inputs).toEqual(["Branch slug:"]);
    expect(selects).toEqual([
      {
        prompt: "Base branch:",
        options: ["main"],
      },
    ]);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenNthCalledWith(1, "wt", [
      "-C",
      resolvedRepoRoot,
      "switch",
      "--create",
      "fix-annotate-auto-last",
      "--base",
      "main",
      "--no-cd",
      "--yes",
    ]);
    expect(exec.mock.calls[0]?.[1]).not.toContain(
      "master--fix-annotate-auto-last",
    );
    expect(notifications).toEqual([
      {
        message: "Feature worktree created: fix-annotate-auto-last",
        level: "info",
      },
    ]);
    expect(
      fs.existsSync(
        path.join(repoRoot, ".pi", "feature-workflow-branches.json"),
      ),
    ).toBe(false);
  });

  it("updates the Worktrunk user config after interactive confirmation", async () => {
    const repoRoot = createTempRepoWithMainBranch();
    const userHomePath = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-kit-feature-setup-home-"),
    );
    tempDirs.push(userHomePath);
    const previousHome = process.env.HOME;
    process.env.HOME = userHomePath;

    try {
      const commands = new Map<
        string,
        (args: string, ctx: unknown) => Promise<void>
      >();
      const notifications: Array<{ message: string; level: string }> = [];
      const selects: Array<{ prompt: string; options: string[] }> = [];
      const confirms: Array<{ prompt: string; description: string }> = [];

      extension({
        registerCommand(
          name: string,
          definition: {
            handler: (args: string, ctx: unknown) => Promise<void>;
          },
        ) {
          commands.set(name, definition.handler);
        },
        exec() {
          throw new Error("exec should not run during feature-setup");
        },
        on() {
          // no-op
        },
      } as unknown as ExtensionAPI);

      const handler = commands.get("feature-setup");
      expect(handler).toBeTypeOf("function");
      if (!handler) return;

      await handler("npm", {
        cwd: repoRoot,
        hasUI: true,
        ui: {
          async select(prompt: string, options: string[]) {
            selects.push({ prompt, options });
            if (prompt === "feature-setup scope:") {
              return "Apply all recommended files";
            }
            throw new Error(`Unexpected select prompt: ${prompt}`);
          },
          async confirm(prompt: string, description: string) {
            confirms.push({ prompt, description });
            if (prompt === "Update Worktrunk user worktree-path?") {
              return true;
            }
            throw new Error(`Unexpected confirm prompt: ${prompt}`);
          },
          notify(message: string, level: string) {
            notifications.push({ message, level });
          },
        },
      });

      expect(selects).toEqual([
        {
          prompt: "feature-setup scope:",
          options: ["Apply all recommended files", "Customize files", "Cancel"],
        },
      ]);
      expect(confirms).toEqual([
        {
          prompt: "Update Worktrunk user worktree-path?",
          description: expect.stringContaining(
            FEATURE_WORKFLOW_RECOMMENDED_WORKTREE_PATH_TEMPLATE,
          ),
        },
      ]);
      expect(
        fs.readFileSync(
          getFeatureWorkflowWorktrunkUserConfigPath(userHomePath),
          "utf-8",
        ),
      ).toContain(
        `worktree-path = "${FEATURE_WORKFLOW_RECOMMENDED_WORKTREE_PATH_TEMPLATE}"`,
      );
      expect(notifications).toEqual([
        {
          message: "feature-setup complete: 6 file(s) updated",
          level: "info",
        },
      ]);
    } finally {
      if (typeof previousHome === "string") {
        process.env.HOME = previousHome;
      } else {
        delete process.env.HOME;
      }
    }
  });

  it("skips only the Worktrunk user config when interactive confirmation is declined", async () => {
    const repoRoot = createTempRepoWithMainBranch();
    const userHomePath = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-kit-feature-setup-decline-home-"),
    );
    tempDirs.push(userHomePath);
    const previousHome = process.env.HOME;
    process.env.HOME = userHomePath;

    try {
      const commands = new Map<
        string,
        (args: string, ctx: unknown) => Promise<void>
      >();
      const notifications: Array<{ message: string; level: string }> = [];

      extension({
        registerCommand(
          name: string,
          definition: {
            handler: (args: string, ctx: unknown) => Promise<void>;
          },
        ) {
          commands.set(name, definition.handler);
        },
        exec() {
          throw new Error("exec should not run during feature-setup");
        },
        on() {
          // no-op
        },
      } as unknown as ExtensionAPI);

      const handler = commands.get("feature-setup");
      expect(handler).toBeTypeOf("function");
      if (!handler) return;

      await handler("npm", {
        cwd: repoRoot,
        hasUI: true,
        ui: {
          async select(prompt: string) {
            if (prompt === "feature-setup scope:") {
              return "Apply all recommended files";
            }
            throw new Error(`Unexpected select prompt: ${prompt}`);
          },
          async confirm(prompt: string) {
            if (prompt === "Update Worktrunk user worktree-path?") {
              return false;
            }
            throw new Error(`Unexpected confirm prompt: ${prompt}`);
          },
          notify(message: string, level: string) {
            notifications.push({ message, level });
          },
        },
      });

      expect(
        fs.existsSync(getFeatureWorkflowWorktrunkUserConfigPath(userHomePath)),
      ).toBe(false);
      expect(fs.existsSync(path.join(repoRoot, ".config", "wt.toml"))).toBe(
        true,
      );
      expect(notifications).toEqual([
        {
          message: "feature-setup complete: 5 file(s) updated",
          level: "info",
        },
      ]);
    } finally {
      if (typeof previousHome === "string") {
        process.env.HOME = previousHome;
      } else {
        delete process.env.HOME;
      }
    }
  });

  it("switches feature branch discovered from wt list without managed registry", async () => {
    const repoRoot = createTempRepoWithMainBranch();
    const featureBranch = "fix-switch-no-managed-registry";
    const worktreePath = path.join(repoRoot, ".wt", featureBranch);

    fs.mkdirSync(path.join(repoRoot, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, ".pi", "third_extension_settings.json"),
      JSON.stringify(
        {
          featureWorkflow: {
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
      if (args[2] === "list") {
        return {
          code: 0,
          stdout: JSON.stringify([
            {
              branch: featureBranch,
              path: worktreePath,
              commit: { timestamp: 1 },
            },
          ]),
          stderr: "",
        };
      }

      if (args[2] === "switch") {
        return {
          code: 0,
          stdout: JSON.stringify({
            action: "switched",
            path: worktreePath,
          }),
          stderr: "",
        };
      }

      throw new Error(`Unexpected wt args: ${args.join(" ")}`);
    });

    extension({
      registerCommand(
        name: string,
        definition: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) {
        commands.set(name, definition.handler);
      },
      exec,
      on() {
        // no-op
      },
    } as unknown as ExtensionAPI);

    const handler = commands.get("feature-switch");
    expect(handler).toBeTypeOf("function");
    if (!handler) return;

    await expect(
      handler(featureBranch, {
        cwd: repoRoot,
        hasUI: false,
        ui: {
          notify(message: string, level: string) {
            notifications.push({ message, level });
          },
        },
        sessionManager: {
          getSessionFile() {
            return null;
          },
        },
        async switchSession() {
          return { cancelled: false };
        },
      }),
    ).resolves.toBeUndefined();

    expect(exec).toHaveBeenCalledTimes(2);
    expect(notifications).toEqual([
      {
        message: expect.stringContaining(`Worktree ready: ${featureBranch}`),
        level: "info",
      },
    ]);
  });

  it("shows a blocking working loader during /feature-switch in UI mode", async () => {
    const repoRoot = createTempRepoWithMainBranch();
    const featureBranch = "fix-loader-switch";
    const worktreePath = path.join(repoRoot, ".wt", featureBranch);

    fs.mkdirSync(path.join(repoRoot, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, ".pi", "third_extension_settings.json"),
      JSON.stringify(
        {
          featureWorkflow: {
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
    const loaderRenders: string[] = [];

    const exec = vi.fn(async (_command: string, args: string[]) => {
      if (args[2] === "list") {
        return {
          code: 0,
          stdout: JSON.stringify([
            {
              branch: featureBranch,
              path: worktreePath,
              commit: { timestamp: 1 },
            },
          ]),
          stderr: "",
        };
      }

      if (args[2] === "switch") {
        return {
          code: 0,
          stdout: JSON.stringify({
            action: "switched",
            path: worktreePath,
          }),
          stderr: "",
        };
      }

      throw new Error(`Unexpected wt args: ${args.join(" ")}`);
    });

    extension({
      registerCommand(
        name: string,
        definition: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) {
        commands.set(name, definition.handler);
      },
      exec,
      on() {
        // no-op
      },
    } as unknown as ExtensionAPI);

    const handler = commands.get("feature-switch");
    expect(handler).toBeTypeOf("function");
    if (!handler) return;

    await expect(
      handler(featureBranch, {
        cwd: repoRoot,
        hasUI: true,
        ui: {
          async custom(factory: LoaderFactory) {
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

              loaderRenders.push(component.render(80).join("\n"));
            });

            component?.dispose?.();
            return result;
          },
          notify(message: string, level: string) {
            notifications.push({ message, level });
          },
        },
        sessionManager: {
          getSessionFile() {
            return null;
          },
        },
        async switchSession() {
          return { cancelled: false };
        },
      }),
    ).resolves.toBeUndefined();

    expect(loaderRenders).toHaveLength(1);
    expect(loaderRenders[0]).toContain("Working...");
    expect(notifications).toEqual([
      {
        message: expect.stringContaining(`Worktree ready: ${featureBranch}`),
        level: "info",
      },
    ]);
  });

  it("closes the working loader before /feature-switch replaces the session", async () => {
    const initialCwd = process.cwd();
    const repoRoot = createTempRepoWithMainBranch();
    const featureBranch = "fix-loader-switch-replacement";
    const worktreePath = path.join(repoRoot, ".wt", featureBranch);
    const sessionManager = SessionManager.create(repoRoot);

    fs.mkdirSync(path.join(repoRoot, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, ".pi", "third_extension_settings.json"),
      JSON.stringify(
        {
          featureWorkflow: {
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
    const loaderRenders: string[] = [];
    const replacementNotifications: Array<{
      message: string;
      level: string;
    }> = [];
    let stale = false;

    const exec = vi.fn(async (_command: string, args: string[]) => {
      if (args[2] === "list") {
        return {
          code: 0,
          stdout: JSON.stringify([
            {
              branch: featureBranch,
              path: worktreePath,
              commit: { timestamp: 1 },
            },
          ]),
          stderr: "",
        };
      }

      if (args[2] === "switch") {
        fs.mkdirSync(worktreePath, { recursive: true });
        return {
          code: 0,
          stdout: JSON.stringify({
            action: "switched",
            path: worktreePath,
          }),
          stderr: "",
        };
      }

      throw new Error(`Unexpected wt args: ${args.join(" ")}`);
    });
    const switchSession = vi.fn(
      async (
        _sessionPath: string,
        options?: { withSession?: (ctx: unknown) => Promise<void> },
      ) => {
        stale = true;
        await options?.withSession?.({
          hasUI: false,
          ui: {
            notify(message: string, level: string) {
              replacementNotifications.push({ message, level });
            },
          },
        });
        return { cancelled: false };
      },
    );

    extension({
      registerCommand(
        name: string,
        definition: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) {
        commands.set(name, definition.handler);
      },
      exec,
      on() {
        // no-op
      },
    } as unknown as ExtensionAPI);

    const handler = commands.get("feature-switch");
    expect(handler).toBeTypeOf("function");
    if (!handler) return;

    try {
      await expect(
        handler(featureBranch, {
          cwd: repoRoot,
          hasUI: true,
          ui: {
            async custom(factory: LoaderFactory) {
              let component: LoaderComponent | undefined;

              const result = await new Promise<unknown>((resolve, reject) => {
                component = factory(
                  { requestRender() {} },
                  {
                    fg(_color: string, text: string) {
                      return text;
                    },
                  },
                  {},
                  (value: unknown) => {
                    if (stale) {
                      reject(
                        new Error(
                          "This extension instance is stale after session replacement or reload. Use the provided replacement-session context instead.",
                        ),
                      );
                      return;
                    }
                    resolve(value);
                  },
                );

                loaderRenders.push(component.render(80).join("\n"));
              });

              component?.dispose?.();
              return result;
            },
            notify() {
              if (stale) {
                throw new Error(
                  "This extension instance is stale after session replacement or reload. Use the provided replacement-session context instead.",
                );
              }
            },
          },
          sessionManager,
          switchSession,
        }),
      ).resolves.toBeUndefined();

      expect(loaderRenders).toHaveLength(1);
      expect(loaderRenders[0]).toContain("Working...");
      expect(switchSession).toHaveBeenCalledTimes(1);
      expect(replacementNotifications).toEqual([
        {
          message: expect.stringContaining(
            `Switched to feature worktree session: ${featureBranch}`,
          ),
          level: "info",
        },
      ]);
    } finally {
      process.chdir(initialCwd);
    }
  });

  it("switches a remote-only origin branch by bare query", async () => {
    const repoRoot = createTempRepoWithMainBranch();
    const resolvedRepoRoot = runGit(repoRoot, [
      "rev-parse",
      "--show-toplevel",
    ]).stdout.trim();
    const featureBranch = "kanban-v2";
    const worktreePath = path.join(repoRoot, ".wt", featureBranch);
    const headSha = runGit(repoRoot, ["rev-parse", "HEAD"]).stdout.trim();

    runGit(repoRoot, [
      "update-ref",
      `refs/remotes/origin/${featureBranch}`,
      headSha,
    ]);

    fs.mkdirSync(path.join(repoRoot, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, ".pi", "third_extension_settings.json"),
      JSON.stringify(
        {
          featureWorkflow: {
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
      if (args[2] === "list") {
        return {
          code: 0,
          stdout: JSON.stringify([]),
          stderr: "",
        };
      }

      if (args[2] === "switch") {
        return {
          code: 0,
          stdout: JSON.stringify({
            action: "switched",
            path: worktreePath,
          }),
          stderr: "",
        };
      }

      throw new Error(`Unexpected wt args: ${args.join(" ")}`);
    });

    extension({
      registerCommand(
        name: string,
        definition: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) {
        commands.set(name, definition.handler);
      },
      exec,
      on() {
        // no-op
      },
    } as unknown as ExtensionAPI);

    const handler = commands.get("feature-switch");
    expect(handler).toBeTypeOf("function");
    if (!handler) return;

    await expect(
      handler(featureBranch, {
        cwd: repoRoot,
        hasUI: false,
        ui: {
          notify(message: string, level: string) {
            notifications.push({ message, level });
          },
        },
        sessionManager: {
          getSessionFile() {
            return null;
          },
        },
        async switchSession() {
          return { cancelled: false };
        },
      }),
    ).resolves.toBeUndefined();

    expect(exec).toHaveBeenNthCalledWith(1, "wt", [
      "-C",
      resolvedRepoRoot,
      "list",
      "--format",
      "json",
    ]);
    expect(exec).toHaveBeenNthCalledWith(2, "wt", [
      "-C",
      resolvedRepoRoot,
      "switch",
      featureBranch,
      "--no-cd",
      "--yes",
    ]);
    expect(notifications).toEqual([
      {
        message: expect.stringContaining(`Worktree ready: ${featureBranch}`),
        level: "info",
      },
    ]);
  });

  it("shows remote-only origin branches in the /feature-switch picker", async () => {
    const repoRoot = createTempRepoWithMainBranch();
    const featureBranch = "kanban-v2";
    const existingBranch = "checkout-v2";
    const worktreePath = path.join(repoRoot, ".wt", featureBranch);
    const headSha = runGit(repoRoot, ["rev-parse", "HEAD"]).stdout.trim();

    runGit(repoRoot, [
      "update-ref",
      `refs/remotes/origin/${featureBranch}`,
      headSha,
    ]);

    fs.mkdirSync(path.join(repoRoot, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, ".pi", "third_extension_settings.json"),
      JSON.stringify(
        {
          featureWorkflow: {
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
    let selectOptions: string[] = [];

    const exec = vi.fn(async (_command: string, args: string[]) => {
      if (args[2] === "list") {
        return {
          code: 0,
          stdout: JSON.stringify([
            {
              branch: existingBranch,
              path: path.join(repoRoot, ".wt", existingBranch),
              commit: { timestamp: 1 },
            },
          ]),
          stderr: "",
        };
      }

      if (args[2] === "switch") {
        return {
          code: 0,
          stdout: JSON.stringify({
            action: "switched",
            path: worktreePath,
          }),
          stderr: "",
        };
      }

      throw new Error(`Unexpected wt args: ${args.join(" ")}`);
    });

    extension({
      registerCommand(
        name: string,
        definition: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) {
        commands.set(name, definition.handler);
      },
      exec,
      on() {
        // no-op
      },
    } as unknown as ExtensionAPI);

    const handler = commands.get("feature-switch");
    expect(handler).toBeTypeOf("function");
    if (!handler) return;

    await expect(
      handler("", {
        cwd: repoRoot,
        hasUI: true,
        ui: {
          async select(prompt: string, options: string[]) {
            expect(prompt).toBe("Switch to feature:");
            selectOptions = options;
            return `${featureBranch} (remote)`;
          },
          notify(message: string, level: string) {
            notifications.push({ message, level });
          },
        },
        sessionManager: {
          getSessionFile() {
            return null;
          },
        },
        async switchSession() {
          return { cancelled: false };
        },
      }),
    ).resolves.toBeUndefined();

    expect(selectOptions).toEqual([
      existingBranch,
      `${featureBranch} (remote)`,
    ]);
    expect(exec.mock.calls.some((call) => call[1][2] === "switch")).toBe(true);
    expect(notifications).toEqual([
      {
        message: expect.stringContaining(`Worktree ready: ${featureBranch}`),
        level: "info",
      },
    ]);
  });

  it("aligns process cwd when /feature-switch auto-switches sessions", async () => {
    const initialCwd = process.cwd();
    const repoRoot = createTempRepoWithMainBranch();
    const featureBranch = "fix-switch-process-cwd";
    const worktreePath = path.join(repoRoot, ".wt", featureBranch);
    const sessionManager = SessionManager.create(repoRoot);

    fs.mkdirSync(path.join(repoRoot, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, ".pi", "third_extension_settings.json"),
      JSON.stringify(
        {
          featureWorkflow: {
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
    const exec = vi.fn(async (_command: string, args: string[]) => {
      if (args[2] === "list") {
        return {
          code: 0,
          stdout: JSON.stringify([
            {
              branch: featureBranch,
              path: worktreePath,
              commit: { timestamp: 1 },
            },
          ]),
          stderr: "",
        };
      }

      if (args[2] === "switch") {
        fs.mkdirSync(worktreePath, { recursive: true });
        return {
          code: 0,
          stdout: JSON.stringify({
            action: "switched",
            path: worktreePath,
          }),
          stderr: "",
        };
      }

      throw new Error(`Unexpected wt args: ${args.join(" ")}`);
    });
    const switchSession = vi.fn(
      async (
        _sessionPath: string,
        options?: { withSession?: (ctx: unknown) => Promise<void> },
      ) => {
        await options?.withSession?.({
          hasUI: false,
          ui: {
            notify() {
              // no-op
            },
          },
        });
        return { cancelled: false };
      },
    );

    extension({
      registerCommand(
        name: string,
        definition: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) {
        commands.set(name, definition.handler);
      },
      exec,
      on() {
        // no-op
      },
    } as unknown as ExtensionAPI);

    const handler = commands.get("feature-switch");
    expect(handler).toBeTypeOf("function");
    if (!handler) return;

    process.chdir(repoRoot);

    try {
      await expect(
        handler(featureBranch, {
          cwd: repoRoot,
          hasUI: false,
          ui: {
            notify() {
              // no-op
            },
          },
          sessionManager,
          switchSession,
        }),
      ).resolves.toBeUndefined();

      expect(switchSession).toHaveBeenCalledTimes(1);
      expect(fs.realpathSync(process.cwd())).toBe(
        fs.realpathSync(worktreePath),
      );
    } finally {
      process.chdir(initialCwd);
    }
  });

  it("uses the replacement session context for post-switch /feature-switch notifications", async () => {
    const repoRoot = createTempRepoWithMainBranch();
    const featureBranch = "fix-switch-replacement-notify";
    const worktreePath = path.join(repoRoot, ".wt", featureBranch);
    const sessionManager = SessionManager.create(repoRoot);

    fs.mkdirSync(path.join(repoRoot, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, ".pi", "third_extension_settings.json"),
      JSON.stringify(
        {
          featureWorkflow: {
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
    const replacementNotifications: Array<{
      message: string;
      level: string;
    }> = [];
    let stale = false;

    const exec = vi.fn(async (_command: string, args: string[]) => {
      if (args[2] === "list") {
        return {
          code: 0,
          stdout: JSON.stringify([
            {
              branch: featureBranch,
              path: worktreePath,
              commit: { timestamp: 1 },
            },
          ]),
          stderr: "",
        };
      }

      if (args[2] === "switch") {
        fs.mkdirSync(worktreePath, { recursive: true });
        return {
          code: 0,
          stdout: JSON.stringify({
            action: "switched",
            path: worktreePath,
          }),
          stderr: "",
        };
      }

      throw new Error(`Unexpected wt args: ${args.join(" ")}`);
    });
    const switchSession = vi.fn(
      async (
        _sessionPath: string,
        options?: { withSession?: (ctx: unknown) => Promise<void> },
      ) => {
        stale = true;
        await options?.withSession?.({
          hasUI: false,
          ui: {
            notify(message: string, level: string) {
              replacementNotifications.push({ message, level });
            },
          },
        });
        return { cancelled: false };
      },
    );

    extension({
      registerCommand(
        name: string,
        definition: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) {
        commands.set(name, definition.handler);
      },
      exec,
      on() {
        // no-op
      },
    } as unknown as ExtensionAPI);

    const handler = commands.get("feature-switch");
    expect(handler).toBeTypeOf("function");
    if (!handler) return;

    await expect(
      handler(featureBranch, {
        cwd: repoRoot,
        hasUI: false,
        ui: {
          notify() {
            if (stale) {
              throw new Error(
                "This extension instance is stale after session replacement or reload. Use the provided replacement-session context instead.",
              );
            }
          },
        },
        sessionManager,
        switchSession,
      }),
    ).resolves.toBeUndefined();

    expect(switchSession).toHaveBeenCalledTimes(1);
    expect(replacementNotifications).toEqual([
      {
        message: expect.stringContaining(
          `Switched to feature worktree session: ${featureBranch}`,
        ),
        level: "info",
      },
    ]);
  });

  it("uses the replacement session context for post-switch /feature-start work", async () => {
    const repoRoot = createTempRepoWithMainBranch();
    const featureBranch = "fix-start-replacement-notify";
    const worktreePath = path.join(repoRoot, ".wt", featureBranch);
    const sessionManager = SessionManager.create(repoRoot);

    fs.mkdirSync(path.join(repoRoot, ".config"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, ".config", "wt.toml"), "", "utf-8");
    fs.mkdirSync(path.join(repoRoot, ".pi"), { recursive: true });
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
              enabled: true,
              mode: "quick",
              ensureOn: ["feature-start", "feature-switch"],
              rules: [
                {
                  path: "node_modules",
                  strategy: "copy",
                  required: false,
                  onMissing: {
                    action: "copy-ignored",
                    hook: null,
                  },
                },
              ],
              lockfile: {
                enabled: false,
                path: "package-lock.json",
                compareWithPrimary: true,
                onDrift: "warn",
              },
              fallback: {
                copyIgnoredTimeoutMs: 15000,
                onFailure: "warn",
              },
              notifications: {
                enabled: true,
                verbose: false,
              },
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
    const replacementNotifications: Array<{
      message: string;
      level: string;
    }> = [];
    let stale = false;

    const exec = vi.fn(async (_command: string, args: string[]) => {
      if (args.includes("switch") && args.includes("--create")) {
        fs.mkdirSync(worktreePath, { recursive: true });
        return {
          code: 0,
          stdout: JSON.stringify({ action: "created", path: worktreePath }),
          stderr: "",
        };
      }

      if (args[2] === "step" && args[3] === "copy-ignored") {
        return {
          code: 0,
          stdout: "",
          stderr: "",
        };
      }

      throw new Error(`Unexpected wt args: ${args.join(" ")}`);
    });
    const switchSession = vi.fn(
      async (
        _sessionPath: string,
        options?: { withSession?: (ctx: unknown) => Promise<void> },
      ) => {
        stale = true;
        await options?.withSession?.({
          hasUI: false,
          ui: {
            notify(message: string, level: string) {
              replacementNotifications.push({ message, level });
            },
          },
        });
        return { cancelled: false };
      },
    );

    extension({
      registerCommand(
        name: string,
        definition: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) {
        commands.set(name, definition.handler);
      },
      exec,
      on() {
        // no-op
      },
    } as unknown as ExtensionAPI);

    const handler = commands.get("feature-start");
    expect(handler).toBeTypeOf("function");
    if (!handler) return;

    await expect(
      handler("", {
        cwd: repoRoot,
        hasUI: true,
        ui: {
          async input(prompt: string) {
            if (prompt === "Branch slug:") {
              return featureBranch;
            }
            throw new Error(`Unexpected input prompt: ${prompt}`);
          },
          async select(prompt: string) {
            if (prompt === "Base branch:") {
              return "main";
            }
            throw new Error(`Unexpected select prompt: ${prompt}`);
          },
          notify() {
            if (stale) {
              throw new Error(
                "This extension instance is stale after session replacement or reload. Use the provided replacement-session context instead.",
              );
            }
          },
        },
        sessionManager,
        switchSession,
      }),
    ).resolves.toBeUndefined();

    expect(switchSession).toHaveBeenCalledTimes(1);
    expect(replacementNotifications).toEqual([
      {
        message:
          "Ignored sync: triggered 1 fallback action(s): wt step copy-ignored.",
        level: "info",
      },
      {
        message: "Ignored sync unresolved path(s): node_modules (missing)",
        level: "info",
      },
      {
        message: `Switched to feature worktree session: ${featureBranch}`,
        level: "info",
      },
    ]);
  });

  it("blocks /feature-start session switch in strict ignored-sync mode", async () => {
    const repoRoot = createTempRepoWithMainBranch();
    fs.mkdirSync(path.join(repoRoot, ".config"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, ".config", "wt.toml"), "", "utf-8");
    fs.mkdirSync(path.join(repoRoot, ".pi"), { recursive: true });
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
              enabled: true,
              mode: "strict",
              ensureOn: ["feature-start", "feature-switch"],
              rules: [
                {
                  path: "node_modules",
                  strategy: "symlink",
                  required: true,
                  onMissing: {
                    action: "run-hook",
                    hook: "project-deps-link",
                  },
                },
              ],
              lockfile: {
                enabled: false,
                path: "package-lock.json",
                compareWithPrimary: true,
                onDrift: "warn",
              },
              fallback: {
                copyIgnoredTimeoutMs: 15000,
                onFailure: "block",
              },
              notifications: {
                enabled: true,
                verbose: false,
              },
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const worktreePath = path.join(repoRoot, ".wt", "fix-strict-start-block");
    const commands = new Map<
      string,
      (args: string, ctx: unknown) => Promise<void>
    >();
    const notifications: Array<{ message: string; level: string }> = [];
    const switchSession = vi.fn(async () => ({ cancelled: false }));

    const exec = vi.fn(async (_command: string, args: string[]) => {
      if (args.includes("switch") && args.includes("--create")) {
        fs.mkdirSync(worktreePath, { recursive: true });
        return {
          code: 0,
          stdout: JSON.stringify({ action: "created", path: worktreePath }),
          stderr: "",
        };
      }

      if (args[2] === "hook") {
        return {
          code: 1,
          stdout: "",
          stderr: "hook failed",
        };
      }

      throw new Error(`Unexpected wt args: ${args.join(" ")}`);
    });

    extension({
      registerCommand(
        name: string,
        definition: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) {
        commands.set(name, definition.handler);
      },
      exec,
      on() {
        // no-op
      },
    } as unknown as ExtensionAPI);

    const handler = commands.get("feature-start");
    expect(handler).toBeTypeOf("function");
    if (!handler) return;

    await handler("", {
      cwd: repoRoot,
      hasUI: true,
      ui: {
        async input(prompt: string) {
          if (prompt === "Branch slug:") {
            return "fix-strict-start-block";
          }
          throw new Error(`Unexpected input prompt: ${prompt}`);
        },
        async select(prompt: string) {
          if (prompt === "Base branch:") {
            return "main";
          }
          throw new Error(`Unexpected select prompt: ${prompt}`);
        },
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
      sessionManager: {
        getSessionFile() {
          return path.join(repoRoot, ".pi", "session.json");
        },
      },
      switchSession,
    });

    expect(exec.mock.calls.some((call) => call[1][2] === "hook")).toBe(true);
    expect(switchSession).not.toHaveBeenCalled();
    expect(notifications).toContainEqual({
      message:
        "Ignored sync blocked session switch because required paths are not ready.",
      level: "error",
    });
  });

  it("blocks /feature-switch session switch in strict ignored-sync mode", async () => {
    const repoRoot = createTempRepoWithMainBranch();
    const featureBranch = "fix-switch-strict-block";
    const worktreePath = path.join(repoRoot, ".wt", featureBranch);

    fs.mkdirSync(path.join(repoRoot, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, ".pi", "third_extension_settings.json"),
      JSON.stringify(
        {
          featureWorkflow: {
            defaults: {
              autoSwitchToWorktreeSession: true,
            },
            ignoredSync: {
              enabled: true,
              mode: "strict",
              ensureOn: ["feature-start", "feature-switch"],
              rules: [
                {
                  path: "node_modules",
                  strategy: "symlink",
                  required: true,
                  onMissing: {
                    action: "run-hook",
                    hook: "project-deps-link",
                  },
                },
              ],
              lockfile: {
                enabled: false,
                path: "package-lock.json",
                compareWithPrimary: true,
                onDrift: "warn",
              },
              fallback: {
                copyIgnoredTimeoutMs: 15000,
                onFailure: "block",
              },
              notifications: {
                enabled: true,
                verbose: false,
              },
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
    const switchSession = vi.fn(async () => ({ cancelled: false }));

    const exec = vi.fn(async (_command: string, args: string[]) => {
      if (args[2] === "list") {
        return {
          code: 0,
          stdout: JSON.stringify([
            {
              branch: featureBranch,
              path: worktreePath,
              commit: { timestamp: 1 },
            },
          ]),
          stderr: "",
        };
      }

      if (args[2] === "switch") {
        return {
          code: 0,
          stdout: JSON.stringify({
            action: "switched",
            path: worktreePath,
          }),
          stderr: "",
        };
      }

      if (args[2] === "hook") {
        return {
          code: 1,
          stdout: "",
          stderr: "hook failed",
        };
      }

      throw new Error(`Unexpected wt args: ${args.join(" ")}`);
    });

    extension({
      registerCommand(
        name: string,
        definition: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) {
        commands.set(name, definition.handler);
      },
      exec,
      on() {
        // no-op
      },
    } as unknown as ExtensionAPI);

    const handler = commands.get("feature-switch");
    expect(handler).toBeTypeOf("function");
    if (!handler) return;

    await handler(featureBranch, {
      cwd: repoRoot,
      hasUI: false,
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
      sessionManager: {
        getSessionFile() {
          return path.join(repoRoot, ".pi", "session.json");
        },
      },
      switchSession,
    });

    expect(exec.mock.calls.some((call) => call[1][2] === "hook")).toBe(true);
    expect(switchSession).not.toHaveBeenCalled();
    expect(
      notifications.some(
        (entry) => entry.message === `Worktree ready: ${featureBranch}`,
      ),
    ).toBe(false);
    expect(notifications).toContainEqual({
      message:
        "Ignored sync blocked session switch because required paths are not ready.",
      level: "error",
    });
  });

  it("runs quick ignored-sync after /feature-start", async () => {
    const repoRoot = createTempRepoWithMainBranch();
    fs.mkdirSync(path.join(repoRoot, ".config"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, ".config", "wt.toml"), "", "utf-8");
    fs.mkdirSync(path.join(repoRoot, ".pi"), { recursive: true });
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
              enabled: true,
              mode: "quick",
              ensureOn: ["feature-start", "feature-switch"],
              rules: [
                {
                  path: "node_modules",
                  strategy: "copy",
                  required: false,
                  onMissing: {
                    action: "copy-ignored",
                    hook: null,
                  },
                },
              ],
              lockfile: {
                enabled: false,
                path: "package-lock.json",
                compareWithPrimary: true,
                onDrift: "warn",
              },
              fallback: {
                copyIgnoredTimeoutMs: 15000,
                onFailure: "warn",
              },
              notifications: {
                enabled: true,
                verbose: false,
              },
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const worktreePath = path.join(repoRoot, ".wt", "fix-start-quick-sync");
    const commands = new Map<
      string,
      (args: string, ctx: unknown) => Promise<void>
    >();

    const exec = vi.fn(async (_command: string, args: string[]) => {
      if (args.includes("switch") && args.includes("--create")) {
        fs.mkdirSync(worktreePath, { recursive: true });
        return {
          code: 0,
          stdout: JSON.stringify({ action: "created", path: worktreePath }),
          stderr: "",
        };
      }

      if (args[2] === "step" && args[3] === "copy-ignored") {
        return {
          code: 0,
          stdout: "",
          stderr: "",
        };
      }

      throw new Error(`Unexpected wt args: ${args.join(" ")}`);
    });

    extension({
      registerCommand(
        name: string,
        definition: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) {
        commands.set(name, definition.handler);
      },
      exec,
      on() {
        // no-op
      },
    } as unknown as ExtensionAPI);

    const handler = commands.get("feature-start");
    expect(handler).toBeTypeOf("function");
    if (!handler) return;

    await handler("", {
      cwd: repoRoot,
      hasUI: true,
      ui: {
        async input(prompt: string) {
          if (prompt === "Branch slug:") {
            return "fix-start-quick-sync";
          }
          throw new Error(`Unexpected input prompt: ${prompt}`);
        },
        async select(prompt: string) {
          if (prompt === "Base branch:") {
            return "main";
          }
          throw new Error(`Unexpected select prompt: ${prompt}`);
        },
        notify() {
          // ignore
        },
      },
      sessionManager: {
        getSessionFile() {
          return null;
        },
      },
      async switchSession() {
        return { cancelled: false };
      },
    });

    expect(
      exec.mock.calls.some(
        (call) => call[1][2] === "step" && call[1][3] === "copy-ignored",
      ),
    ).toBe(true);
  });

  it("auto-applies the Worktrunk user config in --yes mode without prompting", async () => {
    const repoRoot = createTempRepoWithMainBranch();
    const userHomePath = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-kit-feature-setup-yes-home-"),
    );
    tempDirs.push(userHomePath);
    const previousHome = process.env.HOME;
    process.env.HOME = userHomePath;

    try {
      const commands = new Map<
        string,
        (args: string, ctx: unknown) => Promise<void>
      >();
      const notifications: Array<{ message: string; level: string }> = [];

      extension({
        registerCommand(
          name: string,
          definition: {
            handler: (args: string, ctx: unknown) => Promise<void>;
          },
        ) {
          commands.set(name, definition.handler);
        },
        exec() {
          throw new Error("exec should not run during feature-setup");
        },
        on() {
          // no-op
        },
      } as unknown as ExtensionAPI);

      const handler = commands.get("feature-setup");
      expect(handler).toBeTypeOf("function");
      if (!handler) return;

      await handler("npm --yes", {
        cwd: repoRoot,
        hasUI: true,
        ui: {
          async select(prompt: string) {
            throw new Error(`Unexpected select prompt: ${prompt}`);
          },
          async confirm(prompt: string) {
            throw new Error(`Unexpected confirm prompt: ${prompt}`);
          },
          notify(message: string, level: string) {
            notifications.push({ message, level });
          },
        },
      });

      expect(
        fs.readFileSync(
          getFeatureWorkflowWorktrunkUserConfigPath(userHomePath),
          "utf-8",
        ),
      ).toContain(
        `worktree-path = "${FEATURE_WORKFLOW_RECOMMENDED_WORKTREE_PATH_TEMPLATE}"`,
      );
      expect(notifications).toEqual([
        {
          message: "feature-setup complete: 6 file(s) updated",
          level: "info",
        },
      ]);
    } finally {
      if (typeof previousHome === "string") {
        process.env.HOME = previousHome;
      } else {
        delete process.env.HOME;
      }
    }
  });

  it("prunes integrated and empty worktrees after confirmation", async () => {
    const repoRoot = createTempRepoWithMainBranch();
    const resolvedRepoRoot = runGit(repoRoot, [
      "rev-parse",
      "--show-toplevel",
    ]).stdout.trim();

    const commands = new Map<
      string,
      (args: string, ctx: unknown) => Promise<void>
    >();
    const notifications: Array<{ message: string; level: string }> = [];
    const confirmCalls: Array<{ prompt: string; description: string }> = [];

    const wtListJson = JSON.stringify([
      {
        branch: "master",
        path: "/repo",
        is_main: true,
        main_state: "is_main",
      },
      {
        branch: "feat/integrated",
        path: "/repo.feat-integrated",
        is_main: false,
        main_state: "integrated",
      },
      {
        branch: "feat/empty",
        path: "/repo.feat-empty",
        is_main: false,
        main_state: "empty",
      },
      {
        branch: "feat/diverged",
        path: "/repo.feat-diverged",
        is_main: false,
        main_state: "diverged",
      },
    ]);

    const exec = vi.fn(async (_command: string, args: string[]) => {
      if (args[2] === "list") {
        return { code: 0, stdout: wtListJson, stderr: "" };
      }

      if (args[2] === "remove" && args[3] === "feat/integrated") {
        return { code: 0, stdout: "{}", stderr: "" };
      }

      if (args[2] === "remove" && args[3] === "feat/empty") {
        return { code: 0, stdout: "{}", stderr: "" };
      }

      throw new Error(`Unexpected wt args: ${args.join(" ")}`);
    });

    extension({
      registerCommand(
        name: string,
        definition: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) {
        commands.set(name, definition.handler);
      },
      exec,
      on() {
        // no-op
      },
    } as unknown as ExtensionAPI);

    const handler = commands.get("feature-prune-merged");
    expect(handler).toBeTypeOf("function");
    if (!handler) return;

    await handler("", {
      cwd: repoRoot,
      hasUI: true,
      ui: {
        async confirm(prompt: string, description: string) {
          confirmCalls.push({ prompt, description });
          return true;
        },
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    });

    expect(confirmCalls).toEqual([
      {
        prompt: "Delete 2 merged worktree(s)?",
        description: expect.stringContaining("feat/integrated"),
      },
    ]);

    expect(exec).toHaveBeenNthCalledWith(1, "wt", [
      "-C",
      resolvedRepoRoot,
      "list",
      "--format",
      "json",
    ]);
    expect(exec).toHaveBeenNthCalledWith(2, "wt", [
      "-C",
      resolvedRepoRoot,
      "remove",
      "feat/integrated",
      "--yes",
      "--foreground",
    ]);
    expect(exec).toHaveBeenNthCalledWith(3, "wt", [
      "-C",
      resolvedRepoRoot,
      "remove",
      "feat/empty",
      "--yes",
      "--foreground",
    ]);

    expect(
      notifications.some((item) =>
        item.message.includes("feature-prune-merged: removed 2/2 worktree(s)"),
      ),
    ).toBe(true);
  });

  it("continues pruning when auto-fetch fails", async () => {
    const repoRoot = createTempRepoWithMainBranch();
    runGit(repoRoot, [
      "remote",
      "add",
      "origin",
      "/tmp/pi-kit-missing-remote-do-not-create",
    ]);
    const resolvedRepoRoot = runGit(repoRoot, [
      "rev-parse",
      "--show-toplevel",
    ]).stdout.trim();

    const commands = new Map<
      string,
      (args: string, ctx: unknown) => Promise<void>
    >();
    const notifications: Array<{ message: string; level: string }> = [];

    const exec = vi.fn(async (_command: string, args: string[]) => {
      if (args[2] === "list") {
        return {
          code: 0,
          stdout: JSON.stringify([
            {
              branch: "feat/integrated",
              path: "/repo.feat-integrated",
              is_main: false,
              main_state: "integrated",
            },
          ]),
          stderr: "",
        };
      }

      if (args[2] === "remove" && args[3] === "feat/integrated") {
        return { code: 0, stdout: "{}", stderr: "" };
      }

      throw new Error(`Unexpected wt args: ${args.join(" ")}`);
    });

    extension({
      registerCommand(
        name: string,
        definition: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) {
        commands.set(name, definition.handler);
      },
      exec,
      on() {
        // no-op
      },
    } as unknown as ExtensionAPI);

    const handler = commands.get("feature-prune-merged");
    expect(handler).toBeTypeOf("function");
    if (!handler) return;

    await handler("--yes", {
      cwd: repoRoot,
      hasUI: true,
      ui: {
        async confirm(prompt: string) {
          throw new Error(`confirm should not run: ${prompt}`);
        },
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    });

    expect(exec).toHaveBeenNthCalledWith(1, "wt", [
      "-C",
      resolvedRepoRoot,
      "list",
      "--format",
      "json",
    ]);
    expect(exec).toHaveBeenNthCalledWith(2, "wt", [
      "-C",
      resolvedRepoRoot,
      "remove",
      "feat/integrated",
      "--yes",
      "--foreground",
    ]);
    expect(
      notifications.some(
        (item) =>
          item.level === "warning" &&
          item.message.includes("git fetch --all --prune failed"),
      ),
    ).toBe(true);
  });

  it("does not prune when confirmation is declined", async () => {
    const repoRoot = createTempRepoWithMainBranch();
    const resolvedRepoRoot = runGit(repoRoot, [
      "rev-parse",
      "--show-toplevel",
    ]).stdout.trim();

    const commands = new Map<
      string,
      (args: string, ctx: unknown) => Promise<void>
    >();
    const notifications: Array<{ message: string; level: string }> = [];

    const exec = vi.fn(async (_command: string, args: string[]) => {
      if (args[2] === "list") {
        return {
          code: 0,
          stdout: JSON.stringify([
            {
              branch: "feat/integrated",
              path: "/repo.feat-integrated",
              is_main: false,
              main_state: "integrated",
            },
          ]),
          stderr: "",
        };
      }

      throw new Error(`Unexpected wt args: ${args.join(" ")}`);
    });

    extension({
      registerCommand(
        name: string,
        definition: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) {
        commands.set(name, definition.handler);
      },
      exec,
      on() {
        // no-op
      },
    } as unknown as ExtensionAPI);

    const handler = commands.get("feature-prune-merged");
    expect(handler).toBeTypeOf("function");
    if (!handler) return;

    await handler("", {
      cwd: repoRoot,
      hasUI: true,
      ui: {
        async confirm() {
          return false;
        },
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    });

    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith("wt", [
      "-C",
      resolvedRepoRoot,
      "list",
      "--format",
      "json",
    ]);
    expect(
      notifications.some((item) => item.message.includes("Cancelled")),
    ).toBe(true);
  });

  it("skips confirmation in --yes mode when pruning merged worktrees", async () => {
    const repoRoot = createTempRepoWithMainBranch();
    const resolvedRepoRoot = runGit(repoRoot, [
      "rev-parse",
      "--show-toplevel",
    ]).stdout.trim();

    const commands = new Map<
      string,
      (args: string, ctx: unknown) => Promise<void>
    >();

    const exec = vi.fn(async (_command: string, args: string[]) => {
      if (args[2] === "list") {
        return {
          code: 0,
          stdout: JSON.stringify([
            {
              branch: "feat/integrated",
              path: "/repo.feat-integrated",
              is_main: false,
              main_state: "integrated",
            },
          ]),
          stderr: "",
        };
      }

      if (args[2] === "remove" && args[3] === "feat/integrated") {
        return { code: 0, stdout: "{}", stderr: "" };
      }

      throw new Error(`Unexpected wt args: ${args.join(" ")}`);
    });

    extension({
      registerCommand(
        name: string,
        definition: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) {
        commands.set(name, definition.handler);
      },
      exec,
      on() {
        // no-op
      },
    } as unknown as ExtensionAPI);

    const handler = commands.get("feature-prune-merged");
    expect(handler).toBeTypeOf("function");
    if (!handler) return;

    await handler("--yes", {
      cwd: repoRoot,
      hasUI: true,
      ui: {
        async confirm(prompt: string) {
          throw new Error(`confirm should not run: ${prompt}`);
        },
        notify() {
          // no-op
        },
      },
    });

    expect(exec).toHaveBeenNthCalledWith(1, "wt", [
      "-C",
      resolvedRepoRoot,
      "list",
      "--format",
      "json",
    ]);
    expect(exec).toHaveBeenNthCalledWith(2, "wt", [
      "-C",
      resolvedRepoRoot,
      "remove",
      "feat/integrated",
      "--yes",
      "--foreground",
    ]);
  });

  it("reports when no merged worktrees are found", async () => {
    const repoRoot = createTempRepoWithMainBranch();

    const commands = new Map<
      string,
      (args: string, ctx: unknown) => Promise<void>
    >();
    const notifications: Array<{ message: string; level: string }> = [];

    const exec = vi.fn(async (_command: string, args: string[]) => {
      if (args[2] === "list") {
        return {
          code: 0,
          stdout: JSON.stringify([
            {
              branch: "master",
              path: "/repo",
              is_main: true,
              main_state: "is_main",
            },
            {
              branch: "feat/diverged",
              path: "/repo.feat-diverged",
              is_main: false,
              main_state: "diverged",
            },
          ]),
          stderr: "",
        };
      }

      throw new Error(`Unexpected wt args: ${args.join(" ")}`);
    });

    extension({
      registerCommand(
        name: string,
        definition: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) {
        commands.set(name, definition.handler);
      },
      exec,
      on() {
        // no-op
      },
    } as unknown as ExtensionAPI);

    const handler = commands.get("feature-prune-merged");
    expect(handler).toBeTypeOf("function");
    if (!handler) return;

    await handler("", {
      cwd: repoRoot,
      hasUI: true,
      ui: {
        async confirm() {
          throw new Error(
            "confirm should not run when there are no candidates",
          );
        },
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    });

    expect(exec).toHaveBeenCalledTimes(1);
    expect(
      notifications.some((item) =>
        item.message.includes("No merged worktrees to prune"),
      ),
    ).toBe(true);
  });
});
