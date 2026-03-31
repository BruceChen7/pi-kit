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
import { createLogger } from "../shared/logger.ts";
import {
  getSettingsPaths,
  loadSettings,
  readSettingsFile,
  writeSettingsFile,
} from "../shared/settings.ts";

interface Skill {
  name: string;
  description: string;
  filePath: string;
  scope?: "project" | "user" | "temporary";
}

interface SkillToggleSettingsEntry {
  disabledSkills?: string[];
  managedOverrides?: string[];
}

interface SkillToggleSettings {
  disabledSkills?: string[];
  managedOverrides?: string[];
  byCwd?: Record<string, SkillToggleSettingsEntry>;
}

interface ToggleState {
  disabledSkills: Set<string>;
  writePath: string;
  writeScope: "global";
  cwdKey: string;
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

// Matches <skill>...</skill> blocks with nested <name>...</name>
// Case-insensitive, tolerant of whitespace/newlines between tags
const SKILL_TAG_REGEX =
  /<skill\b[^>]*>[\s]*<name\b[^>]*>([^<]*)<\/name\b[^>]*>[\s\S]*?<\/skill>/gi;

const SKILL_DIRS: {
  dir: (cwd: string) => string;
  format: "recursive" | "claude";
}[] = [
  {
    dir: () => path.join(os.homedir(), ".agents", "skills"),
    format: "recursive",
  },
];

const paletteTheme = loadTheme();

function normalizeSkillName(name: string): string {
  return name.trim().toLowerCase();
}

const HOME_DIR = os.homedir();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function expandHomeShortcut(value: string): string {
  if (value === "~") return HOME_DIR;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(HOME_DIR, value.slice(2));
  }
  return value;
}

function normalizeCwdKey(value: string): string {
  return path.resolve(expandHomeShortcut(value));
}

function toTildePath(value: string): string {
  const normalized = path.resolve(value);
  if (normalized === HOME_DIR) return "~";
  const prefix = `${HOME_DIR}${path.sep}`;
  if (normalized.startsWith(prefix)) {
    return `~${normalized.slice(HOME_DIR.length)}`;
  }
  return normalized;
}

function findCwdKey(
  byCwd: Record<string, unknown> | undefined,
  cwd: string,
): string | null {
  if (!byCwd) return null;
  const normalizedCwd = normalizeCwdKey(cwd);
  for (const key of Object.keys(byCwd)) {
    if (normalizeCwdKey(key) === normalizedCwd) {
      return key;
    }
  }
  return null;
}

let log: ReturnType<typeof createLogger> | null = null;

async function initLogger(_cwd: string): Promise<void> {
  log = createLogger("skill-toggle", {
    stderr: null,
  });
}

export function createLoggerReady(
  cwd: string,
  init: (cwd: string) => Promise<void> = initLogger,
): Promise<void> {
  return init(cwd).catch(() => undefined);
}

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

