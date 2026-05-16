import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSettingsPaths, readSettingsFile } from "../shared/settings.js";
import type { Skill, SkillTogglePicker } from "./index.js";

const tempDirs: string[] = [];
const originalHome = process.env.HOME;
const originalCwd = process.cwd();
const ARROW_DOWN = "\x1b[B";
const ARROW_UP = "\x1b[A";

// ANSI escape helpers for assertion readability
const ansi = (code: string, text: string) => `\x1b[${code}m${text}\x1b[0m`;
const ENABLED = (text: string) => ansi("32", text);
const SELECTED_TEXT = (text: string) => ansi("1;96", text);
const RED = (text: string) => ansi("31", text);
const MAGENTA = (text: string) => ansi("35", text);

const registerTempDir = (dir: string): string => {
  tempDirs.push(dir);
  return dir;
};

const createTempDir = (prefix: string): string =>
  registerTempDir(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

const createTempHome = (): void => {
  const dir = createTempDir("pi-kit-skill-toggle-home-");
  process.env.HOME = dir;
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

function getProjectSettingsPath(cwd: string): string {
  return path.join(cwd, ".pi", "settings.json");
}

function getManagedSkillDir(cwd: string, name: string): string {
  return path.join(cwd, ".pi", "skills", name);
}

function getDiscoveredSkillDir(cwd: string, name: string): string {
  return path.join(cwd, ".agents", "skills", name);
}

function expectSymlinkTarget(linkPath: string, targetPath: string): void {
  expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
  expect(fs.realpathSync(linkPath)).toBe(fs.realpathSync(targetPath));
}

function writeSkillFile(skillDir: string): void {
  writeNamedSkillFile(skillDir, "Alpha", "Alpha skill");
}

function writeNamedSkillFile(
  skillDir: string,
  name: string,
  description: string,
): void {
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n`,
  );
}

function writeLibrarySkill(name: string, description: string): string {
  const skillDir = path.join(os.homedir(), ".agents", "me-skills", name);
  writeNamedSkillFile(skillDir, name, description);
  return skillDir;
}

function writeGlobalSkillToggleEntry(
  cwd: string,
  entry: Record<string, unknown>,
): string {
  const { globalPath } = getSettingsPaths(cwd);
  fs.mkdirSync(path.dirname(globalPath), { recursive: true });
  fs.writeFileSync(
    globalPath,
    JSON.stringify({ skillToggle: { byCwd: { [cwd]: entry } } }, null, 2),
    "utf-8",
  );
  return globalPath;
}

function alphaSkill(filePath: string): Skill {
  return {
    name: "Alpha",
    description: "Alpha skill",
    filePath,
    scope: "project",
  };
}

function namedPickerSkills(...names: string[]): Skill[] {
  return names.map((name) => ({
    name,
    description: "",
    filePath: `/repo/.agents/skills/${name}/SKILL.md`,
  }));
}

async function createTestPicker(
  skills: Skill[] = namedPickerSkills("alpha", "jira"),
  enabledNames: string[] = [],
): Promise<{ picker: SkillTogglePicker; toggled: string[] }> {
  const { SkillTogglePicker } = await importSkillToggle();
  const toggled: string[] = [];
  const picker = new SkillTogglePicker(
    skills,
    new Set(enabledNames),
    (skill) => toggled.push(skill.name),
    () => undefined,
    () => undefined,
  );
  return { picker, toggled };
}

function writeSkillToggleTheme(
  home: string,
  theme: Record<string, string>,
): void {
  const themePath = path.join(
    home,
    ".pi",
    "agent",
    "extensions",
    "skill-toggle",
    "theme.json",
  );
  fs.mkdirSync(path.dirname(themePath), { recursive: true });
  fs.writeFileSync(themePath, JSON.stringify(theme), "utf-8");
}

afterEach(() => {
  restoreHome();
  process.chdir(originalCwd);
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  createTempHome();
});

describe("settings integration", () => {
  it("uses primary repo cwd when running from a worktree cwd", async () => {
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
      const { loadToggleState } = await importSkillToggle();
      const state = loadToggleState(worktreeCwd);

      expect(state.cwdKey).toBe(primaryRepoCwd);
      expect(state.cwd).toBe(primaryRepoCwd);
      expect(state.writePath).toBe(globalPath);
    } finally {
      vi.doUnmock("../shared/git.js");
    }
  });

  it("derives enabled skills from discovered libraries plus .pi links", async () => {
    const cwd = createTempDir("pi-kit-skill-toggle-cwd-");
    const sourceSkillDir = path.join(
      createTempDir("pi-kit-skill-toggle-source-"),
      "alpha",
    );
    writeLibrarySkill("Beta", "Beta skill");
    writeSkillFile(sourceSkillDir);
    fs.mkdirSync(path.dirname(getManagedSkillDir(cwd, "alpha")), {
      recursive: true,
    });
    fs.symlinkSync(sourceSkillDir, getManagedSkillDir(cwd, "alpha"));

    const { loadToggleState } = await importSkillToggle();
    const state = loadToggleState(cwd);

    expect(state.enabledSkills.has("alpha")).toBe(true);
    expect(state.enabledSkills.has("beta")).toBe(true);
  });

  it("defaults brainstorming and opencli skills to disabled", async () => {
    const cwd = createTempDir("pi-kit-skill-toggle-cwd-");
    const { DEFAULT_DISABLED_SKILL_NAMES, loadToggleState } =
      await importSkillToggle();
    const defaultDisabledSkills = Array.from(DEFAULT_DISABLED_SKILL_NAMES);
    for (const name of defaultDisabledSkills) {
      writeLibrarySkill(name, `${name} skill`);
    }
    writeLibrarySkill("alpha", "Alpha skill");

    const state = loadToggleState(cwd);

    expect(state.enabledSkills.has("alpha")).toBe(true);
    for (const name of defaultDisabledSkills) {
      expect(state.enabledSkills.has(name)).toBe(false);
    }
  });

  it("persists disabling a default-enabled library skill", async () => {
    const cwd = createTempDir("pi-kit-skill-toggle-cwd-");
    const skillDir = writeLibrarySkill("alpha", "Alpha skill");

    const { loadToggleState, toggleSkillLink } = await importSkillToggle();
    const state = loadToggleState(cwd);
    const result = toggleSkillLink(state, {
      name: "alpha",
      description: "Alpha skill",
      filePath: path.join(skillDir, "SKILL.md"),
      scope: "user",
    });

    expect(result.status).toBe("disabled");
    expect(loadToggleState(cwd).enabledSkills.has("alpha")).toBe(false);
  });
});

describe("project managed skill symlinks", () => {
  it("enables a library skill by creating a managed .pi symlink and recording state", async () => {
    const cwd = createTempDir("pi-kit-skill-toggle-cwd-");
    const sourceSkillDir = path.join(
      createTempDir("pi-kit-skill-toggle-source-"),
      "alpha",
    );
    const managedSkillDir = getManagedSkillDir(cwd, "Alpha");
    const discoveredSkillDir = getDiscoveredSkillDir(cwd, "Alpha");

    writeSkillFile(sourceSkillDir);

    const { loadToggleState, toggleSkillLink } = await importSkillToggle();
    const state = loadToggleState(cwd);
    const result = toggleSkillLink(
      state,
      alphaSkill(path.join(sourceSkillDir, "SKILL.md")),
    );

    expect(result.status).toBe("enabled");
    expectSymlinkTarget(managedSkillDir, sourceSkillDir);
    expect(fs.existsSync(discoveredSkillDir)).toBe(false);
    expect(
      readSettingsFile(getProjectSettingsPath(cwd)).skills,
    ).toBeUndefined();
  });

  it("uses the skill frontmatter name for managed symlink directories", async () => {
    const cwd = createTempDir("pi-kit-skill-toggle-cwd-");
    const sourceSkillDir = path.join(
      createTempDir("pi-kit-skill-toggle-source-"),
      "software-design-philosophy-skill",
    );
    const skillName = "software-design-philosophy";
    writeNamedSkillFile(sourceSkillDir, skillName, "Design philosophy skill");

    const { loadToggleState, toggleSkillLink } = await importSkillToggle();
    const state = loadToggleState(cwd);
    const result = toggleSkillLink(state, {
      name: skillName,
      description: "Design philosophy skill",
      filePath: path.join(sourceSkillDir, "SKILL.md"),
      scope: "user",
    });

    expect(result.status).toBe("enabled");
    expectSymlinkTarget(getManagedSkillDir(cwd, skillName), sourceSkillDir);
    expect(
      fs.existsSync(
        getManagedSkillDir(cwd, "software-design-philosophy-skill"),
      ),
    ).toBe(false);
  });

  it("disables only managed .pi skill symlinks", async () => {
    const cwd = createTempDir("pi-kit-skill-toggle-cwd-");
    const sourceSkillDir = path.join(
      createTempDir("pi-kit-skill-toggle-source-"),
      "alpha",
    );
    const managedSkillDir = getManagedSkillDir(cwd, "Alpha");

    writeSkillFile(sourceSkillDir);
    const { loadToggleState, toggleSkillLink } = await importSkillToggle();
    const state = loadToggleState(cwd);
    const skill = alphaSkill(path.join(sourceSkillDir, "SKILL.md"));
    expect(toggleSkillLink(state, skill).status).toBe("enabled");

    const result = toggleSkillLink(state, skill);

    expect(result.status).toBe("disabled");
    expect(fs.existsSync(managedSkillDir)).toBe(false);
  });

  it("does not overwrite an existing project skill directory", async () => {
    const cwd = createTempDir("pi-kit-skill-toggle-cwd-");
    const sourceSkillDir = path.join(
      createTempDir("pi-kit-skill-toggle-source-"),
      "alpha",
    );
    const discoveredSkillDir = getDiscoveredSkillDir(cwd, "Alpha");

    writeSkillFile(sourceSkillDir);
    writeSkillFile(discoveredSkillDir);

    const { loadToggleState, toggleSkillLink } = await importSkillToggle();
    const state = loadToggleState(cwd);
    const result = toggleSkillLink(
      state,
      alphaSkill(path.join(sourceSkillDir, "SKILL.md")),
    );

    expect(result).toEqual({ status: "conflict", path: discoveredSkillDir });
    expect(fs.lstatSync(discoveredSkillDir).isDirectory()).toBe(true);
    expect(fs.existsSync(getManagedSkillDir(cwd, "Alpha"))).toBe(false);
  });

  it("coexists with different existing project skills", async () => {
    const cwd = createTempDir("pi-kit-skill-toggle-cwd-");
    const sourceSkillDir = path.join(
      createTempDir("pi-kit-skill-toggle-source-"),
      "alpha",
    );
    const projectSkillDir = getDiscoveredSkillDir(cwd, "cc-reader");

    writeSkillFile(sourceSkillDir);
    writeNamedSkillFile(projectSkillDir, "cc-reader", "Project reader");

    const { loadToggleState, toggleSkillLink } = await importSkillToggle();
    const state = loadToggleState(cwd);
    const result = toggleSkillLink(
      state,
      alphaSkill(path.join(sourceSkillDir, "SKILL.md")),
    );

    expect(result.status).toBe("enabled");
    expect(fs.lstatSync(projectSkillDir).isDirectory()).toBe(true);
    expectSymlinkTarget(getManagedSkillDir(cwd, "Alpha"), sourceSkillDir);
    expect(fs.existsSync(getDiscoveredSkillDir(cwd, "Alpha"))).toBe(false);
  });

  it("treats same-skill project symlinks as already discoverable", async () => {
    const cwd = createTempDir("pi-kit-skill-toggle-cwd-");
    const sourceSkillDir = path.join(
      createTempDir("pi-kit-skill-toggle-source-"),
      "alpha",
    );
    const managedSkillDir = getManagedSkillDir(cwd, "Alpha");
    const discoveredSkillDir = getDiscoveredSkillDir(cwd, "Alpha");

    writeSkillFile(sourceSkillDir);
    fs.mkdirSync(path.dirname(discoveredSkillDir), { recursive: true });
    fs.symlinkSync(sourceSkillDir, discoveredSkillDir);

    const { loadToggleState, toggleSkillLink } = await importSkillToggle();
    const state = loadToggleState(cwd);
    const result = toggleSkillLink(
      state,
      alphaSkill(path.join(sourceSkillDir, "SKILL.md")),
    );

    expect(result.status).toBe("already-enabled");
    expectSymlinkTarget(managedSkillDir, sourceSkillDir);
    expectSymlinkTarget(discoveredSkillDir, sourceSkillDir);
  });

  it("does not delete same-skill project symlinks on disable", async () => {
    const cwd = createTempDir("pi-kit-skill-toggle-cwd-");
    const sourceSkillDir = path.join(
      createTempDir("pi-kit-skill-toggle-source-"),
      "alpha",
    );
    const managedSkillDir = getManagedSkillDir(cwd, "Alpha");
    const discoveredSkillDir = getDiscoveredSkillDir(cwd, "Alpha");

    writeSkillFile(sourceSkillDir);
    fs.mkdirSync(path.dirname(discoveredSkillDir), { recursive: true });
    fs.symlinkSync(sourceSkillDir, discoveredSkillDir);

    const { loadToggleState, toggleSkillLink } = await importSkillToggle();
    const state = loadToggleState(cwd);
    const skill = alphaSkill(path.join(sourceSkillDir, "SKILL.md"));
    expect(toggleSkillLink(state, skill).status).toBe("already-enabled");

    const result = toggleSkillLink(state, skill);

    expect(result).toEqual({ status: "disabled" });
    expect(fs.existsSync(managedSkillDir)).toBe(false);
    expectSymlinkTarget(discoveredSkillDir, sourceSkillDir);
  });
});

describe("skill library discovery", () => {
  it("discovers skills from ~/.agents/git-skills and ~/.agents/me-skills", async () => {
    const home = os.homedir();
    const cwd = createTempDir("pi-kit-skill-toggle-cwd-");
    const gitSkillDir = path.join(home, ".agents", "git-skills", "review");
    const meSkillFile = path.join(home, ".agents", "me-skills", "direct.md");
    writeNamedSkillFile(gitSkillDir, "review", "Review skill");
    fs.mkdirSync(path.dirname(meSkillFile), { recursive: true });
    fs.writeFileSync(
      meSkillFile,
      "---\nname: direct\ndescription: Direct skill\n---\n",
      "utf-8",
    );

    const { loadSkills } = await importSkillToggle();

    expect(loadSkills(cwd)).toEqual([
      expect.objectContaining({
        name: "direct",
        description: "Direct skill",
        filePath: meSkillFile,
        scope: "user",
      }),
      expect.objectContaining({
        name: "review",
        description: "Review skill",
        filePath: path.join(gitSkillDir, "SKILL.md"),
        scope: "user",
      }),
    ]);
  });

  it("does not recurse below a discovered SKILL.md skill root", async () => {
    const home = os.homedir();
    const cwd = createTempDir("pi-kit-skill-toggle-cwd-");
    const rootSkillDir = path.join(home, ".agents", "git-skills", "root-skill");
    writeNamedSkillFile(rootSkillDir, "root-skill", "Root skill");
    writeNamedSkillFile(
      path.join(rootSkillDir, "nested"),
      "nested-skill",
      "Nested skill",
    );

    const { loadSkills } = await importSkillToggle();
    const names = loadSkills(cwd).map((skill) => skill.name);

    expect(names).toContain("root-skill");
    expect(names).not.toContain("nested-skill");
  });

  it("deduplicates skills that resolve to the same real file", async () => {
    const home = os.homedir();
    const cwd = createTempDir("pi-kit-skill-toggle-cwd-");
    const sourceSkillDir = path.join(
      createTempDir("pi-kit-skill-toggle-source-"),
      "shared-skill",
    );
    const linkedSkillDir = path.join(
      home,
      ".agents",
      "git-skills",
      "shared-skill",
    );
    writeNamedSkillFile(sourceSkillDir, "shared-skill", "Shared skill");
    fs.mkdirSync(path.dirname(linkedSkillDir), { recursive: true });
    fs.symlinkSync(sourceSkillDir, linkedSkillDir);

    const { loadSkills } = await importSkillToggle();
    const matching = loadSkills(cwd).filter(
      (skill) => skill.name === "shared-skill",
    );

    expect(matching).toHaveLength(1);
  });

  it("formats same-name skills with source and path details", async () => {
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

  it("uses project skills when disabling same-name global skills", async () => {
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
        new Set(),
      ),
    ).toBe(false);
    expect(
      isSkillDisabledForList(
        globalSkill,
        [globalSkill, projectSkill],
        new Set(["me-code-simplifier"]),
        new Set(),
      ),
    ).toBe(true);
  });
});

describe("skill picker render", () => {
  it("shows text status, short scope, and skill details in each row", async () => {
    const { picker } = await createTestPicker(
      [
        {
          name: "alpha",
          description: "Alpha user skill",
          filePath: "/repo/.agents/skills/alpha/SKILL.md",
          scope: "user",
        },
        {
          name: "beta",
          description: "Beta project skill",
          filePath: "/repo/.agents/skills/beta/SKILL.md",
          scope: "project",
        },
      ],
      ["beta"],
    );

    const output = picker.render(80).join("\n");

    expect(output).toContain("OFF");
    expect(output).toContain(ENABLED("ON"));
    expect(output).toContain("[u]");
    expect(output).toContain("[p]");
    expect(output).toContain("Alpha user skill");
    expect(output).toContain("Beta project skill");
    expect(output).not.toContain("/repo/.agents/skills/alpha");
    expect(output).toContain(ENABLED("beta"));
    expect(output).toContain(SELECTED_TEXT("alpha"));
    expect(output).not.toContain(RED("ON"));
  });

  it("uses fallback scope markers for temporary and unknown skills", async () => {
    const { picker } = await createTestPicker([
      {
        name: "temporary-skill",
        description: "Temporary skill",
        filePath: "/repo/.agents/skills/temporary-skill/SKILL.md",
        scope: "temporary",
      },
      {
        name: "unknown-skill",
        description: "Unknown skill",
        filePath: "/repo/.agents/skills/unknown-skill/SKILL.md",
        scope: "external" as Skill["scope"],
      },
    ]);

    const output = picker.render(80).join("\n");

    expect(output).toContain("[t]");
    expect(output).toContain("[?]");
  });

  it("uses enabledStatus theme overrides for enabled skill status", async () => {
    writeSkillToggleTheme(os.homedir(), { enabledStatus: "35" });
    const { picker } = await createTestPicker(namedPickerSkills("alpha"), [
      "alpha",
    ]);

    expect(picker.render(80).join("\n")).toContain(MAGENTA("ON"));
  });

  it("ignores legacy disabled theme overrides", async () => {
    writeSkillToggleTheme(os.homedir(), { disabled: "35" });
    const { picker } = await createTestPicker(namedPickerSkills("alpha"), [
      "alpha",
    ]);

    const output = picker.render(80).join("\n");

    expect(output).toContain(ENABLED("ON"));
    expect(output).not.toContain(MAGENTA("ON"));
  });
});

describe("skill picker input", () => {
  it("treats plain j and k as filter text", async () => {
    const { picker, toggled } = await createTestPicker(
      namedPickerSkills("alpha", "jira", "kilo"),
    );

    picker.handleInput("j");
    picker.handleInput("\r");

    expect(toggled).toEqual(["jira"]);

    picker.handleInput("\b");
    picker.handleInput("k");
    picker.handleInput("\r");

    expect(toggled).toEqual(["jira", "kilo"]);
  });

  it("uses arrow up and arrow down for navigation", async () => {
    const { picker, toggled } = await createTestPicker();

    picker.handleInput(ARROW_DOWN);
    picker.handleInput("\r");
    picker.handleInput(ARROW_UP);
    picker.handleInput("\r");

    expect(toggled).toEqual(["jira", "alpha"]);
  });
});

describe("legacy settings cleanup", () => {
  it("removes legacy skillToggle settings", async () => {
    const cwd = createTempDir("pi-kit-skill-toggle-cwd-");
    const skillPath = path.join(cwd, ".agents", "skills", "alpha", "SKILL.md");
    const globalPath = writeGlobalSkillToggleEntry(cwd, {
      managedSkills: ["Alpha", "Ghost"],
    });

    const { pruneSettingsFiles } = await importSkillToggle();
    pruneSettingsFiles(cwd, [alphaSkill(skillPath)]);

    expect(readSettingsFile(globalPath).skillToggle).toBeUndefined();
  });
});

describe("input interception", () => {
  it("does not register input interception", async () => {
    const cwd = createTempDir("pi-kit-skill-toggle-cwd-");
    const skillPath = path.join(cwd, ".agents", "skills", "alpha", "SKILL.md");
    writeGlobalSkillToggleEntry(cwd, {
      managedSkills: ["alpha"],
    });
    const skillToggle = await importSkillToggle();
    const sessionStartHandlers: Array<
      (event: unknown, ctx: unknown) => unknown
    > = [];
    const pi = {
      getCommands: vi.fn(() => [
        {
          source: "skill",
          name: "skill:Alpha",
          description: "Alpha skill",
          sourceInfo: { path: skillPath, scope: "project" },
        },
      ]),
      registerCommand: vi.fn(),
      on: vi.fn(
        (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
          if (name === "session_start") sessionStartHandlers.push(handler);
        },
      ),
    };
    const ctx = {
      cwd,
      hasUI: false,
      ui: {
        notify: vi.fn(),
        setStatus: vi.fn(),
      },
    };

    skillToggle.default(pi as never);
    expect(sessionStartHandlers).toHaveLength(1);
    const handleSessionStart = sessionStartHandlers[0];

    await handleSessionStart({}, ctx);

    expect(pi.on).not.toHaveBeenCalledWith("input", expect.any(Function));
    expect(pi.getCommands).not.toHaveBeenCalled();
  });

  it("blocks path-disabled skill commands before reload", async () => {
    const { getDisabledSkillCommandForInput } = await importSkillToggle();
    const skill: Skill = {
      name: "Alpha",
      description: "Alpha skill",
      filePath: "/repo/.agents/skills/alpha/SKILL.md",
      scope: "project",
    };

    expect(
      getDisabledSkillCommandForInput(
        "/skill:Alpha",
        [skill],
        new Set(),
        new Set(["/repo/.agents/skills/alpha"]),
      ),
    ).toBe("alpha");
  });
});

describe("formatDisabledSkillsMessage", () => {
  it("returns an empty-state message when no installed managed skills exist", async () => {
    const { formatDisabledSkillsMessage } = await importSkillToggle();

    expect(formatDisabledSkillsMessage(new Set(), [])).toBe(
      "No enabled managed skills",
    );
  });

  it("formats managed skills using canonical skill names", async () => {
    const { formatDisabledSkillsMessage } = await importSkillToggle();

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
      formatDisabledSkillsMessage(new Set(["beta skill", "alpha"]), skills),
    ).toBe("Enabled managed skills (2): Alpha, Beta Skill");
  });

  it("omits stale managed skills that are no longer installed", async () => {
    const { formatDisabledSkillsMessage } = await importSkillToggle();

    const skills: Skill[] = [
      {
        name: "Alpha",
        description: "",
        filePath: "/tmp/alpha/SKILL.md",
      },
    ];

    expect(
      formatDisabledSkillsMessage(new Set(["ghost", "alpha"]), skills),
    ).toBe("Enabled managed skills (1): Alpha");
  });
});

describe("parseFrontmatter", () => {
  it("parses multi-line description blocks", async () => {
    const { parseFrontmatter } = await importSkillToggle();

    const content = [
      "---",
      "name: office-hours",
      "description: |",
      "  Founder-style office hours to clarify the problem, users, and wedge before any code is written.",
      "  Runs in Startup or Builder mode.",
      "---",
      "",
    ].join("\n");

    const result = parseFrontmatter(content, "fallback");

    expect(result).toEqual({
      name: "office-hours",
      description:
        "Founder-style office hours to clarify the problem, users, and wedge before any code is written. Runs in Startup or Builder mode.",
    });
  });
});
