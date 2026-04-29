/**
 * /toggle-skill
 *
 * Toggle symlinked skills by adding/removing their skill directory links.
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
import { getGitCommonDir, getRepoRoot } from "../shared/git.ts";
import { createLogger } from "../shared/logger.ts";
import {
  getSettingsPaths,
  loadSettings,
  readSettingsFile,
  writeSettingsFile,
} from "../shared/settings.ts";

export interface Skill {
  name: string;
  description: string;
  filePath: string;
  scope?: "project" | "user" | "temporary";
}

interface ManagedSkillLink {
  name: string;
  description?: string;
  path: string;
  target: string;
}

interface SkillToggleSettingsEntry {
  disabledSkills?: string[];
  disabledSkillPaths?: string[];
  managedOverrides?: string[];
  managedSkillLinks?: ManagedSkillLink[];
}

interface SkillToggleSettings {
  disabledSkills?: string[];
  disabledSkillPaths?: string[];
  managedOverrides?: string[];
  managedSkillLinks?: ManagedSkillLink[];
  byCwd?: Record<string, SkillToggleSettingsEntry>;
}

export type SkillLinkToggleResult =
  | { status: "enabled" | "disabled" | "already-disabled" }
  | {
      status: "not-symlink" | "missing-link-record" | "conflict";
      path: string;
    };

interface ToggleState {
  disabledSkills: Set<string>;
  disabledSkillPaths: Set<string>;
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

const DEFAULT_SKILL_DIRS: {
  dir: (cwd: string) => string;
  format: "recursive" | "claude";
  scope: Skill["scope"];
}[] = [
  {
    dir: () => path.join(os.homedir(), ".pi", "agent", "skills"),
    format: "recursive",
    scope: "user",
  },
  {
    dir: () => path.join(os.homedir(), ".agents", "skills"),
    format: "recursive",
    scope: "user",
  },
  {
    dir: (cwd) => path.join(cwd, ".pi", "skills"),
    format: "recursive",
    scope: "project",
  },
];

const paletteTheme = loadTheme();

function getProjectSettingsPath(cwd: string): string {
  return path.join(cwd, ".pi", "settings.json");
}

function normalizeSkillName(name: string): string {
  return name.trim().toLowerCase();
}

function getSkillBasePath(skill: Skill): string {
  const basePath =
    path.basename(skill.filePath) === "SKILL.md"
      ? path.dirname(skill.filePath)
      : skill.filePath;
  return normalizeSkillBasePath(basePath);
}

function normalizeSkillBasePath(value: string): string {
  const withoutPrefix = value.startsWith("-") ? value.slice(1) : value;
  const resolved = path.resolve(expandConfigPath(withoutPrefix));
  return path.basename(resolved) === "SKILL.md"
    ? path.dirname(resolved)
    : resolved;
}

function isSkillPathDisabled(
  skill: Skill,
  disabledPaths: Set<string>,
): boolean {
  return disabledPaths.has(getSkillBasePath(skill));
}

function getPathDisabledSkillNames(
  skills: Skill[],
  disabledPaths: Set<string>,
): Set<string> {
  const names = new Set<string>();
  for (const skill of skills) {
    if (isSkillPathDisabled(skill, disabledPaths)) {
      names.add(normalizeSkillName(skill.name));
    }
  }
  return names;
}

function getNameDisabledSkills(
  disabledNames: Set<string>,
  skills: Skill[],
  disabledPaths: Set<string>,
): Set<string> {
  const pathDisabledNames = getPathDisabledSkillNames(skills, disabledPaths);
  return new Set(
    Array.from(disabledNames).filter((name) => !pathDisabledNames.has(name)),
  );
}

export function isSkillDisabledForList(
  skill: Skill,
  skills: Skill[],
  disabledNames: Set<string>,
  disabledPaths: Set<string>,
): boolean {
  if (isSkillPathDisabled(skill, disabledPaths)) return true;
  const name = normalizeSkillName(skill.name);
  return getNameDisabledSkills(disabledNames, skills, disabledPaths).has(name);
}

export function formatSkillDisplayDetails(skill: Skill): string {
  const scope = skill.scope ?? "temporary";
  return `[${scope}] ${toPortablePath(getSkillBasePath(skill))}`;
}

const HOME_DIR = os.homedir();
const ENV_VAR_TOKEN_REGEX =
  /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function expandEnvironmentVariables(value: string): string {
  return value.replace(ENV_VAR_TOKEN_REGEX, (match, braced, bare) => {
    const key = braced || bare;
    if (!key) return match;
    const envValue = process.env[key];
    return typeof envValue === "string" && envValue.length > 0
      ? envValue
      : match;
  });
}

function expandHomeShortcut(value: string): string {
  if (value === "~") return HOME_DIR;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(HOME_DIR, value.slice(2));
  }
  return value;
}

function expandConfigPath(value: string): string {
  return expandHomeShortcut(expandEnvironmentVariables(value));
}

function normalizeCwdKey(value: string): string {
  return path.resolve(expandConfigPath(value));
}

function toPortablePath(value: string): string {
  const normalized = path.resolve(value);
  if (normalized === HOME_DIR) return "$HOME";
  const prefix = `${HOME_DIR}${path.sep}`;
  if (normalized.startsWith(prefix)) {
    return `$HOME${normalized.slice(HOME_DIR.length)}`;
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

function resolveSettingsCwd(cwd: string): string {
  const repoRoot = getRepoRoot(cwd);
  const commonDir = getGitCommonDir(cwd);
  if (!repoRoot || !commonDir) {
    return cwd;
  }

  const normalizedRepoRoot = path.resolve(repoRoot);
  const primaryRepoRoot = path.resolve(path.dirname(commonDir));
  return normalizedRepoRoot !== primaryRepoRoot ? primaryRepoRoot : cwd;
}

async function initLogger(_cwd: string): Promise<void> {
  createLogger("skill-toggle", {
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

function getProjectAgentsSkillDirs(cwd: string): string[] {
  const repoRoot = getRepoRoot(cwd);
  const stopDir = repoRoot ? path.resolve(repoRoot) : path.parse(cwd).root;
  const dirs: string[] = [];
  let current = path.resolve(cwd);

  while (true) {
    dirs.push(path.join(current, ".agents", "skills"));
    if (current === stopDir) break;

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return dirs;
}

function compareSkills(left: Skill, right: Skill): number {
  const byName = left.name.localeCompare(right.name);
  if (byName !== 0) return byName;
  return getSkillBasePath(left).localeCompare(getSkillBasePath(right));
}

function sortSkills(skills: Iterable<Skill>): Skill[] {
  return Array.from(skills).sort(compareSkills);
}

export function loadSkills(cwd: string): Skill[] {
  const skillsByPath = new Map<string, Skill>();

  for (const { dir, format, scope } of DEFAULT_SKILL_DIRS) {
    scanSkillDir(dir(cwd), format, skillsByPath, undefined, scope);
  }

  for (const dir of getProjectAgentsSkillDirs(cwd)) {
    scanSkillDir(dir, "recursive", skillsByPath, undefined, "project");
  }

  return sortSkills(skillsByPath.values());
}

function addAvailableSkill(
  skillsByPath: Map<string, Skill>,
  skill: Skill,
): void {
  const key = getSkillBasePath(skill);
  if (!skillsByPath.has(key)) {
    skillsByPath.set(key, skill);
  }
}

function loadAvailableSkills(pi: ExtensionAPI, cwd: string): Skill[] {
  const commands = pi.getCommands();
  const skillsByPath = new Map<string, Skill>();

  for (const command of commands) {
    if (command.source !== "skill") continue;
    const name = command.name.replace(/^skill:/, "");
    if (!name) continue;
    addAvailableSkill(skillsByPath, {
      name,
      description: command.description ?? "",
      filePath: command.sourceInfo.path,
      scope: command.sourceInfo.scope,
    });
  }

  for (const skill of loadSkills(cwd)) {
    addAvailableSkill(skillsByPath, skill);
  }

  for (const entry of getManagedOverrideEntries(cwd)) {
    addAvailableSkill(skillsByPath, entry);
  }

  return sortSkills(skillsByPath.values());
}

function scanSkillDir(
  dir: string,
  format: "recursive" | "claude",
  skillsByPath: Map<string, Skill>,
  visitedDirs?: Set<string>,
  scope?: Skill["scope"],
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
          scanSkillDir(entryPath, format, skillsByPath, visited, scope);
        } else if (isFile && entry.name === "SKILL.md") {
          loadSkillFromFile(entryPath, skillsByPath, scope);
        }
      } else if (format === "claude") {
        if (!isDirectory) continue;
        const skillFile = path.join(entryPath, "SKILL.md");
        if (!fs.existsSync(skillFile)) continue;
        loadSkillFromFile(skillFile, skillsByPath, scope);
      }
    }
  } catch {
    // Ignore inaccessible directories
  }
}

function loadSkillFromFile(
  filePath: string,
  skillsByPath: Map<string, Skill>,
  scope?: Skill["scope"],
): void {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const skillDir = path.dirname(filePath);
    const parentDirName = path.basename(skillDir);
    const { name, description } = parseFrontmatter(content, parentDirName);

    const skill = { name, description, filePath, scope };
    const key = getSkillBasePath(skill);
    if (description && !skillsByPath.has(key)) {
      skillsByPath.set(key, skill);
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

function normalizeManagedSkillLink(value: unknown): ManagedSkillLink | null {
  if (!isRecord(value)) return null;
  if (typeof value.name !== "string") return null;
  if (typeof value.path !== "string") return null;
  if (typeof value.target !== "string") return null;
  return {
    name: value.name,
    description:
      typeof value.description === "string" ? value.description : undefined,
    path: normalizeSkillBasePath(value.path),
    target: path.resolve(expandConfigPath(value.target)),
  };
}

function toManagedSkillLinks(value: unknown): ManagedSkillLink[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const link = normalizeManagedSkillLink(item);
    return link ? [link] : [];
  });
}

function buildOverridePattern(skill: Skill): string {
  return buildOverridePatternFromBasePath(getSkillBasePath(skill));
}

function buildOverridePatternFromBasePath(basePath: string): string {
  return `-${toPortablePath(normalizeSkillBasePath(basePath))}`;
}

function normalizeOverrideName(override: string): string {
  const trimmed = override.startsWith("-") ? override.slice(1) : override;
  return normalizeSkillName(path.basename(trimmed));
}

function addOverride(
  overrides: string[],
  seen: Set<string>,
  override: string | undefined,
): void {
  if (!override || seen.has(override)) return;
  seen.add(override);
  overrides.push(override);
}

function buildSkillOverrides(
  disabled: Iterable<string>,
  skills: Skill[],
  managedOverrides: Map<string, string>,
  disabledPaths: Iterable<string> = [],
): string[] {
  const overrides: string[] = [];
  const seen = new Set<string>();
  const namesCoveredByPaths = new Set<string>();

  for (const skillPath of disabledPaths) {
    const basePath = normalizeSkillBasePath(skillPath);
    const skill = skills.find((entry) => getSkillBasePath(entry) === basePath);
    if (skill) {
      namesCoveredByPaths.add(normalizeSkillName(skill.name));
    }
    addOverride(
      overrides,
      seen,
      skill
        ? buildOverridePattern(skill)
        : buildOverridePatternFromBasePath(basePath),
    );
  }

  for (const name of disabled) {
    if (namesCoveredByPaths.has(name)) continue;
    const skill = skills.find(
      (entry) => normalizeSkillName(entry.name) === name,
    );
    const override = skill
      ? buildOverridePattern(skill)
      : managedOverrides.get(name);
    addOverride(overrides, seen, override);
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

function getManagedSkillLinks(
  skillToggle: SkillToggleSettings,
  state: ToggleState,
): ManagedSkillLink[] {
  const byCwd = isRecord(skillToggle.byCwd)
    ? (skillToggle.byCwd as Record<string, unknown>)
    : undefined;
  const entryRaw = byCwd ? byCwd[state.cwdKey] : undefined;
  if (isRecord(entryRaw)) {
    return toManagedSkillLinks(entryRaw.managedSkillLinks);
  }
  return [];
}

function updateManagedSkillLinks(
  skillToggle: SkillToggleSettings,
  state: ToggleState,
  links: ManagedSkillLink[],
): SkillToggleSettings {
  const byCwd = isRecord(skillToggle.byCwd) ? { ...skillToggle.byCwd } : {};
  const entryRaw = isRecord(byCwd[state.cwdKey])
    ? (byCwd[state.cwdKey] as SkillToggleSettingsEntry)
    : {};
  const nextEntry: SkillToggleSettingsEntry = {
    ...entryRaw,
    managedSkillLinks: links.length > 0 ? links : undefined,
  };
  if (!nextEntry.managedSkillLinks) {
    delete nextEntry.managedSkillLinks;
  }
  byCwd[state.cwdKey] = nextEntry;
  return { ...skillToggle, byCwd };
}

function saveManagedSkillLinks(
  state: ToggleState,
  update: (links: ManagedSkillLink[]) => ManagedSkillLink[],
): void {
  const settings = readSettingsFile(state.writePath);
  const skillToggle = isRecord(settings.skillToggle)
    ? (settings.skillToggle as SkillToggleSettings)
    : {};
  const links = update(getManagedSkillLinks(skillToggle, state));
  settings.skillToggle = updateManagedSkillLinks(skillToggle, state, links);
  writeSettingsFile(state.writePath, settings);
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
  const settingsCwd = resolveSettingsCwd(cwd);
  const { global: globalSettings } = loadSettings(cwd, { forceReload: true });
  const globalToggle = extractSkillToggle(globalSettings);
  const byCwd = isRecord(globalToggle?.byCwd)
    ? (globalToggle?.byCwd as Record<string, unknown>)
    : undefined;
  const matchedKey = findCwdKey(byCwd, settingsCwd);
  return matchedKey ?? toPortablePath(settingsCwd);
}

function getManagedOverrideEntries(cwd: string): Skill[] {
  const { globalPath } = getSettingsPaths(cwd);
  const cwdKey = getGlobalCwdKey(cwd);
  const settings = readSettingsFile(globalPath);
  const skillToggle = isRecord(settings.skillToggle)
    ? (settings.skillToggle as SkillToggleSettings)
    : {};
  const state = {
    disabledSkills: new Set<string>(),
    disabledSkillPaths: new Set<string>(),
    writePath: globalPath,
    writeScope: "global" as const,
    cwdKey,
  };
  const overrides = getManagedOverrides(skillToggle, state);
  const entries: Skill[] = [];
  for (const override of overrides) {
    const basePath = override.startsWith("-") ? override.slice(1) : override;
    const name = normalizeSkillName(path.basename(basePath));
    if (!name) continue;
    entries.push({ name, description: "", filePath: basePath, scope: "user" });
  }
  for (const link of getManagedSkillLinks(skillToggle, state)) {
    entries.push({
      name: link.name,
      description: link.description ?? "",
      filePath: path.join(link.path, "SKILL.md"),
      scope: "user",
    });
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
  const settingsCwd = resolveSettingsCwd(cwd);
  const { globalPath, global: globalSettings } = loadSettings(cwd, {
    forceReload: true,
  });
  const globalToggle = extractSkillToggle(globalSettings);

  const byCwd = isRecord(globalToggle?.byCwd)
    ? (globalToggle?.byCwd as Record<string, unknown>)
    : undefined;
  const matchedKey = findCwdKey(byCwd, settingsCwd);
  const globalEntryRaw = matchedKey && byCwd ? byCwd[matchedKey] : undefined;
  const globalEntry = isRecord(globalEntryRaw)
    ? (globalEntryRaw as SkillToggleSettingsEntry)
    : null;
  const globalDisabled = toSkillList(globalEntry?.disabledSkills);
  const globalDisabledPaths = toSkillList(globalEntry?.disabledSkillPaths);

  const disabledSkills = globalDisabled ?? [];
  const disabledSkillPaths = globalDisabledPaths ?? [];
  const cwdKey = matchedKey ?? toPortablePath(settingsCwd);

  // Normalize all disabled skill names and paths for consistent matching
  const normalizedDisabled = disabledSkills.map(normalizeSkillName);
  const normalizedDisabledPaths = disabledSkillPaths.map(
    normalizeSkillBasePath,
  );
  return {
    disabledSkills: new Set(normalizedDisabled),
    disabledSkillPaths: new Set(normalizedDisabledPaths),
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
  const disabledSkillPaths = Array.from(state.disabledSkillPaths)
    .map((entry) => toPortablePath(normalizeSkillBasePath(entry)))
    .sort();
  const nextEntry: SkillToggleSettingsEntry = {
    ...entryRaw,
    disabledSkills: Array.from(state.disabledSkills).sort(),
    disabledSkillPaths:
      disabledSkillPaths.length > 0 ? disabledSkillPaths : undefined,
  };
  if (!nextEntry.disabledSkillPaths) {
    delete nextEntry.disabledSkillPaths;
  }
  byCwd[state.cwdKey] = nextEntry;
  settings.skillToggle = {
    ...skillToggle,
    byCwd,
  };

  writeSettingsFile(state.writePath, settings);
}

function linkTargetToAbsolute(linkPath: string, target: string): string {
  return path.resolve(path.dirname(linkPath), target);
}

function findManagedSkillLink(
  state: ToggleState,
  skillPath: string,
): ManagedSkillLink | null {
  const settings = readSettingsFile(state.writePath);
  const skillToggle = isRecord(settings.skillToggle)
    ? (settings.skillToggle as SkillToggleSettings)
    : {};
  const normalizedPath = normalizeSkillBasePath(skillPath);
  return (
    getManagedSkillLinks(skillToggle, state).find(
      (link) => normalizeSkillBasePath(link.path) === normalizedPath,
    ) ?? null
  );
}

function isManagedSkillLinkForPath(
  link: ManagedSkillLink,
  skillPath: string,
): boolean {
  return (
    normalizeSkillBasePath(link.path) === normalizeSkillBasePath(skillPath)
  );
}

function removeManagedSkillLink(state: ToggleState, skillPath: string): void {
  saveManagedSkillLinks(state, (links) =>
    links.filter((link) => !isManagedSkillLinkForPath(link, skillPath)),
  );
}

function upsertManagedSkillLink(
  state: ToggleState,
  link: ManagedSkillLink,
): void {
  saveManagedSkillLinks(state, (links) => [
    ...links.filter((entry) => !isManagedSkillLinkForPath(entry, link.path)),
    link,
  ]);
}

export function toggleSkillLink(
  state: ToggleState,
  skill: Skill,
): SkillLinkToggleResult {
  const skillPath = getSkillBasePath(skill);
  const normalizedName = normalizeSkillName(skill.name);

  if (state.disabledSkillPaths.has(skillPath)) {
    const link = findManagedSkillLink(state, skillPath);
    if (!link) return { status: "missing-link-record", path: skillPath };
    if (fs.existsSync(link.path))
      return { status: "conflict", path: link.path };

    fs.mkdirSync(path.dirname(link.path), { recursive: true });
    fs.symlinkSync(link.target, link.path);
    state.disabledSkillPaths.delete(skillPath);
    state.disabledSkills.delete(normalizedName);
    saveToggleState(state);
    removeManagedSkillLink(state, skillPath);
    return { status: "enabled" };
  }

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(skillPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { status: "already-disabled" };
    throw error;
  }

  if (!stat.isSymbolicLink()) return { status: "not-symlink", path: skillPath };

  const target = linkTargetToAbsolute(skillPath, fs.readlinkSync(skillPath));
  fs.unlinkSync(skillPath);
  state.disabledSkills.delete(normalizedName);
  state.disabledSkillPaths.add(skillPath);
  saveToggleState(state);
  upsertManagedSkillLink(state, {
    name: skill.name,
    description: skill.description,
    path: skillPath,
    target,
  });
  return { status: "disabled" };
}

function arraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function syncSkillOverridesForState(
  state: ToggleState,
  skills: Skill[],
  projectSettingsPath: string,
): void {
  const toggleSettings = readSettingsFile(state.writePath);
  const skillToggle = isRecord(toggleSettings.skillToggle)
    ? (toggleSettings.skillToggle as SkillToggleSettings)
    : {};
  const projectSettings = readSettingsFile(projectSettingsPath);
  const currentSkills = toSkillList(projectSettings.skills) ?? [];
  const managedOverrides = getManagedOverrides(skillToggle, state);
  const managedOverrideMap = getManagedOverrideMap(managedOverrides);
  const nextOverrides = buildSkillOverrides(
    state.disabledSkills,
    skills,
    managedOverrideMap,
    state.disabledSkillPaths,
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

  if (skillsChanged) {
    if (nextSkills.length > 0) {
      projectSettings.skills = nextSkills;
    } else {
      delete projectSettings.skills;
    }
    writeSettingsFile(projectSettingsPath, projectSettings);
  }

  if (overridesChanged) {
    toggleSettings.skillToggle = updateManagedOverrides(
      skillToggle,
      state,
      nextOverrides,
    );
    writeSettingsFile(state.writePath, toggleSettings);
  }
}

export function syncSkillOverrides(
  state: ToggleState,
  skills: Skill[],
  cwd: string,
): void {
  const { globalPath } = getSettingsPaths(cwd);
  const globalState: ToggleState = {
    disabledSkills: state.disabledSkills,
    disabledSkillPaths: state.disabledSkillPaths,
    writePath: globalPath,
    writeScope: "global",
    cwdKey: getGlobalCwdKey(cwd),
  };
  syncSkillOverridesForState(globalState, skills, getProjectSettingsPath(cwd));
}

function getInstalledSkillNames(skills: Skill[]): Set<string> {
  return new Set(skills.map((skill) => normalizeSkillName(skill.name)));
}

function getDisabledSkills(
  skills: Skill[],
  disabled: Set<string>,
  disabledPaths: Set<string>,
): Skill[] {
  return skills.filter((skill) =>
    isSkillDisabledForList(skill, skills, disabled, disabledPaths),
  );
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

function getDisabledSkillDisplayNames(
  disabled: Set<string>,
  skills: Skill[],
  disabledPaths: Set<string> = new Set(),
): string[] {
  const displayNames = getDisabledSkills(skills, disabled, disabledPaths).map(
    (skill) => skill.name,
  );
  return Array.from(new Set(displayNames)).sort((left, right) =>
    left.localeCompare(right),
  );
}

export function formatDisabledSkillsMessage(
  disabled: Set<string>,
  skills: Skill[],
  disabledPaths: Set<string> = new Set(),
): string {
  const displayNames = getDisabledSkillDisplayNames(
    disabled,
    skills,
    disabledPaths,
  );
  if (displayNames.length === 0) return "No disabled skills";
  return `Disabled skills (${displayNames.length}): ${displayNames.join(", ")}`;
}

function formatDisabledList(
  disabled: Set<string>,
  disabledPaths: Set<string>,
  skills: Skill[],
  maxWidth: number,
): string {
  const message = formatDisabledSkillsMessage(disabled, skills, disabledPaths);
  const label =
    message === "No disabled skills"
      ? "Disabled: none"
      : message.replace(/^Disabled skills/, "Disabled");
  return truncateToWidth(label, maxWidth, "…", true);
}

function updateStatus(
  ctx: ExtensionContext,
  state: ToggleState,
  skills?: Skill[],
): void {
  if (!ctx.hasUI) return;

  const visibleCount = skills
    ? getDisabledSkills(skills, state.disabledSkills, state.disabledSkillPaths)
        .length
    : state.disabledSkills.size + state.disabledSkillPaths.size;

  if (visibleCount === 0) {
    ctx.ui.setStatus("skill-toggle", undefined);
    return;
  }
  ctx.ui.setStatus("skill-toggle", `Skill toggle: ${visibleCount} disabled`);
}

function isAppliedSkillLinkToggle(result: SkillLinkToggleResult): boolean {
  return result.status === "enabled" || result.status === "disabled";
}

function notifySkillLinkResult(
  ctx: ExtensionContext,
  skill: Skill,
  result: SkillLinkToggleResult,
): void {
  switch (result.status) {
    case "not-symlink":
      ctx.ui.notify(
        `Skill "${skill.name}" is not a symlink, so it was left untouched.`,
        "warning",
      );
      return;
    case "conflict":
      ctx.ui.notify(
        `Skill "${skill.name}" conflicts with existing path: ${result.path}`,
        "warning",
      );
      return;
    case "missing-link-record":
      ctx.ui.notify(
        `Skill "${skill.name}" cannot be restored because its symlink target is unknown.`,
        "warning",
      );
      return;
    default:
      ctx.ui.notify(
        `Skill "${skill.name}": ${result.status}. Run /reload to apply discovery changes.`,
        "info",
      );
  }
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
    private disabledPaths: Set<string>,
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
        const isDisabled = isSkillDisabledForList(
          skill,
          this.skills,
          this.disabled,
          this.disabledPaths,
        );

        const prefix = isSelected ? selected("▸") : border("·");
        const disabledBadge = isDisabled ? ` ${disabled("⨯")}` : "";
        const nameStr = isSelected
          ? bold(selectedText(skill.name))
          : isDisabled
            ? disabled(skill.name)
            : skill.name;
        const maxDescLen = Math.max(0, innerW - visibleWidth(skill.name) - 12);
        const detailText = [formatSkillDisplayDetails(skill), skill.description]
          .filter((value) => value.length > 0)
          .join(" — ");
        const descStr =
          maxDescLen > 3
            ? description(truncateToWidth(detailText, maxDescLen, "…"))
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
      this.disabled,
      this.disabledPaths,
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

  const getDisabledSkillCommand = (
    text: string,
    skills: Skill[],
  ): string | null => {
    if (!text.startsWith("/skill:")) return null;
    const remainder = text.slice("/skill:".length).trim();
    if (!remainder) return null;
    const name = normalizeSkillName(remainder.split(/\s+/)[0] ?? "");
    if (!name) return null;
    const disabledNames = getNameDisabledSkills(
      state.disabledSkills,
      skills,
      state.disabledSkillPaths,
    );
    return disabledNames.has(name) ? name : null;
  };

  void createLoggerReady(process.cwd());

  const refreshState = (ctx: ExtensionContext, skills?: Skill[]) => {
    if (skills) {
      pruneSettingsFiles(ctx.cwd, skills);
    }
    state = loadToggleState(ctx.cwd);
    updateStatus(ctx, state, skills);
  };

  pi.registerCommand("toggle-skill", {
    description: "Toggle symlinked skills by adding/removing skill links",
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
            state.disabledSkillPaths,
            (skill) => {
              const result = toggleSkillLink(state, skill);
              if (isAppliedSkillLinkToggle(result)) {
                syncSkillOverrides(state, skills, ctx.cwd);
              }
              updateStatus(ctx, state, skills);
              notifySkillLinkResult(ctx, skill, result);
              didToggle = didToggle || isAppliedSkillLinkToggle(result);
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

  pi.registerCommand("disabled-skills", {
    description: "Show currently disabled skills",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const skills = loadAvailableSkills(pi, ctx.cwd);
      state = loadToggleState(ctx.cwd);
      updateStatus(ctx, state, skills);
      ctx.ui.notify(
        formatDisabledSkillsMessage(
          state.disabledSkills,
          skills,
          state.disabledSkillPaths,
        ),
        "info",
      );
    },
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };
    const disabledName = getDisabledSkillCommand(
      event.text,
      loadAvailableSkills(pi, ctx.cwd),
    );
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
}
