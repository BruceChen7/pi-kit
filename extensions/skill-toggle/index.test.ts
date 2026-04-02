import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearSettingsCache,
  getSettingsPaths,
  readSettingsFile,
} from "../shared/settings.js";
import type { Skill } from "./index.js";

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
  it("ignores project settings and uses global byCwd entry", async () => {
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

    expect(state.writeScope).toBe("global");
    expect(state.writePath).toBe(globalPath);
    expect(state.cwdKey).toBe(cwd);
    expect(state.disabledSkills.has("global-only")).toBe(true);
    expect(state.disabledSkills.has("projectskill")).toBe(false);
  });

  it("writes disabled skills to global settings", async () => {
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

    state.disabledSkills.add("beta");
    saveToggleState(state);

    const saved = readSettingsFile(globalPath);
    const byCwd = (saved.skillToggle as { byCwd: Record<string, unknown> })
      .byCwd;
    const entry = byCwd[cwd] as { disabledSkills: string[] };
    expect(entry.disabledSkills).toEqual(["beta", "gamma"]);
  });
});

describe("skill override sync", () => {
  it("writes global overrides and preserves user entries", async () => {
    createTempHome();
    const cwd = createTempDir("pi-kit-skill-toggle-cwd-");
    const { globalPath } = getSettingsPaths(cwd);
    const skillPath = path.join(cwd, ".pi", "skills", "alpha", "SKILL.md");
    const overridePath = `-${path.join(cwd, ".pi", "skills", "alpha")}`;

    fs.mkdirSync(path.dirname(globalPath), { recursive: true });
    fs.writeFileSync(
      globalPath,
      JSON.stringify(
        {
          skillToggle: {
            byCwd: {
              [cwd]: {
                disabledSkills: ["Alpha"],
              },
            },
          },
          skills: ["custom"],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { loadToggleState, syncSkillOverrides } = await importSkillToggle();
    const state = loadToggleState(cwd);

    syncSkillOverrides(
      state,
      [
        {
          name: "Alpha",
          description: "Alpha skill",
          filePath: skillPath,
          scope: "project",
        },
      ],
      cwd,
    );

    const saved = readSettingsFile(globalPath);
    const byCwd = (saved.skillToggle as { byCwd: Record<string, unknown> })
      .byCwd;
    const entry = byCwd[cwd] as { managedOverrides?: string[] };
    expect(saved.skills).toEqual(["custom", overridePath]);
    expect(entry.managedOverrides).toEqual([overridePath]);
  });

  it("removes global overrides when re-enabled", async () => {
    createTempHome();
    const cwd = createTempDir("pi-kit-skill-toggle-cwd-");
    const { globalPath } = getSettingsPaths(cwd);
    const skillPath = path.join(
      os.homedir(),
      ".agents",
      "skills",
      "alpha",
      "SKILL.md",
    );

    fs.mkdirSync(path.dirname(globalPath), { recursive: true });
    fs.writeFileSync(
      globalPath,
      JSON.stringify(
        {
          skillToggle: {
            byCwd: {
              [cwd]: {
                disabledSkills: ["Alpha"],
              },
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { loadToggleState, saveToggleState, syncSkillOverrides } =
      await importSkillToggle();
    const state = loadToggleState(cwd);

    syncSkillOverrides(
      state,
      [
        {
          name: "Alpha",
          description: "Alpha skill",
          filePath: skillPath,
          scope: "user",
        },
      ],
      cwd,
    );

    state.disabledSkills.clear();
    saveToggleState(state);
    syncSkillOverrides(
      state,
      [
        {
          name: "Alpha",
          description: "Alpha skill",
          filePath: skillPath,
          scope: "user",
        },
      ],
      cwd,
    );

    const saved = readSettingsFile(globalPath);
    const byCwd = (saved.skillToggle as { byCwd: Record<string, unknown> })
      .byCwd;
    const entry = byCwd[cwd] as { managedOverrides?: string[] };
    expect(saved.skills).toBeUndefined();
    expect(entry.managedOverrides).toBeUndefined();
  });

  it("prunes stale managed overrides", async () => {
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
                disabledSkills: [],
                managedOverrides: [
                  `-${path.join(os.homedir(), ".agents", "skills", "ghost")}`,
                ],
              },
            },
          },
          skills: [
            "custom",
            `-${path.join(os.homedir(), ".agents", "skills", "ghost")}`,
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { loadToggleState, syncSkillOverrides } = await importSkillToggle();
    const state = loadToggleState(cwd);

    syncSkillOverrides(state, [], cwd);

    const saved = readSettingsFile(globalPath);
    const byCwd = (saved.skillToggle as { byCwd: Record<string, unknown> })
      .byCwd;
    const entry = byCwd[cwd] as { managedOverrides?: string[] };
    expect(saved.skills).toEqual(["custom"]);
    expect(entry.managedOverrides).toBeUndefined();
  });
});

describe("formatDisabledSkillsMessage", () => {
  it("returns an empty-state message when no installed disabled skills exist", async () => {
    createTempHome();
    const skillToggle = await importSkillToggle();
    const formatDisabledSkillsMessage = (
      skillToggle as {
        formatDisabledSkillsMessage?: (
          disabled: Set<string>,
          skills: Skill[],
        ) => string;
      }
    ).formatDisabledSkillsMessage;

    expect(formatDisabledSkillsMessage).toBeDefined();
    expect(formatDisabledSkillsMessage?.(new Set(), [])).toBe(
      "No disabled skills",
    );
  });

  it("formats disabled skills using canonical skill names", async () => {
    createTempHome();
    const skillToggle = await importSkillToggle();
    const formatDisabledSkillsMessage = (
      skillToggle as {
        formatDisabledSkillsMessage?: (
          disabled: Set<string>,
          skills: Skill[],
        ) => string;
      }
    ).formatDisabledSkillsMessage;

    const skills: Skill[] = [
      {
        name: "Alpha",
        description: "",
        filePath: "/tmp/alpha/SKILL.md",
      },
      {
        name: "Beta Skill",
        description: "",
        filePath: "/tmp/beta-skill/SKILL.md",
      },
    ];

    expect(
      formatDisabledSkillsMessage?.(new Set(["beta skill", "alpha"]), skills),
    ).toBe("Disabled skills (2): Alpha, Beta Skill");
  });

  it("omits stale disabled skills that are no longer installed", async () => {
    createTempHome();
    const skillToggle = await importSkillToggle();
    const formatDisabledSkillsMessage = (
      skillToggle as {
        formatDisabledSkillsMessage?: (
          disabled: Set<string>,
          skills: Skill[],
        ) => string;
      }
    ).formatDisabledSkillsMessage;

    const skills: Skill[] = [
      {
        name: "Alpha",
        description: "",
        filePath: "/tmp/alpha/SKILL.md",
      },
    ];

    expect(
      formatDisabledSkillsMessage?.(new Set(["ghost", "alpha"]), skills),
    ).toBe("Disabled skills (1): Alpha");
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
