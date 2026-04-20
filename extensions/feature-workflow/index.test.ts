import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { clearSettingsCache } from "../shared/settings.js";
import extension from "./index.js";
import {
  getManagedFeatureRegistryPath,
  readManagedFeatureRegistry,
} from "./registry.js";
import {
  FEATURE_WORKFLOW_RECOMMENDED_WORKTREE_PATH_TEMPLATE,
  getFeatureWorkflowWorktrunkUserConfigPath,
} from "./setup.js";

const tempDirs: string[] = [];

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

  it("creates a managed slug-only feature branch from the selected slug", async () => {
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
        message: "Creating worktree for fix-annotate-auto-last…",
        level: "info",
      },
      {
        message: "Feature worktree created: fix-annotate-auto-last",
        level: "info",
      },
    ]);
    expect(readManagedFeatureRegistry(repoRoot)).toEqual([
      {
        branch: "fix-annotate-auto-last",
        slug: "fix-annotate-auto-last",
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      },
    ]);
    expect(fs.existsSync(getManagedFeatureRegistryPath(repoRoot))).toBe(true);
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
});
