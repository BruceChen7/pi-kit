import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";

import { clearSettingsCache } from "../shared/settings.js";
import { preflightFeatureStart } from "./start-feature.js";

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

const createTempRepoWithMainBranch = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-feature-start-"));
  tempDirs.push(dir);
  runGit(dir, ["init"]);
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

it("warns but continues when .worktreeinclude is missing for copy-ignored setup", () => {
  const repoRoot = createTempRepoWithMainBranch();
  fs.mkdirSync(path.join(repoRoot, ".config"), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, ".config", "wt.toml"),
    ["[post-start]", 'copy = "wt step copy-ignored"', ""].join("\n"),
    "utf-8",
  );
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
  runGit(repoRoot, [
    "add",
    ".config/wt.toml",
    ".pi/third_extension_settings.json",
  ]);
  runGit(repoRoot, ["commit", "-m", "setup"]);

  const notifications: Array<{ message: string; level: string }> = [];
  const exec = vi.fn();

  const prepared = preflightFeatureStart({
    pi: {
      exec,
    } as unknown as ExtensionAPI,
    ctx: {
      cwd: repoRoot,
      hasUI: false,
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    } as ExtensionCommandContext,
  });

  expect(prepared).not.toBeNull();
  expect(notifications).toEqual([
    {
      message:
        "feature-start: .worktreeinclude is missing, so 'wt step copy-ignored' will copy all gitignored files. Run /feature-setup --only=worktreeinclude to recreate the local whitelist.",
      level: "warning",
    },
  ]);
  expect(exec).not.toHaveBeenCalled();
});
