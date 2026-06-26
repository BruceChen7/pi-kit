import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearSettingsCache, getSettingsPaths } from "../shared/settings.js";
import { resolveEnvGuardConfig, rewriteGitDiffCommand } from "./index.js";

const tempDirs: string[] = [];
const originalHome = process.env.HOME;

const registerTempDir = (dir: string): string => {
  tempDirs.push(dir);
  return dir;
};

const createTempDir = (prefix: string): string =>
  registerTempDir(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

const createTempHome = (): string => {
  const dir = createTempDir("pi-kit-env-guard-home-");
  process.env.HOME = dir;
  return dir;
};

const restoreHome = (): void => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
};

afterEach(() => {
  clearSettingsCache();
  restoreHome();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveEnvGuardConfig", () => {
  it("merges env overrides and prefers project gitDiffFlags", () => {
    createTempHome();
    const cwd = createTempDir("pi-kit-env-guard-cwd-");
    const { globalPath, projectPath } = getSettingsPaths(cwd);

    fs.mkdirSync(path.dirname(globalPath), { recursive: true });
    fs.writeFileSync(
      globalPath,
      JSON.stringify(
        {
          envGuard: {
            env: {
              GIT_PAGER: "less",
              CUSTOM: "1",
            },
            gitDiffFlags: ["--stat"],
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    fs.mkdirSync(path.dirname(projectPath), { recursive: true });
    fs.writeFileSync(
      projectPath,
      JSON.stringify(
        {
          envGuard: {
            env: {
              CUSTOM: "2",
              EXTRA: "x",
            },
            gitDiffFlags: "--color=always",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const config = resolveEnvGuardConfig(cwd, { forceReload: true });
    expect(config.envMap.GIT_PAGER).toBe("less");
    expect(config.envMap.CUSTOM).toBe("2");
    expect(config.envMap.EXTRA).toBe("x");
    expect(config.gitDiffFlags).toEqual(["--color=always"]);
  });

  it("falls back to global gitDiffFlags when project is unset", () => {
    createTempHome();
    const cwd = createTempDir("pi-kit-env-guard-cwd-");
    const { globalPath, projectPath } = getSettingsPaths(cwd);

    fs.mkdirSync(path.dirname(globalPath), { recursive: true });
    fs.writeFileSync(
      globalPath,
      JSON.stringify(
        {
          envGuard: {
            gitDiffFlags: ["--stat", "--compact-summary"],
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    fs.mkdirSync(path.dirname(projectPath), { recursive: true });
    fs.writeFileSync(
      projectPath,
      JSON.stringify({ envGuard: {} }, null, 2),
      "utf-8",
    );

    const config = resolveEnvGuardConfig(cwd, { forceReload: true });
    expect(config.gitDiffFlags).toEqual(["--stat", "--compact-summary"]);
  });
});

describe("rewriteGitDiffCommand", () => {
  it("rewrites bare git diff command", () => {
    const result = rewriteGitDiffCommand("git diff HEAD", []);
    expect(result).toContain("git --no-pager diff");
    expect(result).toContain("--no-ext-diff");
    expect(result).toContain("HEAD");
  });

  it("rewrites git diff with leading cd prefix", () => {
    const result = rewriteGitDiffCommand(
      "cd /Users/ming.chen/work/video/bff_resource && git diff origin/release HEAD -- internal/preload/video_toggle_preload_handler.go",
      [],
    );
    expect(result).toContain("git --no-pager diff");
    expect(result).toContain("--no-ext-diff");
    expect(result).toContain("origin/release HEAD");
    // 保留 cd 前缀
    expect(result).toContain("cd /Users/ming.chen/work/video/bff_resource");
  });

  it("rewrites git diff with multi-cd prefix", () => {
    const result = rewriteGitDiffCommand(
      "cd /a && cd /b && git diff origin/release HEAD",
      [],
    );
    expect(result).toContain("git --no-pager diff");
    expect(result).toContain("--no-ext-diff");
    expect(result).toContain("cd /a && cd /b");
  });

  it("rewrites git diff with env var prefix", () => {
    const result = rewriteGitDiffCommand("GIT_PAGER=cat git diff --stat", []);
    expect(result).toContain("git --no-pager diff");
    expect(result).toContain("--no-ext-diff");
    expect(result).toContain("GIT_PAGER=cat");
  });

  it("avoids duplicating --no-ext-diff when already present", () => {
    const result = rewriteGitDiffCommand("git diff --no-ext-diff --stat", []);
    expect(result).toBe("git --no-pager diff --no-ext-diff --stat");
  });

  it("avoids duplicating --no-ext-diff when extra flags include it", () => {
    const result = rewriteGitDiffCommand("git diff --stat", [
      "--no-ext-diff",
      "--color=never",
    ]);
    expect(result).toBe(
      "git --no-pager diff --no-ext-diff --color=never --stat",
    );
  });

  it("does not rewrite git diff inside a commit message", () => {
    const result = rewriteGitDiffCommand(
      'git commit -m "fix: handle git diff edge case"',
      [],
    );
    expect(result).toBe('git commit -m "fix: handle git diff edge case"');
  });

  it("does not rewrite git diff inside a double-quoted string argument", () => {
    const result = rewriteGitDiffCommand('echo "run git diff here"', []);
    expect(result).toBe('echo "run git diff here"');
  });

  it("does not rewrite git diff inside a single-quoted string argument", () => {
    const result = rewriteGitDiffCommand(
      "echo 'run git diff here'",
      [],
    );
    expect(result).toBe("echo 'run git diff here'");
  });

  it("does not rewrite git diff as a bare argument to another command", () => {
    const result = rewriteGitDiffCommand("echo git diff", []);
    expect(result).toBe("echo git diff");
  });

  it("does not rewrite git diff after a flag argument", () => {
    const result = rewriteGitDiffCommand(
      "some-tool --message git diff here",
      [],
    );
    expect(result).toBe("some-tool --message git diff here");
  });

  it("does not rewrite non-git commands", () => {
    const result = rewriteGitDiffCommand("ls -la", []);
    expect(result).toBe("ls -la");
  });
});

describe("applyEnvGuard env handling", () => {
  it("includes DEFAULT_ENV empty-string values in envMap for known keys", () => {
    // resolveEnvGuardConfig 返回的 envMap 包含 DEFAULT_ENV 的 key
    // 其中 GIT_EXTERNAL_DIFF 和 GIT_DIFF 为空串
    // applyEnvGuard 会将这些空串转为 delete process.env
    // 此处验证 resolveEnvGuardConfig 返回的 envMap 包含这些空值
    const cwd = createTempDir("pi-kit-env-guard-cwd-");
    const config = resolveEnvGuardConfig(cwd, { forceReload: true });

    // DEFAULT_ENV 中的空值 key 应该存在
    expect(config.envMap).toHaveProperty("GIT_EXTERNAL_DIFF");
    expect(config.envMap.GIT_EXTERNAL_DIFF).toBe("");
    expect(config.envMap).toHaveProperty("GIT_DIFF");
    expect(config.envMap.GIT_DIFF).toBe("");
  });
});
