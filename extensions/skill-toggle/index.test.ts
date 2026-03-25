import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearSettingsCache,
  getSettingsPaths,
  readSettingsFile,
} from "../shared/settings.js";

const tempDirs: string[] = [];
const originalHome = process.env.HOME;
const originalCwd = process.cwd();

const registerTempDir = (dir: string): string => {
  tempDirs.push(dir);
  return dir;
};

const createTempDir = (prefix: string): string =>
  registerTempDir(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

const createTempHome = (): string => {
  const dir = createTempDir("pi-kit-skill-toggle-home-");
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

const importSkillToggle = async () => {
  vi.resetModules();
  return await import("./index.js");
};

afterEach(() => {
  clearSettingsCache();
  restoreHome();
  process.chdir(originalCwd);
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.resetModules();
});

describe("createLoggerReady", () => {
  it("waits for logger initialization to complete", async () => {
    createTempHome();
    const { createLoggerReady } = await importSkillToggle();

    let resolveInit: (() => void) | null = null;
    const init = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveInit = resolve;
        }),
    );

    const ready = createLoggerReady("/tmp/pi-kit", init);

    expect(init).toHaveBeenCalledWith("/tmp/pi-kit");

    let settled = false;
    void ready.then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    resolveInit?.();
    await ready;
    expect(settled).toBe(true);
  });

  it("swallows logger initialization failures", async () => {
    createTempHome();
    const { createLoggerReady } = await importSkillToggle();

    const init = vi.fn(async () => {
      throw new Error("boom");
    });

    await expect(
      createLoggerReady("/tmp/pi-kit", init),
    ).resolves.toBeUndefined();
    expect(init).toHaveBeenCalledWith("/tmp/pi-kit");
  });
});

describe("settings integration", () => {
  it("prefers project settings and selects project write scope", async () => {
    createTempHome();
    const cwd = createTempDir("pi-kit-skill-toggle-cwd-");
    const { globalPath, projectPath } = getSettingsPaths(cwd);

    fs.mkdirSync(path.dirname(globalPath), { recursive: true });
    fs.writeFileSync(
      globalPath,
      JSON.stringify(
        {
          skillToggle: {
            byCwd: {
              [cwd]: {
                disabledSkills: ["global-only"],
              },
            },
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
          skillToggle: {
            disabledSkills: ["ProjectSkill"],
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { loadToggleState } = await importSkillToggle();
    const state = loadToggleState(cwd);

    expect(state.writeScope).toBe("project");
    expect(state.writePath).toBe(projectPath);
    expect(state.disabledSkills.has("projectskill")).toBe(true);
    expect(state.disabledSkills.has("global-only")).toBe(false);
  });

  it("falls back to global byCwd and writes to global settings", async () => {
    createTempHome();
    const cwd = createTempDir("pi-kit-skill-toggle-cwd-");
    const { globalPath } = getSettingsPaths(cwd);

    fs.mkdirSync(path.dirname(globalPath), { recursive: true });
    fs.writeFileSync(
      globalPath,
      JSON.stringify(
        {
          skillToggle: {
            byCwd: {
              [cwd]: {
                disabledSkills: ["Gamma"],
              },
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { loadToggleState, saveToggleState } = await importSkillToggle();
    const state = loadToggleState(cwd);

    expect(state.writeScope).toBe("global");
    expect(state.writePath).toBe(globalPath);
    expect(state.cwdKey).toBe(cwd);
    expect(state.disabledSkills.has("gamma")).toBe(true);

    state.disabledSkills.add("beta");
    saveToggleState(state);

    const saved = readSettingsFile(globalPath);
    const byCwd = (saved.skillToggle as { byCwd: Record<string, unknown> })
      .byCwd;
    const entry = byCwd[cwd] as { disabledSkills: string[] };
    expect(entry.disabledSkills).toEqual(["beta", "gamma"]);
  });
});

describe("parseFrontmatter", () => {
  it("parses multi-line description blocks", async () => {
    createTempHome();
    const skillToggle = await importSkillToggle();
    const parseFrontmatter = (
      skillToggle as {
        parseFrontmatter?: (
          content: string,
          fallbackName: string,
        ) => { name: string; description: string };
      }
    ).parseFrontmatter;

    expect(parseFrontmatter).toBeDefined();

    const content = [
      "---",
      "name: office-hours",
      "description: |",
      "  Founder-style office hours to clarify the problem, users, and wedge before any code is written.",
      "  Runs in Startup or Builder mode.",
      "---",
      "",
    ].join("\n");

    const result = parseFrontmatter?.(content, "fallback");

    expect(result).toEqual({
      name: "office-hours",
      description:
        "Founder-style office hours to clarify the problem, users, and wedge before any code is written. Runs in Startup or Builder mode.",
    });
  });
});
