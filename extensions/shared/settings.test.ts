import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearSettingsCache,
  getGlobalSettingsPath,
  getSettingsPaths,
  loadGlobalSettings,
  loadSettings,
  resolveTrustedSettings,
  writeSettingsFile,
} from "./settings.js";

const tempDirs: string[] = [];
const originalHome = process.env.HOME;

const registerTempDir = (dir: string): string => {
  tempDirs.push(dir);
  return dir;
};

const createTempDir = (prefix: string): string =>
  registerTempDir(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

const createTempHome = (): string => {
  const dir = createTempDir("pi-kit-settings-home-");
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

describe("loadSettings", () => {
  it("merges project settings over global and exposes raw settings", () => {
    createTempHome();
    const cwd = createTempDir("pi-kit-settings-cwd-");
    const { globalPath, projectPath } = getSettingsPaths(cwd);

    fs.mkdirSync(path.dirname(globalPath), { recursive: true });
    fs.writeFileSync(
      globalPath,
      JSON.stringify({ alpha: 1, shared: { source: "global" } }, null, 2),
      "utf-8",
    );

    fs.mkdirSync(path.dirname(projectPath), { recursive: true });
    fs.writeFileSync(
      projectPath,
      JSON.stringify({ alpha: 2, beta: 3 }, null, 2),
      "utf-8",
    );

    const settings = loadSettings(cwd, { forceReload: true });
    expect(settings.global).toEqual({ alpha: 1, shared: { source: "global" } });
    expect(settings.project).toEqual({ alpha: 2, beta: 3 });
    expect(settings.merged).toEqual({
      alpha: 2,
      beta: 3,
      shared: { source: "global" },
    });
  });

  it("returns empty objects when settings files are invalid", () => {
    createTempHome();
    const cwd = createTempDir("pi-kit-settings-cwd-");
    const { globalPath, projectPath } = getSettingsPaths(cwd);

    fs.mkdirSync(path.dirname(globalPath), { recursive: true });
    fs.writeFileSync(globalPath, "{not-json}", "utf-8");

    fs.mkdirSync(path.dirname(projectPath), { recursive: true });
    fs.writeFileSync(projectPath, "[]", "utf-8");

    const settings = loadSettings(cwd, { forceReload: true });
    expect(settings.global).toEqual({});
    expect(settings.project).toEqual({});
    expect(settings.merged).toEqual({});
  });

  it("caches settings and refreshes with forceReload", () => {
    createTempHome();
    const cwd = createTempDir("pi-kit-settings-cwd-");
    const { projectPath } = getSettingsPaths(cwd);

    fs.mkdirSync(path.dirname(projectPath), { recursive: true });
    fs.writeFileSync(
      projectPath,
      JSON.stringify({ value: 1 }, null, 2),
      "utf-8",
    );

    const first = loadSettings(cwd);
    fs.writeFileSync(
      projectPath,
      JSON.stringify({ value: 2 }, null, 2),
      "utf-8",
    );

    const cached = loadSettings(cwd);
    expect(cached.project).toEqual({ value: 1 });

    const refreshed = loadSettings(cwd, { forceReload: true });
    expect(refreshed.project).toEqual({ value: 2 });
    expect(first.project).toEqual({ value: 1 });
  });

  it("updates caches after writing settings", () => {
    createTempHome();
    const cwd = createTempDir("pi-kit-settings-cwd-");
    const { globalPath, projectPath } = getSettingsPaths(cwd);

    fs.mkdirSync(path.dirname(globalPath), { recursive: true });
    fs.writeFileSync(
      globalPath,
      JSON.stringify({ level: "info" }, null, 2),
      "utf-8",
    );

    fs.mkdirSync(path.dirname(projectPath), { recursive: true });
    fs.writeFileSync(
      projectPath,
      JSON.stringify({ local: true }, null, 2),
      "utf-8",
    );

    const initial = loadSettings(cwd);
    expect(initial.merged).toEqual({ level: "info", local: true });

    writeSettingsFile(globalPath, { level: "warn" });
    const afterGlobal = loadSettings(cwd);
    expect(afterGlobal.global).toEqual({ level: "warn" });
    expect(afterGlobal.merged).toEqual({ level: "warn", local: true });

    writeSettingsFile(projectPath, { local: false });
    const afterProject = loadSettings(cwd);
    expect(afterProject.project).toEqual({ local: false });
    expect(afterProject.merged).toEqual({ level: "warn", local: false });
  });
});

describe("loadGlobalSettings", () => {
  it("caches global settings and refreshes with forceReload", () => {
    createTempHome();
    const globalPath = getGlobalSettingsPath();

    fs.mkdirSync(path.dirname(globalPath), { recursive: true });
    fs.writeFileSync(
      globalPath,
      JSON.stringify({ value: 1 }, null, 2),
      "utf-8",
    );

    const first = loadGlobalSettings();
    fs.writeFileSync(
      globalPath,
      JSON.stringify({ value: 2 }, null, 2),
      "utf-8",
    );

    const cached = loadGlobalSettings();
    expect(cached.global).toEqual({ value: 1 });

    const refreshed = loadGlobalSettings({ forceReload: true });
    expect(refreshed.global).toEqual({ value: 2 });
    expect(first.global).toEqual({ value: 1 });
  });
});

describe("resolveTrustedSettings", () => {
  const rule = (
    path: string,
    isWidening: (value: unknown) => boolean = (value) => value === false,
  ) => ({ path, isWidening });

  it("behaves like the plain project-over-global merge without rules", () => {
    const { effective, ignored } = resolveTrustedSettings(
      { a: 1, b: 2 },
      { b: 3 },
    );

    expect(effective).toEqual({ a: 1, b: 3 });
    expect(ignored).toEqual([]);
  });

  it("ignores a project value that widens a guarded key", () => {
    const { effective, ignored } = resolveTrustedSettings(
      { planMode: { requireReview: true } },
      { planMode: { requireReview: false } },
      [rule("planMode.requireReview")],
    );

    expect(effective).toEqual({ planMode: { requireReview: true } });
    expect(ignored).toEqual(["planMode.requireReview（项目值放宽护栏）"]);
  });

  it("keeps a project value that narrows", () => {
    const { effective, ignored } = resolveTrustedSettings(
      { planMode: { guards: { readBeforeWrite: false } } },
      { planMode: { guards: { readBeforeWrite: true } } },
      [rule("planMode.guards.readBeforeWrite")],
    );

    expect(effective).toEqual({
      planMode: { guards: { readBeforeWrite: true } },
    });
    expect(ignored).toEqual([]);
  });

  it("drops the key when global has no value to fall back on", () => {
    const { effective, ignored } = resolveTrustedSettings(
      {},
      { planMode: { requireReview: false, other: 1 } },
      [rule("planMode.requireReview")],
    );

    expect(effective).toEqual({ planMode: { other: 1 } });
    expect(ignored).toHaveLength(1);
  });

  it("leaves unrelated project keys alone", () => {
    const { effective } = resolveTrustedSettings(
      { planMode: { requireReview: true }, qmd: { a: 1 } },
      { qmd: { a: 2 } },
      [rule("planMode.requireReview")],
    );

    expect(effective.qmd).toEqual({ a: 2 });
  });

  it("matches a string preset rule", () => {
    const { effective, ignored } = resolveTrustedSettings(
      { planMode: { preset: "team" } },
      { planMode: { preset: "solo" } },
      [rule("planMode.preset", (value) => value === "solo")],
    );

    expect(effective.planMode).toEqual({ preset: "team" });
    expect(ignored).toEqual(["planMode.preset（项目值放宽护栏）"]);
  });
});

describe("resolveTrustedSettings: deep merge keeps global subtrees", () => {
  it("keeps an unrelated global leaf when the project sets a sibling", () => {
    const { effective } = resolveTrustedSettings(
      { planMode: { requireReview: true, guards: { readBeforeWrite: true } } },
      { planMode: { defaultMode: "plan" } },
      [],
    );

    expect(effective).toEqual({
      planMode: {
        requireReview: true,
        guards: { readBeforeWrite: true },
        defaultMode: "plan",
      },
    });
  });

  it("still reports a widening project value deep inside a subtree", () => {
    const { effective, ignored } = resolveTrustedSettings(
      { planMode: { guards: { readBeforeWrite: true } } },
      { planMode: { guards: { readBeforeWrite: false }, defaultMode: "plan" } },
      [
        {
          path: "planMode.guards.readBeforeWrite",
          isWidening: (value: unknown) => value === false,
        },
      ],
    );

    expect(effective.planMode).toEqual({
      guards: { readBeforeWrite: true },
      defaultMode: "plan",
    });
    expect(ignored).toEqual([
      "planMode.guards.readBeforeWrite（项目值放宽护栏）",
    ]);
  });

  it("replaces arrays instead of merging them", () => {
    expect(
      resolveTrustedSettings({ list: [1, 2] }, { list: [3] }).effective,
    ).toEqual({ list: [3] });
  });
});
