/**
 * 项目配置只能加严计划模式的护栏（ADR-0001 D2）。
 *
 * 这里只测配置层：settings 文件怎么落盘、被忽略的键怎么上报。守卫本身的
 * 行为在 tool-guard.test.ts 里测。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearSettingsCache,
  getSettingsPaths,
  writeSettingsFile,
} from "../shared/settings.ts";
import { DEFAULT_CONFIG, PLAN_MODE_PLAN } from "./constants.ts";
import { loadPlanModeConfigWithDiagnostics } from "./state.ts";

const originalHome = process.env.HOME;
const tempDirs: string[] = [];

const tempDir = (prefix: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

const writeProject = (cwd: string, settings: Record<string, unknown>): void => {
  writeSettingsFile(getSettingsPaths(cwd).projectPath, settings);
};

const writeGlobal = (home: string, settings: Record<string, unknown>): void => {
  fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
  writeSettingsFile(getSettingsPaths(home).globalPath, settings);
};

afterEach(() => {
  clearSettingsCache();
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("plan-mode config trust", () => {
  it("ignores a project that turns the review gate off", () => {
    const home = tempDir("plan-trust-home-");
    process.env.HOME = home;
    writeGlobal(home, { planMode: { requireReview: true } });
    const cwd = tempDir("plan-trust-repo-");
    writeProject(cwd, { planMode: { requireReview: false } });

    const { config, ignoredProjectKeys } =
      loadPlanModeConfigWithDiagnostics(cwd);

    expect(config.requireReview).toBe(true);
    expect(ignoredProjectKeys).toEqual([
      "planMode.requireReview（项目值放宽护栏）",
    ]);
  });

  it("ignores a project preset that switches the review gate off", () => {
    process.env.HOME = tempDir("plan-trust-home-");
    const cwd = tempDir("plan-trust-repo-");
    writeProject(cwd, { planMode: { preset: "solo" } });

    const { config } = loadPlanModeConfigWithDiagnostics(cwd);

    expect(config.requireReview).toBe(DEFAULT_CONFIG.requireReview);
  });

  it("keeps a project value that narrows the guard", () => {
    const home = tempDir("plan-trust-home-");
    process.env.HOME = home;
    writeGlobal(home, { planMode: { guards: { readBeforeWrite: false } } });
    const cwd = tempDir("plan-trust-repo-");
    writeProject(cwd, { planMode: { guards: { readBeforeWrite: true } } });

    const { config, ignoredProjectKeys } =
      loadPlanModeConfigWithDiagnostics(cwd);

    expect(config.guards.readBeforeWrite).toBe(true);
    expect(ignoredProjectKeys).toEqual([]);
  });

  it("still honors project settings that do not weaken a guard", () => {
    process.env.HOME = tempDir("plan-trust-home-");
    const cwd = tempDir("plan-trust-repo-");
    writeProject(cwd, {
      planMode: { defaultMode: PLAN_MODE_PLAN, preserveExternalTools: true },
    });

    const { config } = loadPlanModeConfigWithDiagnostics(cwd);

    expect(config.defaultMode).toBe(PLAN_MODE_PLAN);
    expect(config.preserveExternalTools).toBe(true);
  });

  it("drops a widening project key when global has nothing to fall back on", () => {
    process.env.HOME = tempDir("plan-trust-home-");
    const cwd = tempDir("plan-trust-repo-");
    writeProject(cwd, {
      planMode: { artifactPolicy: { enabled: false }, requireReview: false },
    });

    const { config, ignoredProjectKeys } =
      loadPlanModeConfigWithDiagnostics(cwd);

    expect(config.requireReview).toBe(DEFAULT_CONFIG.requireReview);
    expect(config.artifactPolicy.enabled).toBe(
      DEFAULT_CONFIG.artifactPolicy.enabled,
    );
    expect(ignoredProjectKeys).toHaveLength(2);
  });
});
