import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearSettingsCache, getSettingsPaths } from "../shared/settings.js";
import { resolveEnvGuardConfig } from "./index.js";

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
