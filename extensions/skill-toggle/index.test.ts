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

interface SkillToggleTestEntry {
  disabledSkillPaths?: string[];
  managedOverrides?: string[];
  managedSkillLinks?: unknown[];
}

function getProjectSettingsPath(cwd: string): string {
  return path.join(cwd, ".pi", "settings.json");
}

function writeSkillFile(skillDir: string): void {
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: Alpha\ndescription: Alpha skill\n---\n",
  );
}

function readSkillToggleEntry(
  filePath: string,
  cwd: string,
): SkillToggleTestEntry {
  const saved = readSettingsFile(filePath);
  return (
    saved.skillToggle as {
      byCwd: Record<string, SkillToggleTestEntry>;
    }
  ).byCwd[cwd];
}

function alphaSkill(filePath: string): Skill {
  return {
    name: "Alpha",
    description: "Alpha skill",
    filePath,
    scope: "project",
  };
}

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
  it("uses primary repo byCwd entry when running from a worktree cwd", async () => {
    createTempHome();
    const primaryRepoCwd = createTempDir("pi-kit-skill-toggle-primary-");
    const worktreeCwd = createTempDir("pi-kit-skill-toggle-worktree-");
    const { globalPath } = getSettingsPaths(worktreeCwd);

    vi.doMock("../shared/git.js", async () => {
      const actual =
        await vi.importActual<typeof import("../shared/git.js")>(
          "../shared/git.js",
        );
      return {
        ...actual,
        getGitCommonDir: () => path.join(primaryRepoCwd, ".git"),
        getRepoRoot: () => worktreeCwd,
      };
    });

    try {
      fs.mkdirSync(path.dirname(globalPath), { recursive: true });
      fs.writeFileSync(
        globalPath,
        JSON.stringify(
          {
            skillToggle: {
              byCwd: {
                [primaryRepoCwd]: {
                  disabledSkills: ["alpha"],
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
      const state = loadToggleState(worktreeCwd);

      expect(state.cwdKey).toBe(primaryRepoCwd);
      expect(state.disabledSkills.has("alpha")).toBe(true);

      state.disabledSkills.add("beta");
      saveToggleState(state);

      const saved = readSettingsFile(globalPath);
      const byCwd = (saved.skillToggle as { byCwd: Record<string, unknown> })
        .byCwd;
      const entry = byCwd[primaryRepoCwd] as { disabledSkills: string[] };

      expect(entry.disabledSkills).toEqual(["alpha", "beta"]);
      expect(byCwd[worktreeCwd]).toBeUndefined();
    } finally {
      vi.doUnmock("../shared/git.js");
    }
  });

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

  it("supports HOME env vars in byCwd keys and persists new keys with HOME", async () => {
    createTempHome();
    const cwd = path.join(os.homedir(), "workspace", "pi-kit-repo");
    fs.mkdirSync(cwd, { recursive: true });
    const { globalPath } = getSettingsPaths(cwd);
    const envKey = "$HOME/workspace/pi-kit-repo";

    fs.mkdirSync(path.dirname(globalPath), { recursive: true });
    fs.writeFileSync(
      globalPath,
      JSON.stringify(
        {
          skillToggle: {
            byCwd: {
              [envKey]: {
                disabledSkills: ["EnvSkill"],
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

    expect(state.cwdKey).toBe(envKey);
    expect(state.disabledSkills.has("envskill")).toBe(true);

    state.disabledSkills.add("beta");
    saveToggleState(state);

    const saved = readSettingsFile(globalPath);
    const byCwd = (saved.skillToggle as { byCwd: Record<string, unknown> })
      .byCwd;
    const entry = byCwd[envKey] as { disabledSkills: string[] };
    expect(entry.disabledSkills).toEqual(["beta", "envskill"]);
  });
});

describe("skill symlink toggle", () => {
  it("disables a symlinked skill by removing the symlink without writing prompt overrides", async () => {
    createTempHome();
    const cwd = createTempDir("pi-kit-skill-toggle-cwd-");
    const sourceSkillDir = path.join(
      createTempDir("pi-kit-skill-toggle-source-"),
      "alpha",
    );
    const linkedSkillDir = path.join(cwd, ".agents", "skills", "alpha");
    const { globalPath } = getSettingsPaths(cwd);

    writeSkillFile(sourceSkillDir);
    fs.mkdirSync(path.dirname(linkedSkillDir), { recursive: true });
    fs.symlinkSync(sourceSkillDir, linkedSkillDir);

    const { loadToggleState, toggleSkillLink } = await importSkillToggle();
    const state = loadToggleState(cwd);
    const result = toggleSkillLink(
      state,
      alphaSkill(path.join(linkedSkillDir, "SKILL.md")),
    );

    expect(result.status).toBe("disabled");
    expect(fs.existsSync(linkedSkillDir)).toBe(false);

    const saved = readSettingsFile(globalPath);
    const entry = readSkillToggleEntry(globalPath, cwd);
    expect(saved.skills).toBeUndefined();
    expect(entry.disabledSkillPaths).toEqual([linkedSkillDir]);
    expect(entry.managedSkillLinks).toEqual([
      {
        name: "Alpha",
        description: "Alpha skill",
        path: linkedSkillDir,
        target: sourceSkillDir,
      },
    ]);
  });

  it("syncs disabled symlink skills to pi core skill overrides", async () => {
    createTempHome();
    const cwd = createTempDir("pi-kit-skill-toggle-cwd-");
    const sourceSkillDir = path.join(
      createTempDir("pi-kit-skill-toggle-source-"),
      "alpha",
    );
    const linkedSkillDir = path.join(cwd, ".agents", "skills", "alpha");
    const projectSettingsPath = getProjectSettingsPath(cwd);

    writeSkillFile(sourceSkillDir);
    fs.mkdirSync(path.dirname(linkedSkillDir), { recursive: true });
    fs.symlinkSync(sourceSkillDir, linkedSkillDir);

    const { loadToggleState, syncSkillOverrides, toggleSkillLink } =
      await importSkillToggle();
    const state = loadToggleState(cwd);
    const skill = alphaSkill(path.join(linkedSkillDir, "SKILL.md"));
    const result = toggleSkillLink(state, skill);
    syncSkillOverrides(state, [skill], cwd);

    expect(result.status).toBe("disabled");
    expect(readSettingsFile(projectSettingsPath).skills).toEqual([
      `-${linkedSkillDir}`,
    ]);
  });

  it("re-enables a managed skill by recreating its symlink", async () => {
    createTempHome();
    const cwd = createTempDir("pi-kit-skill-toggle-cwd-");
    const sourceSkillDir = path.join(
      createTempDir("pi-kit-skill-toggle-source-"),
      "alpha",
    );
    const linkedSkillDir = path.join(cwd, ".agents", "skills", "alpha");
    const { globalPath } = getSettingsPaths(cwd);
    const projectSettingsPath = getProjectSettingsPath(cwd);

    writeSkillFile(sourceSkillDir);
    fs.mkdirSync(path.dirname(globalPath), { recursive: true });
    fs.writeFileSync(
      globalPath,
      JSON.stringify(
        {
          skillToggle: {
            byCwd: {
              [cwd]: {
                disabledSkillPaths: [linkedSkillDir],
                managedOverrides: [`-${linkedSkillDir}`],
                managedSkillLinks: [
                  {
                    name: "Alpha",
                    description: "Alpha skill",
                    path: linkedSkillDir,
                    target: sourceSkillDir,
                  },
                ],
              },
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.mkdirSync(path.dirname(projectSettingsPath), { recursive: true });
    fs.writeFileSync(
      projectSettingsPath,
      JSON.stringify({ skills: [`-${linkedSkillDir}`] }, null, 2),
      "utf-8",
    );

    const { loadToggleState, syncSkillOverrides, toggleSkillLink } =
      await importSkillToggle();
    const state = loadToggleState(cwd);
    const skill = alphaSkill(path.join(linkedSkillDir, "SKILL.md"));
    const result = toggleSkillLink(state, skill);
    syncSkillOverrides(state, [skill], cwd);

    expect(result.status).toBe("enabled");
    expect(fs.lstatSync(linkedSkillDir).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(linkedSkillDir)).toBe(
      fs.realpathSync(sourceSkillDir),
    );

    const entry = readSkillToggleEntry(globalPath, cwd);
    expect(readSettingsFile(projectSettingsPath).skills).toBeUndefined();
    expect(entry.disabledSkillPaths).toBeUndefined();
    expect(entry.managedOverrides).toBeUndefined();
    expect(entry.managedSkillLinks).toBeUndefined();
  });

  it("refuses to disable real skill directories to avoid destructive deletes", async () => {
    createTempHome();
    const cwd = createTempDir("pi-kit-skill-toggle-cwd-");
    const skillDir = path.join(cwd, ".agents", "skills", "alpha");
    writeSkillFile(skillDir);

    const { loadToggleState, toggleSkillLink } = await importSkillToggle();
    const state = loadToggleState(cwd);
    const result = toggleSkillLink(
      state,
      alphaSkill(path.join(skillDir, "SKILL.md")),
    );

    expect(result.status).toBe("not-symlink");
    expect(fs.existsSync(skillDir)).toBe(true);
  });
});

describe("project .agents skill discovery", () => {
  it("formats same-name skills with source and path details", async () => {
    createTempHome();
    const { formatSkillDisplayDetails } = await importSkillToggle();

    expect(
      formatSkillDisplayDetails({
        name: "me-code-simplifier",
        description: "Project skill",
        filePath:
          "/Users/ming.chen/work/video/retrieve/.agents/skills/me-code-simplifier/SKILL.md",
        scope: "project",
      }),
    ).toBe(
      "[project] /Users/ming.chen/work/video/retrieve/.agents/skills/me-code-simplifier",
    );
    expect(
      formatSkillDisplayDetails({
        name: "me-code-simplifier",
        description: "Global skill",
        filePath: path.join(
          os.homedir(),
          ".agents",
          "skills",
          "me-code-simplifier",
          "SKILL.md",
        ),
        scope: "user",
      }),
    ).toBe("[user] $HOME/.agents/skills/me-code-simplifier");
  });

  it("treats a path-disabled skill as disabled without disabling same-name skills", async () => {
    createTempHome();
    const { isSkillDisabledForList } = await importSkillToggle();
    const projectSkill: Skill = {
      name: "me-code-simplifier",
      description: "Project skill",
      filePath: "/repo/.agents/skills/me-code-simplifier/SKILL.md",
      scope: "project",
    };
    const globalSkill: Skill = {
      name: "me-code-simplifier",
      description: "Global skill",
      filePath: path.join(
        os.homedir(),
        ".agents",
        "skills",
        "me-code-simplifier",
        "SKILL.md",
      ),
      scope: "user",
    };

    expect(
      isSkillDisabledForList(
        projectSkill,
        [globalSkill, projectSkill],
        new Set(["me-code-simplifier"]),
        new Set(["/repo/.agents/skills/me-code-simplifier"]),
      ),
    ).toBe(true);
    expect(
      isSkillDisabledForList(
        globalSkill,
        [globalSkill, projectSkill],
        new Set(["me-code-simplifier"]),
        new Set(["/repo/.agents/skills/me-code-simplifier"]),
      ),
    ).toBe(false);
  });

  it("discovers .agents skills from cwd ancestors up to the git root", async () => {
    createTempHome();
    const repoRoot = createTempDir("pi-kit-skill-toggle-repo-");
    const nestedCwd = path.join(repoRoot, "packages", "app");
    const skillDir = path.join(repoRoot, ".agents", "skills", "project-only");
    fs.mkdirSync(nestedCwd, { recursive: true });
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: project-only",
        "description: Project skill from .agents",
        "---",
        "",
      ].join("\n"),
      "utf-8",
    );

    const { runGit } = await import("../shared/git.js");
    runGit(repoRoot, ["init"]);

    const skillToggle = await importSkillToggle();
    const loadSkills = (
      skillToggle as {
        loadSkills?: (cwd: string) => Skill[];
      }
    ).loadSkills;

    expect(loadSkills).toBeDefined();
    expect(loadSkills?.(nestedCwd)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "project-only",
          description: "Project skill from .agents",
          filePath: path.join(skillDir, "SKILL.md"),
          scope: "project",
        }),
      ]),
    );
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
