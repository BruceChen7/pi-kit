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

  it("creates a managed flat feature branch from slug + base prompts", async () => {
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
    const worktreePath = path.join(repoRoot, ".wt", "checkout-v2");
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
            return "checkout-v2";
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
    expect(exec).toHaveBeenCalledTimes(2);
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
      "--create",
      "checkout-v2",
      "--base",
      "main",
      "--no-cd",
      "--yes",
    ]);
    expect(notifications).toEqual([
      {
        message: "Creating worktree for checkout-v2…",
        level: "info",
      },
      {
        message: "Feature worktree created: checkout-v2",
        level: "info",
      },
    ]);
    expect(readManagedFeatureRegistry(repoRoot)).toEqual([
      {
        branch: "checkout-v2",
        slug: "checkout-v2",
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      },
    ]);
    expect(fs.existsSync(getManagedFeatureRegistryPath(repoRoot))).toBe(true);
  });
});
