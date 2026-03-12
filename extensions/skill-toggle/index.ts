/**
 * /toggle-skill
 *
 * Toggle skills in the system prompt at runtime.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@mariozechner/pi-tui";

interface Skill {
  name: string;
  description: string;
  filePath: string;
}

interface SkillToggleSettings {
  disabledSkills?: string[];
}

interface ToggleState {
  disabledSkills: Set<string>;
  writePath: string;
}

interface PaletteTheme {
  border: string;
  title: string;
  selected: string;
  selectedText: string;
  disabled: string;
  searchIcon: string;
  placeholder: string;
  description: string;
  hint: string;
}

const DEFAULT_THEME: PaletteTheme = {
  border: "2",
  title: "2",
  selected: "36",
  selectedText: "36",
  disabled: "31",
  searchIcon: "2",
  placeholder: "2;3",
  description: "2",
  hint: "2",
};

const SETTINGS_FILE_NAME = "settings.json";

const SKILL_TAG_REGEX = /<skill\s+[^>]*name="([^"]+)"[^>]*>[\s\S]*?<\/skill>/gi;

const SKILL_DIRS: {
  dir: (cwd: string) => string;
  format: "recursive" | "claude";
}[] = [
  {
    dir: () => path.join(os.homedir(), ".codex", "skills"),
    format: "recursive",
  },
  { dir: () => path.join(os.homedir(), ".claude", "skills"), format: "claude" },
  { dir: (cwd) => path.join(cwd, ".claude", "skills"), format: "claude" },
  {
    dir: () => path.join(os.homedir(), ".pi", "agent", "skills"),
    format: "recursive",
  },
  { dir: () => path.join(os.homedir(), ".pi", "skills"), format: "recursive" },
  { dir: (cwd) => path.join(cwd, ".pi", "skills"), format: "recursive" },
];

const paletteTheme = loadTheme();

function fg(code: string, text: string): string {
  if (!code) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

function loadTheme(): PaletteTheme {
  const configPath = path.join(
    os.homedir(),
    ".pi",
    "agent",
    "extensions",
    "skill-toggle",
    "theme.json",
  );
  try {
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, "utf-8");
      const custom = JSON.parse(content) as Partial<PaletteTheme>;
      return { ...DEFAULT_THEME, ...custom };
    }
  } catch {
    // Ignore errors, use default
  }
  return DEFAULT_THEME;
}

function loadSkills(cwd: string): Skill[] {
  const skillsByName = new Map<string, Skill>();

  for (const { dir, format } of SKILL_DIRS) {
    scanSkillDir(dir(cwd), format, skillsByName);
  }

  return Array.from(skillsByName.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

function scanSkillDir(
  dir: string,
  format: "recursive" | "claude",
  skillsByName: Map<string, Skill>,
  visitedDirs?: Set<string>,
): void {
  if (!fs.existsSync(dir)) return;

  const visited = visitedDirs ?? new Set<string>();
  let realDir: string;
  try {
    realDir = fs.realpathSync(dir);
  } catch {
    realDir = dir;
  }
  if (visited.has(realDir)) return;
  visited.add(realDir);

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.name === "node_modules") continue;

      const entryPath = path.join(dir, entry.name);

      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const stats = fs.statSync(entryPath);
          isDirectory = stats.isDirectory();
          isFile = stats.isFile();
        } catch {
          continue;
        }
      }

      if (format === "recursive") {
        if (isDirectory) {
          scanSkillDir(entryPath, format, skillsByName, visited);
        } else if (isFile && entry.name === "SKILL.md") {
          loadSkillFromFile(entryPath, skillsByName);
        }
      } else if (format === "claude") {
        if (!isDirectory) continue;
        const skillFile = path.join(entryPath, "SKILL.md");
        if (!fs.existsSync(skillFile)) continue;
        loadSkillFromFile(skillFile, skillsByName);
      }
    }
  } catch {
    // Ignore inaccessible directories
  }
}

function loadSkillFromFile(
  filePath: string,
  skillsByName: Map<string, Skill>,
): void {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const skillDir = path.dirname(filePath);
    const parentDirName = path.basename(skillDir);
    const { name, description } = parseFrontmatter(content, parentDirName);

    if (description && !skillsByName.has(name)) {
      skillsByName.set(name, { name, description, filePath });
    }
  } catch {
    // Ignore invalid skill files
  }
}

function parseFrontmatter(
  content: string,
  fallbackName: string,
): { name: string; description: string } {
  if (!content.startsWith("---")) {
    return { name: fallbackName, description: "" };
  }

  const endIndex = content.indexOf("\n---", 3);
  if (endIndex === -1) {
    return { name: fallbackName, description: "" };
  }

  const frontmatter = content.slice(4, endIndex);
  let name = fallbackName;
  let description = "";

  for (const line of frontmatter.split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();

    if (key === "name") name = value;
    if (key === "description") description = value;
  }

  return { name, description };
}

function fuzzyScore(query: string, text: string): number {
  const lowerQuery = query.toLowerCase();
  const lowerText = text.toLowerCase();

  if (lowerText.includes(lowerQuery)) {
    return 100 + (lowerQuery.length / lowerText.length) * 50;
  }

  let score = 0;
  let queryIndex = 0;
  let consecutiveBonus = 0;

  for (let i = 0; i < lowerText.length && queryIndex < lowerQuery.length; i++) {
    if (lowerText[i] === lowerQuery[queryIndex]) {
      score += 10 + consecutiveBonus;
      consecutiveBonus += 5;
      queryIndex++;
    } else {
      consecutiveBonus = 0;
    }
  }

  return queryIndex === lowerQuery.length ? score : 0;
}

function filterSkills(skills: Skill[], query: string): Skill[] {
  if (!query.trim()) return skills;

  const scored = skills
    .map((skill) => ({
      skill,
      score: Math.max(
        fuzzyScore(query, skill.name),
        fuzzyScore(query, skill.description) * 0.8,
      ),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.map((item) => item.skill);
}

function getSettingsPaths(cwd: string): {
  projectPath: string;
  globalPath: string;
} {
  return {
    projectPath: path.join(cwd, ".pi", SETTINGS_FILE_NAME),
    globalPath: path.join(os.homedir(), ".pi", "agent", SETTINGS_FILE_NAME),
  };
}

function loadSettingsFile(filePath: string): Record<string, unknown> {
  try {
    if (!fs.existsSync(filePath)) return {};
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function extractSkillToggle(
  settings: Record<string, unknown>,
): SkillToggleSettings | null {
  const raw = settings.skillToggle as SkillToggleSettings | undefined;
  if (!raw) return null;
  return raw;
}

function toSkillList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const items = value.filter((item) => typeof item === "string");
  return items.length ? items : [];
}

function loadToggleState(cwd: string): ToggleState {
  const { projectPath, globalPath } = getSettingsPaths(cwd);
  const projectSettings = loadSettingsFile(projectPath);
  const globalSettings = loadSettingsFile(globalPath);

  const projectToggle = extractSkillToggle(projectSettings);
  const globalToggle = extractSkillToggle(globalSettings);

  const projectDisabled = toSkillList(projectToggle?.disabledSkills);
  const globalDisabled = toSkillList(globalToggle?.disabledSkills);

  const disabledSkills = projectDisabled ?? globalDisabled ?? [];
  const writePath = fs.existsSync(projectPath) ? projectPath : globalPath;

  return {
    disabledSkills: new Set(disabledSkills),
    writePath,
  };
}

function saveToggleState(state: ToggleState, settingsPath: string): void {
  const settings = loadSettingsFile(settingsPath);
  settings.skillToggle = {
    disabledSkills: Array.from(state.disabledSkills).sort(),
  };

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

function formatDisabledList(disabled: string[], maxWidth: number): string {
  if (disabled.length === 0) return "Disabled: none";
  const label = `Disabled (${disabled.length}): ${disabled.join(", ")}`;
  return truncateToWidth(label, maxWidth, "…", true);
}

function updateStatus(ctx: ExtensionContext, disabledCount: number): void {
  if (!ctx.hasUI) return;
  if (disabledCount === 0) {
    ctx.ui.setStatus("skill-toggle", undefined);
    return;
  }
  ctx.ui.setStatus("skill-toggle", `Skill toggle: ${disabledCount} disabled`);
}

function filterSystemPrompt(prompt: string, disabled: Set<string>): string {
  if (disabled.size === 0) return prompt;

  return prompt.replace(SKILL_TAG_REGEX, (match, name) => {
    if (disabled.has(name)) return "";
    return match;
  });
}

class SkillTogglePalette {
  private filtered: Skill[];
  private selected = 0;
  private query = "";
  private inactivityTimeout: ReturnType<typeof setTimeout> | null = null;
  private static readonly INACTIVITY_MS = 60000;

  constructor(
    private skills: Skill[],
    private disabled: Set<string>,
    private onToggle: (skill: Skill) => void,
    private onClose: () => void,
  ) {
    this.filtered = skills;
    this.resetInactivityTimeout();
  }

  private resetInactivityTimeout(): void {
    if (this.inactivityTimeout) clearTimeout(this.inactivityTimeout);
    this.inactivityTimeout = setTimeout(() => {
      this.cleanup();
      this.onClose();
    }, SkillTogglePalette.INACTIVITY_MS);
  }

  handleInput(data: string): void {
    this.resetInactivityTimeout();

    if (matchesKey(data, "escape")) {
      this.cleanup();
      this.onClose();
      return;
    }

    if (matchesKey(data, "return")) {
      const skill = this.filtered[this.selected];
      if (skill) {
        this.onToggle(skill);
      }
      return;
    }

    if (data === "k") {
      if (this.filtered.length > 0) {
        this.selected =
          this.selected === 0 ? this.filtered.length - 1 : this.selected - 1;
      }
      return;
    }

    if (data === "j") {
      if (this.filtered.length > 0) {
        this.selected =
          this.selected === this.filtered.length - 1 ? 0 : this.selected + 1;
      }
      return;
    }

    if (matchesKey(data, "backspace")) {
      if (this.query.length > 0) {
        this.query = this.query.slice(0, -1);
        this.updateFilter();
      }
      return;
    }

    if (data.length === 1 && data.charCodeAt(0) >= 32) {
      this.query += data;
      this.updateFilter();
    }
  }

  private updateFilter(): void {
    this.filtered = filterSkills(this.skills, this.query);
    this.selected = 0;
  }

  render(width: number): string[] {
    const innerW = width - 2;
    const lines: string[] = [];

    const t = paletteTheme;
    const border = (s: string) => fg(t.border, s);
    const title = (s: string) => fg(t.title, s);
    const selected = (s: string) => fg(t.selected, s);
    const selectedText = (s: string) => fg(t.selectedText, s);
    const disabled = (s: string) => fg(t.disabled, s);
    const searchIcon = (s: string) => fg(t.searchIcon, s);
    const placeholder = (s: string) => fg(t.placeholder, s);
    const description = (s: string) => fg(t.description, s);
    const hint = (s: string) => fg(t.hint, s);
    const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
    const italic = (s: string) => `\x1b[3m${s}\x1b[23m`;

    const row = (content: string) =>
      border("│") +
      truncateToWidth(` ${content}`, innerW, "…", true) +
      border("│");
    const emptyRow = () => border("│") + " ".repeat(innerW) + border("│");

    const titleText = " Skill Toggle ";
    const borderLen = innerW - visibleWidth(titleText);
    const leftBorder = Math.floor(borderLen / 2);
    const rightBorder = borderLen - leftBorder;
    lines.push(
      border(`╭${"─".repeat(leftBorder)}`) +
        title(titleText) +
        border(`${"─".repeat(rightBorder)}╮`),
    );

    lines.push(emptyRow());

    const cursor = selected("│");
    const searchIconChar = searchIcon("◎");
    const queryDisplay = this.query
      ? `${this.query}${cursor}`
      : `${cursor}${placeholder(italic("type to filter..."))}`;
    lines.push(row(`${searchIconChar}  ${queryDisplay}`));

    lines.push(emptyRow());
    lines.push(border(`├${"─".repeat(innerW)}┤`));

    const maxVisible = 8;
    const startIndex = Math.max(
      0,
      Math.min(
        this.selected - Math.floor(maxVisible / 2),
        this.filtered.length - maxVisible,
      ),
    );
    const endIndex = Math.min(startIndex + maxVisible, this.filtered.length);

    if (this.filtered.length === 0) {
      lines.push(emptyRow());
      lines.push(row(hint(italic("No matching skills"))));
      lines.push(emptyRow());
    } else {
      lines.push(emptyRow());
      for (let i = startIndex; i < endIndex; i++) {
        const skill = this.filtered[i];
        const isSelected = i === this.selected;
        const isDisabled = this.disabled.has(skill.name);

        const prefix = isSelected ? selected("▸") : border("·");
        const disabledBadge = isDisabled ? ` ${disabled("⨯")}` : "";
        const nameStr = isSelected
          ? bold(selectedText(skill.name))
          : isDisabled
            ? disabled(skill.name)
            : skill.name;
        const maxDescLen = Math.max(0, innerW - visibleWidth(skill.name) - 12);
        const descStr =
          maxDescLen > 3
            ? description(truncateToWidth(skill.description, maxDescLen, "…"))
            : "";
        const separator = descStr ? `  ${border("—")}  ` : "";
        const skillLine = `${prefix} ${nameStr}${disabledBadge}${separator}${descStr}`;
        lines.push(row(skillLine));
      }
      lines.push(emptyRow());
    }

    lines.push(border(`├${"─".repeat(innerW)}┤`));
    lines.push(emptyRow());

    const disabledList = formatDisabledList(
      Array.from(this.disabled).sort(),
      innerW - 1,
    );
    lines.push(row(hint(disabledList)));

    lines.push(emptyRow());
    lines.push(border(`├${"─".repeat(innerW)}┤`));
    lines.push(emptyRow());

    const hints = `${italic("j/k")} navigate  ${italic("enter")} toggle  ${italic("esc")} cancel`;
    lines.push(row(hint(hints)));

    lines.push(border(`╰${"─".repeat(innerW)}╯`));

    return lines;
  }

  private cleanup(): void {
    if (this.inactivityTimeout) {
      clearTimeout(this.inactivityTimeout);
      this.inactivityTimeout = null;
    }
  }

  invalidate(): void {}

  dispose(): void {
    this.cleanup();
  }
}

export default function skillToggleExtension(pi: ExtensionAPI): void {
  let state: ToggleState = loadToggleState(process.cwd());

  const refreshState = (ctx: ExtensionContext) => {
    state = loadToggleState(ctx.cwd);
    updateStatus(ctx, state.disabledSkills.size);
  };

  pi.registerCommand("toggle-skill", {
    description: "Toggle skills in the system prompt",
    handler: async (_args: string, ctx: ExtensionContext) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("toggle-skill requires interactive mode", "warning");
        return;
      }

      refreshState(ctx);

      const skills = loadSkills(ctx.cwd);
      if (skills.length === 0) {
        ctx.ui.notify("No skills found", "warning");
        return;
      }

      const writePath = state.writePath;
      await ctx.ui.custom<void>(
        (tui, _theme, _kb, done) => {
          const palette = new SkillTogglePalette(
            skills,
            state.disabledSkills,
            (skill) => {
              if (state.disabledSkills.has(skill.name)) {
                state.disabledSkills.delete(skill.name);
              } else {
                state.disabledSkills.add(skill.name);
              }
              saveToggleState(state, writePath);
              updateStatus(ctx, state.disabledSkills.size);
              tui.requestRender();
            },
            () => done(),
          );

          return {
            render(width: number) {
              return palette.render(width);
            },
            invalidate() {
              palette.invalidate();
            },
            handleInput(data: string) {
              palette.handleInput(data);
              tui.requestRender();
            },
          };
        },
        {
          overlay: true,
          overlayOptions: { anchor: "center", width: 70 },
        },
      );
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    refreshState(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    refreshState(ctx);
  });

  pi.on("before_agent_start", async (event, _ctx) => {
    if (state.disabledSkills.size === 0) return {};
    return {
      systemPrompt: filterSystemPrompt(
        event.systemPrompt,
        state.disabledSkills,
      ),
    };
  });
}