function loadAvailableSkills(pi: ExtensionAPI, cwd: string): Skill[] {
  const commands = pi.getCommands();
  const skillsByName = new Map<string, Skill>();

  for (const command of commands) {
    if (command.source !== "skill") continue;
    const name = command.name.replace(/^skill:/, "");
    if (!name || skillsByName.has(name)) continue;
    skillsByName.set(name, {
      name,
      description: command.description ?? "",
      filePath: command.sourceInfo.path,
      scope: command.sourceInfo.scope,
    });
  }

  for (const skill of loadSkills(cwd)) {
    if (!skillsByName.has(skill.name)) {
      skillsByName.set(skill.name, { ...skill, scope: "user" });
    }
  }

  for (const entry of getManagedOverrideEntries(cwd)) {
    if (!skillsByName.has(entry.name)) {
      skillsByName.set(entry.name, entry);
    }
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

function isBlockScalar(value: string): boolean {
  return value.startsWith("|") || value.startsWith(">");
}

function readBlockScalar(
  lines: string[],
  startIndex: number,
): { value: string; nextIndex: number } {
  let indent: number | null = null;
  const blockLines: string[] = [];
  let index = startIndex;

  for (; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) {
      blockLines.push("");
      continue;
    }

    const match = /^(\s+)(.*)$/.exec(line);
    if (!match) break;

    const currentIndent = match[1].length;
    if (indent === null) {
      indent = currentIndent;
    }

    if (currentIndent < indent) break;

    blockLines.push(line.slice(indent));
  }

  return { value: blockLines.join("\n"), nextIndex: index };
}

function normalizeDescription(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function parseFrontmatter(
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
  const lines = frontmatter.split("\n");
  let name = fallbackName;
  let description = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();

    if (key === "name" && value) {
      name = value;
      continue;
    }

    if (key === "description") {
      if (isBlockScalar(value)) {
        const { value: blockValue, nextIndex } = readBlockScalar(lines, i + 1);
        description = blockValue;
        i = nextIndex - 1;
      } else {
        description = value;
      }
    }
  }

  return { name, description: normalizeDescription(description) };
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

function buildOverridePattern(skill: Skill): string {
  const basePath =
    path.basename(skill.filePath) === "SKILL.md"
      ? path.dirname(skill.filePath)
      : skill.filePath;
  const resolved = path.resolve(expandHomeShortcut(basePath));
  return `-${resolved}`;
}

function normalizeOverrideName(override: string): string {
  const trimmed = override.startsWith("-") ? override.slice(1) : override;
  return normalizeSkillName(path.basename(trimmed));
}

function buildSkillOverrides(
  disabled: Iterable<string>,
  skills: Skill[],
  managedOverrides: Map<string, string>,
): string[] {
  const overrides: string[] = [];
  const seen = new Set<string>();

  for (const name of disabled) {
    const skill = skills.find(
      (entry) => normalizeSkillName(entry.name) === name,
    );
    const override = skill
      ? buildOverridePattern(skill)
      : managedOverrides.get(name);
    if (!override) continue;
    if (seen.has(override)) continue;
    seen.add(override);
    overrides.push(override);
  }

  return overrides.sort();
}

function getManagedOverrides(
  skillToggle: SkillToggleSettings,
  state: ToggleState,
): string[] {
  const byCwd = isRecord(skillToggle.byCwd)
    ? (skillToggle.byCwd as Record<string, unknown>)
    : undefined;
  const entryRaw = byCwd ? byCwd[state.cwdKey] : undefined;
  if (isRecord(entryRaw)) {
    return toSkillList(entryRaw.managedOverrides) ?? [];
  }
  return [];
}

function getManagedOverrideMap(overrides: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const override of overrides) {
    const name = normalizeOverrideName(override);
    if (!name) continue;
    if (!map.has(name)) {
      map.set(name, override);
    }
  }
  return map;
}

function getGlobalCwdKey(cwd: string): string {
  const { global: globalSettings } = loadSettings(cwd, { forceReload: true });
  const globalToggle = extractSkillToggle(globalSettings);
  const byCwd = isRecord(globalToggle?.byCwd)
    ? (globalToggle?.byCwd as Record<string, unknown>)
    : undefined;
  const matchedKey = findCwdKey(byCwd, cwd);
  return matchedKey ?? toTildePath(cwd);
}

function getManagedOverrideEntries(cwd: string): Skill[] {
  const { globalPath } = getSettingsPaths(cwd);
  const cwdKey = getGlobalCwdKey(cwd);
  const settings = readSettingsFile(globalPath);
  const skillToggle = isRecord(settings.skillToggle)
    ? (settings.skillToggle as SkillToggleSettings)
    : {};
  const overrides = getManagedOverrides(skillToggle, {
    disabledSkills: new Set(),
    writePath: globalPath,
    writeScope: "global",
    cwdKey,
  });
  const entries: Skill[] = [];
  for (const override of overrides) {
    const basePath = override.startsWith("-") ? override.slice(1) : override;
    const name = normalizeSkillName(path.basename(basePath));
    if (!name) continue;
    entries.push({ name, description: "", filePath: basePath, scope: "user" });
  }
  return entries;
}

function updateManagedOverrides(
  skillToggle: SkillToggleSettings,
  state: ToggleState,
  overrides: string[],
): SkillToggleSettings {
  const byCwd = isRecord(skillToggle.byCwd) ? { ...skillToggle.byCwd } : {};
  const entryRaw = isRecord(byCwd[state.cwdKey])
    ? (byCwd[state.cwdKey] as SkillToggleSettingsEntry)
    : {};
  const nextEntry: SkillToggleSettingsEntry = {
    ...entryRaw,
    managedOverrides: overrides.length > 0 ? overrides : undefined,
  };
  if (!nextEntry.managedOverrides) {
    delete nextEntry.managedOverrides;
  }
  byCwd[state.cwdKey] = nextEntry;
  return { ...skillToggle, byCwd };
}

export function loadToggleState(cwd: string): ToggleState {
  const { globalPath, global: globalSettings } = loadSettings(cwd, {
    forceReload: true,
  });
  const globalToggle = extractSkillToggle(globalSettings);

  const byCwd = isRecord(globalToggle?.byCwd)
    ? (globalToggle?.byCwd as Record<string, unknown>)
    : undefined;
  const matchedKey = findCwdKey(byCwd, cwd);
  const globalEntryRaw = matchedKey && byCwd ? byCwd[matchedKey] : undefined;
  const globalEntry = isRecord(globalEntryRaw)
    ? (globalEntryRaw as SkillToggleSettingsEntry)
    : null;
  const globalDisabled = toSkillList(globalEntry?.disabledSkills);

  const disabledSkills = globalDisabled ?? [];
  const cwdKey = matchedKey ?? toTildePath(cwd);

  // Normalize all disabled skill names for consistent matching
  const normalizedDisabled = disabledSkills.map(normalizeSkillName);
  return {
    disabledSkills: new Set(normalizedDisabled),
    writePath: globalPath,
    writeScope: "global",
    cwdKey,
  };
}

export function saveToggleState(state: ToggleState): void {
  const settings = readSettingsFile(state.writePath);
  const skillToggle = isRecord(settings.skillToggle)
    ? (settings.skillToggle as SkillToggleSettings)
    : {};
  const byCwd = isRecord(skillToggle.byCwd) ? { ...skillToggle.byCwd } : {};
  const entryRaw = isRecord(byCwd[state.cwdKey])
    ? (byCwd[state.cwdKey] as SkillToggleSettingsEntry)
    : {};
  byCwd[state.cwdKey] = {
    ...entryRaw,
    disabledSkills: Array.from(state.disabledSkills).sort(),
  };
  settings.skillToggle = {
    ...skillToggle,
    byCwd,
  };

  writeSettingsFile(state.writePath, settings);
}

function arraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function syncSkillOverridesForState(state: ToggleState, skills: Skill[]): void {
  const settings = readSettingsFile(state.writePath);
  const skillToggle = isRecord(settings.skillToggle)
    ? (settings.skillToggle as SkillToggleSettings)
    : {};
  const currentSkills = toSkillList(settings.skills) ?? [];
  const managedOverrides = getManagedOverrides(skillToggle, state);
  const managedOverrideMap = getManagedOverrideMap(managedOverrides);
  const nextOverrides = buildSkillOverrides(
    state.disabledSkills,
    skills,
    managedOverrideMap,
  );

  const cleanedSkills = currentSkills.filter(
    (entry) => !managedOverrides.includes(entry),
  );
  const nextSkills = [...cleanedSkills];
  for (const override of nextOverrides) {
    if (!nextSkills.includes(override)) {
      nextSkills.push(override);
    }
  }

  const skillsChanged = !arraysEqual(currentSkills, nextSkills);
  const overridesChanged = !arraysEqual(managedOverrides, nextOverrides);

  if (!skillsChanged && !overridesChanged) {
    return;
  }

  if (nextSkills.length > 0) {
    settings.skills = nextSkills;
  } else {
    delete settings.skills;
  }

  settings.skillToggle = updateManagedOverrides(
    skillToggle,
    state,
    nextOverrides,
  );
  writeSettingsFile(state.writePath, settings);
}

export function syncSkillOverrides(
  state: ToggleState,
  skills: Skill[],
  cwd: string,
): void {
  const { globalPath } = getSettingsPaths(cwd);
  const globalState: ToggleState = {
    disabledSkills: state.disabledSkills,
    writePath: globalPath,
    writeScope: "global",
    cwdKey: getGlobalCwdKey(cwd),
  };
  syncSkillOverridesForState(globalState, skills);
}

function getInstalledSkillNames(skills: Skill[]): Set<string> {
  return new Set(skills.map((skill) => normalizeSkillName(skill.name)));
}

function getInstalledDisabled(
  disabled: Set<string>,
  skills: Skill[],
): string[] {
  if (disabled.size === 0) return [];
  const installed = getInstalledSkillNames(skills);
  return Array.from(disabled).filter((name) => installed.has(name));
}

function pruneDisabledList(
  value: unknown,
  installed: Set<string>,
): { list: string[]; changed: boolean } | null {
  const items = toSkillList(value);
  if (items === null) return null;
  const normalized = items.map(normalizeSkillName);
  const filtered = normalized.filter((name) => installed.has(name));
  const changed = filtered.length !== normalized.length;
  return { list: filtered, changed };
}

function pruneSettingsFile(filePath: string, installed: Set<string>): void {
  if (!fs.existsSync(filePath)) return;
  const settings = readSettingsFile(filePath);
  if (!isRecord(settings.skillToggle)) return;

  const skillToggle = settings.skillToggle as SkillToggleSettings;
  let changed = false;

  const topLevel = pruneDisabledList(skillToggle.disabledSkills, installed);
  if (topLevel?.changed) {
    skillToggle.disabledSkills = topLevel.list;
    changed = true;
  }

  if (isRecord(skillToggle.byCwd)) {
    const byCwd = skillToggle.byCwd as Record<string, unknown>;
    for (const key of Object.keys(byCwd)) {
      const entryRaw = byCwd[key];
      if (!isRecord(entryRaw)) continue;
      const entry = entryRaw as SkillToggleSettingsEntry;
      const entryPruned = pruneDisabledList(entry.disabledSkills, installed);
      if (entryPruned?.changed) {
        entry.disabledSkills = entryPruned.list;
        changed = true;
      }
    }
  }

  if (!changed) return;
  settings.skillToggle = skillToggle;
  writeSettingsFile(filePath, settings);
}

function pruneSettingsFiles(cwd: string, skills: Skill[]): void {
  const installed = getInstalledSkillNames(skills);
  const { globalPath } = getSettingsPaths(cwd);
  pruneSettingsFile(globalPath, installed);
}

function formatDisabledList(
  disabled: string[],
  skills: Skill[],
  maxWidth: number,
): string {
  if (disabled.length === 0) return "Disabled: none";

  // Map normalized names back to canonical skill names
  const displayNames = disabled.map((normalized) => {
    const skill = skills.find((s) => normalizeSkillName(s.name) === normalized);
    return skill?.name ?? normalized;
  });

  const label = `Disabled (${displayNames.length}): ${displayNames.join(", ")}`;
  return truncateToWidth(label, maxWidth, "…", true);
}

function updateStatus(
  ctx: ExtensionContext,
  disabled: Set<string>,
  skills?: Skill[],
): void {
  if (!ctx.hasUI) return;

  const visibleCount = skills
    ? getInstalledDisabled(disabled, skills).length
    : disabled.size;

  if (visibleCount === 0) {
    ctx.ui.setStatus("skill-toggle", undefined);
    return;
  }
  ctx.ui.setStatus("skill-toggle", `Skill toggle: ${visibleCount} disabled`);
}

function filterSystemPrompt(prompt: string, disabled: Set<string>): string {
  if (disabled.size === 0) return prompt;

  log?.info("SKILL_TAG_REGEX", { regex: String(SKILL_TAG_REGEX) });

  return prompt.replace(SKILL_TAG_REGEX, (match, name) => {
    if (!name) {
      // Fail-soft: keep block if name cannot be extracted
      log?.debug("skill name extraction failed, keeping block");
      return match;
    }
    const normalizedName = normalizeSkillName(name);
    log?.info("skill name resolved", { name, normalizedName });
    if (disabled.has(normalizedName)) return "";
    return match;
  });
}

class SkillTogglePicker {
  private filtered: Skill[];
  private selected = 0;
  private query = "";
  private boundaryMessage: string | null = null;
  private boundaryTimeout: ReturnType<typeof setTimeout> | null = null;
  private inactivityTimeout: ReturnType<typeof setTimeout> | null = null;
  private static readonly INACTIVITY_MS = 60000;
  private static readonly BOUNDARY_MESSAGE_MS = 2000;

  constructor(
    private skills: Skill[],
    private disabled: Set<string>,
    private onToggle: (skill: Skill) => void,
    private onClose: () => void,
    private onUpdate: () => void,
  ) {
    this.filtered = skills;
    this.resetInactivityTimeout();
  }

  private resetInactivityTimeout(): void {
    if (this.inactivityTimeout) clearTimeout(this.inactivityTimeout);
    this.inactivityTimeout = setTimeout(() => {
      this.cleanup();
      this.onClose();
    }, SkillTogglePicker.INACTIVITY_MS);
  }

  private showBoundaryMessage(message: string): void {
    this.boundaryMessage = message;
    if (this.boundaryTimeout) clearTimeout(this.boundaryTimeout);
    this.boundaryTimeout = setTimeout(() => {
      this.boundaryMessage = null;
      this.boundaryTimeout = null;
      this.onUpdate();
    }, SkillTogglePicker.BOUNDARY_MESSAGE_MS);
    this.onUpdate();
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
        if (this.selected === 0) {
          this.showBoundaryMessage("Top");
        } else {
          this.selected -= 1;
        }
      }
      return;
    }

    if (data === "j") {
      if (this.filtered.length > 0) {
        if (this.selected === this.filtered.length - 1) {
          this.showBoundaryMessage("Bottom");
        } else {
          this.selected += 1;
        }
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
    const description = (s: string) => fg(t.description, s);
    const hint = (s: string) => fg(t.hint, s);
    const keyHint = (s: string) => fg(t.selected, s);
    const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
    const italic = (s: string) => `\x1b[3m${s}\x1b[23m`;

    const row = (content: string) =>
      border("│") +
      truncateToWidth(` ${content}`, innerW, "…", true) +
      border("│");
    const emptyRow = () => border("│") + " ".repeat(innerW) + border("│");

    const titleText = " Skill Picker ";
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
      : `${cursor}${keyHint(italic("type to filter..."))}`;
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
        const isDisabled = this.disabled.has(normalizeSkillName(skill.name));

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
      getInstalledDisabled(this.disabled, this.skills).sort(),
      this.skills,
      innerW - 1,
    );
    lines.push(row(hint(disabledList)));

    lines.push(emptyRow());
    lines.push(border(`├${"─".repeat(innerW)}┤`));
    lines.push(emptyRow());

    const hints = `${keyHint("j/k")} navigate  ${keyHint("enter")} toggle  ${keyHint("esc")} cancel`;
    const hintText = hint(hints);
    const boundaryText = this.boundaryMessage
      ? keyHint(italic(this.boundaryMessage))
      : "";
    const contentWidth = Math.max(0, innerW - 1);
    const padWidth = boundaryText
      ? Math.max(
          0,
          contentWidth - visibleWidth(hintText) - visibleWidth(boundaryText),
        )
      : 0;
    const hintLine = boundaryText
      ? `${hintText}${" ".repeat(padWidth)}${boundaryText}`
      : hintText;
    lines.push(row(hintLine));

    lines.push(border(`╰${"─".repeat(innerW)}╯`));

    return lines;
  }

  private cleanup(): void {
    if (this.inactivityTimeout) {
      clearTimeout(this.inactivityTimeout);
      this.inactivityTimeout = null;
    }
    if (this.boundaryTimeout) {
      clearTimeout(this.boundaryTimeout);
      this.boundaryTimeout = null;
    }
    this.boundaryMessage = null;
  }

  invalidate(): void {}

  dispose(): void {
    this.cleanup();
  }
}

