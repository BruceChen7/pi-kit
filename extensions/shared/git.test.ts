import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  branchExists,
  createRepoGitRunner,
  getCurrentBranchName,
  listDirtyPaths,
  listLocalBranches,
} from "./git.js";

const tempDirs: string[] = [];

const registerTempDir = (dir: string): string => {
  tempDirs.push(dir);
  return dir;
};

const createTempDir = (prefix: string): string =>
  registerTempDir(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("createRepoGitRunner", () => {
  it("runs git commands in the provided repo root", () => {
    const repoRoot = createTempDir("pi-kit-shared-git-");
    const initResult = spawnSync("git", ["init"], {
      cwd: repoRoot,
      encoding: "utf-8",
    });
    expect(initResult.status).toBe(0);

    const runGit = createRepoGitRunner(repoRoot, 5000);
    const result = runGit(["rev-parse", "--is-inside-work-tree"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("true");
  });
});

describe("branch helpers", () => {
  it("returns current branch name and trims output", () => {
    const run = vi.fn(() => ({
      exitCode: 0,
      stdout: "  main  \n",
      stderr: "",
    }));

    expect(getCurrentBranchName(run)).toBe("main");
  });

  it("returns null when current branch command fails", () => {
    const run = () => ({ exitCode: 1, stdout: "", stderr: "boom" });
    expect(getCurrentBranchName(run)).toBeNull();
  });

  it("lists local branches as trimmed non-empty lines", () => {
    const run = () => ({
      exitCode: 0,
      stdout: "main\n  feature/a \n\nrelease\n",
      stderr: "",
    });

    expect(listLocalBranches(run)).toEqual(["main", "feature/a", "release"]);
  });

  it("returns empty list when branch listing fails", () => {
    const run = () => ({ exitCode: 128, stdout: "", stderr: "fail" });
    expect(listLocalBranches(run)).toEqual([]);
  });

  it("checks local branch ref existence via show-ref", () => {
    const run = vi.fn(() => ({ exitCode: 0, stdout: "", stderr: "" }));

    expect(branchExists(run, "feature/main/test")).toBe(true);
    expect(run).toHaveBeenCalledWith([
      "show-ref",
      "--verify",
      "--quiet",
      "refs/heads/feature/main/test",
    ]);
  });
});

describe("listDirtyPaths", () => {
  it("parses normal modified and untracked entries", () => {
    expect(listDirtyPaths(" M package.json\n?? .config/wt.toml\n")).toEqual([
      "package.json",
      ".config/wt.toml",
    ]);
  });

  it("returns renamed target path", () => {
    expect(listDirtyPaths("R  old-name.ts -> new-name.ts\n")).toEqual([
      "new-name.ts",
    ]);
  });

  it("parses quoted paths from porcelain output", () => {
    expect(listDirtyPaths('?? "dir with space/file name.ts"\n')).toEqual([
      "dir with space/file name.ts",
    ]);
  });
});
