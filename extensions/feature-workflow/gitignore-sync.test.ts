import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { syncGitignoreToWorktree } from "./gitignore-sync.js";

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

describe("syncGitignoreToWorktree", () => {
  it("copies .gitignore when target worktree differs", () => {
    const repoRoot = createTempDir("pi-kit-feature-gitignore-source-");
    const worktreePath = createTempDir("pi-kit-feature-gitignore-target-");

    fs.writeFileSync(
      path.join(repoRoot, ".gitignore"),
      "node_modules/\n.pi/\n",
    );

    const result = syncGitignoreToWorktree({ repoRoot, worktreePath });

    expect(result).toEqual({ ok: true, changed: true, skipped: false });
    expect(
      fs.readFileSync(path.join(worktreePath, ".gitignore"), "utf-8"),
    ).toBe("node_modules/\n.pi/\n");
  });

  it("is idempotent when source and target content already match", () => {
    const repoRoot = createTempDir("pi-kit-feature-gitignore-source-");
    const worktreePath = createTempDir("pi-kit-feature-gitignore-target-");

    const content = "node_modules/\n.pi/\n";
    fs.writeFileSync(path.join(repoRoot, ".gitignore"), content);
    fs.writeFileSync(path.join(worktreePath, ".gitignore"), content);

    const result = syncGitignoreToWorktree({ repoRoot, worktreePath });

    expect(result).toEqual({ ok: true, changed: false, skipped: false });
  });

  it("skips when source .gitignore is missing", () => {
    const repoRoot = createTempDir("pi-kit-feature-gitignore-source-");
    const worktreePath = createTempDir("pi-kit-feature-gitignore-target-");

    const result = syncGitignoreToWorktree({ repoRoot, worktreePath });

    expect(result).toEqual({ ok: true, changed: false, skipped: true });
    expect(fs.existsSync(path.join(worktreePath, ".gitignore"))).toBe(false);
  });

  it("skips when worktree path is empty", () => {
    const repoRoot = createTempDir("pi-kit-feature-gitignore-empty-path-");
    fs.writeFileSync(path.join(repoRoot, ".gitignore"), ".pi/\n");

    const originalCwd = process.cwd();
    const isolatedCwd = createTempDir("pi-kit-feature-gitignore-cwd-");
    process.chdir(isolatedCwd);

    try {
      const result = syncGitignoreToWorktree({
        repoRoot,
        worktreePath: "   ",
      });

      expect(result).toEqual({ ok: true, changed: false, skipped: true });
      expect(fs.existsSync(path.join(isolatedCwd, ".gitignore"))).toBe(false);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("skips when source and target resolve to the same path", () => {
    const repoRoot = createTempDir("pi-kit-feature-gitignore-same-");
    fs.writeFileSync(path.join(repoRoot, ".gitignore"), ".pi/\n");

    const result = syncGitignoreToWorktree({
      repoRoot,
      worktreePath: repoRoot,
    });

    expect(result).toEqual({ ok: true, changed: false, skipped: true });
  });
});