export default function skillToggleExtension(pi: ExtensionAPI): void {
  let state: ToggleState = loadToggleState(process.cwd());

  const isDisabledSkillCommand = (text: string): string | null => {
    if (!text.startsWith("/skill:")) return null;
    const remainder = text.slice("/skill:".length).trim();
    if (!remainder) return null;
    const name = normalizeSkillName(remainder.split(/\s+/)[0] ?? "");
    if (!name) return null;
    return state.disabledSkills.has(name) ? name : null;
  };

  const loggerReady = createLoggerReady(process.cwd());

  const refreshState = (ctx: ExtensionContext, skills?: Skill[]) => {
    if (skills) {
      pruneSettingsFiles(ctx.cwd, skills);
    }
    state = loadToggleState(ctx.cwd);
    if (skills) {
      syncSkillOverrides(state, skills, ctx.cwd);
    }
    updateStatus(ctx, state.disabledSkills, skills);
  };

  pi.registerCommand("toggle-skill", {
    description: "Toggle skills in the system prompt",
    handler: async (_args: string, ctx: ExtensionContext) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("toggle-skill requires interactive mode", "warning");
        return;
      }

      const skills = loadAvailableSkills(pi, ctx.cwd);
      refreshState(ctx, skills);
      if (skills.length === 0) {
        ctx.ui.notify("No skills found", "warning");
        return;
      }

      let didToggle = false;

      await ctx.ui.custom<void>(
        (tui, _theme, _kb, done) => {
          const picker = new SkillTogglePicker(
            skills,
            state.disabledSkills,
            (skill) => {
              const normalizedName = normalizeSkillName(skill.name);
              if (state.disabledSkills.has(normalizedName)) {
                state.disabledSkills.delete(normalizedName);
              } else {
                state.disabledSkills.add(normalizedName);
              }
              saveToggleState(state);
              syncSkillOverrides(state, skills, ctx.cwd);
              updateStatus(ctx, state.disabledSkills, skills);
              didToggle = true;
              tui.requestRender();
            },
            () => done(),
            () => tui.requestRender(),
          );

          return {
            render(width: number) {
              return picker.render(width);
            },
            invalidate() {
              picker.invalidate();
            },
            handleInput(data: string) {
              picker.handleInput(data);
              tui.requestRender();
            },
          };
        },
        {
          overlay: true,
          overlayOptions: { anchor: "center", width: 70 },
        },
      );

      if (didToggle) {
        ctx.ui.notify("Run /reload to update skill commands", "info");
      }
    },
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };
    const disabledName = isDisabledSkillCommand(event.text);
    if (!disabledName) return { action: "continue" };
    if (ctx.hasUI) {
      ctx.ui.notify(
        `Skill "${disabledName}" is disabled. Use /toggle-skill to enable.`,
        "warning",
      );
    }
    return { action: "handled" };
  });

  pi.on("session_start", async (_event, ctx) => {
    const skills = loadAvailableSkills(pi, ctx.cwd);
    refreshState(ctx, skills);
  });

  pi.on("session_switch", async (_event, ctx) => {
    const skills = loadAvailableSkills(pi, ctx.cwd);
    refreshState(ctx, skills);
  });

  pi.on("before_agent_start", async (event, _ctx) => {
    await loggerReady;
    log?.debug("before_agent_start");
    log?.debug("disabled skills", { disabled: state.disabledSkills });
    if (state.disabledSkills.size === 0) return {};
    const prompt = filterSystemPrompt(event.systemPrompt, state.disabledSkills);
    log?.debug("filtered prompt", { prompt });
    return {
      systemPrompt: prompt,
    };
  });
}
