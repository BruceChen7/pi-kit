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

export type SkillLinkToggleResult =
  | { status: "enabled" | "disabled" | "already-enabled" | "already-disabled" }
  | { status: "conflict"; path: string };

interface ToggleState {
  enabledSkills: Set<string>;
  disabledSkills: Set<string>;
  disabledSkillPaths: Set<string>;
  writePath: string;
  writeScope: "global";
  cwdKey: string;
  cwd: string;
}

interface PaletteTheme {
  border: string;
  title: string;
  selected: string;
  selectedText: string;
  enabledStatus: string;
  searchIcon: string;
  placeholder: string;
  description: string;
  hint: string;
}

const DEFAULT_THEME: PaletteTheme = {
  border: "2",
  title: "1;36",
  selected: "36",
  selectedText: "1;96",
  enabledStatus: "32",
  searchIcon: "36",
  placeholder: "2;3",
  description: "2",
  hint: "2",
};

const DEFAULT_SKILL_LIBRARY_DIRS = ["git-skills", "me-skills"];

const paletteTheme = loadTheme();

function projectAgentsSkillsDir(cwd: string): string {
  return path.join(cwd, ".agents", "skills");
}

function projectManagedSkillsDir(cwd: string): string {
  return path.join(cwd, ".pi", "skills");
}

function getProjectSkillLinkName(skill: Skill): string {
  return skill.name.trim() || path.basename(getSkillBasePath(skill));
}

function projectSkillTargetPath(cwd: string, skill: Skill): string {
  return path.join(
    projectManagedSkillsDir(cwd),
    getProjectSkillLinkName(skill),
  );
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

function hasProjectSkillNamed(name: string, skills: Skill[]): boolean {
  return skills.some(
    (skill) =>
      skill.scope === "project" && normalizeSkillName(skill.name) === name,
  );
}

function isNameDisabledSkill(
  skill: Skill,
  skills: Skill[],
  disabledNames: Set<string>,
  disabledPaths: Set<string>,
): boolean {
  const name = normalizeSkillName(skill.name);
  if (!disabledNames.has(name)) return false;
  if (getPathDisabledSkillNames(skills, disabledPaths).has(name)) return false;
  if (skill.scope !== "project") return true;
  return !hasProjectSkillNamed(name, skills);
}

export function isSkillDisabledForList(
  skill: Skill,
  skills: Skill[],
  disabledNames: Set<string>,
  disabledPaths: Set<string>,
): boolean {
  return (
    isSkillPathDisabled(skill, disabledPaths) ||
    isNameDisabledSkill(skill, skills, disabledNames, disabledPaths)
  );
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

function toPortablePath(value: string): string {
  const normalized = path.resolve(value);
  if (normalized === HOME_DIR) return "$HOME";
  const prefix = `${HOME_DIR}${path.sep}`;
  if (normalized.startsWith(prefix)) {
    return `$HOME${normalized.slice(HOME_DIR.length)}`;
  }
  return normalized;
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

function compareSkills(left: Skill, right: Skill): number {
  const byName = left.name.localeCompare(right.name);
  if (byName !== 0) return byName;
  return getSkillBasePath(left).localeCompare(getSkillBasePath(right));
}

function sortSkills(skills: Iterable<Skill>): Skill[] {
  return Array.from(skills).sort(compareSkills);
}

function getDefaultSkillLibraryDirs(): string[] {
  return DEFAULT_SKILL_LIBRARY_DIRS.map((name) =>
    path.join(os.homedir(), ".agents", name),
  );
}

export function loadSkills(_cwd: string): Skill[] {
  const skillsByPath = new Map<string, Skill>();
  const visitedSkillFiles = new Set<string>();

  for (const dir of getDefaultSkillLibraryDirs()) {
    scanSkillDir(dir, skillsByPath, undefined, "user", visitedSkillFiles);
  }

  return sortSkills(skillsByPath.values());
}

function scanSkillDir(
  dir: string,
  skillsByPath: Map<string, Skill>,
  visitedDirs?: Set<string>,
  scope?: Skill["scope"],
  visitedSkillFiles?: Set<string>,
  isRoot = true,
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

    const skillFile = path.join(dir, "SKILL.md");
    if (fs.existsSync(skillFile)) {
      loadSkillFromFile(skillFile, skillsByPath, scope, visitedSkillFiles);
      return;
    }

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

      if (isDirectory) {
        scanSkillDir(
          entryPath,
          skillsByPath,
          visited,
          scope,
          visitedSkillFiles,
          false,
        );
      } else if (isRoot && isFile && entry.name.endsWith(".md")) {
        loadSkillFromFile(entryPath, skillsByPath, scope, visitedSkillFiles);
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
  visitedSkillFiles?: Set<string>,
): void {
  try {
    const realFilePath = fs.realpathSync(filePath);
    if (visitedSkillFiles?.has(realFilePath)) return;

    const content = fs.readFileSync(filePath, "utf-8");
    const skillDir = path.dirname(filePath);
    const fallbackName =
      path.basename(filePath) === "SKILL.md"
        ? path.basename(skillDir)
        : path.basename(filePath, path.extname(filePath));
    const { name, description } = parseFrontmatter(content, fallbackName);

    const skill = { name, description, filePath, scope };
    const key = getSkillBasePath(skill);
    if (description && !skillsByPath.has(key)) {
      skillsByPath.set(key, skill);
      visitedSkillFiles?.add(realFilePath);
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

function getEnabledSkillNames(cwd: string): Set<string> {
  const enabled = new Set<string>();
  const managedDir = projectManagedSkillsDir(cwd);
  if (!fs.existsSync(managedDir)) return enabled;

  for (const entry of fs.readdirSync(managedDir, { withFileTypes: true })) {
    if (!entry.isSymbolicLink()) continue;
    enabled.add(normalizeSkillName(entry.name));
  }

  return enabled;
}

function removeLegacySkillToggleSettings(filePath: string): void {
  if (!fs.existsSync(filePath)) return;

  const settings = readSettingsFile(filePath);
  if (!isRecord(settings.skillToggle)) return;

  delete settings.skillToggle;
  writeSettingsFile(filePath, settings);
}

export function loadToggleState(cwd: string): ToggleState {
  const settingsCwd = resolveSettingsCwd(cwd);
  const { globalPath } = loadSettings(cwd, { forceReload: true });

  return {
    enabledSkills: getEnabledSkillNames(settingsCwd),
    disabledSkills: new Set(),
    disabledSkillPaths: new Set(),
    writePath: globalPath,
    writeScope: "global",
    cwdKey: toPortablePath(settingsCwd),
    cwd: settingsCwd,
  };
}

export function saveToggleState(_state: ToggleState): void {
  // Enabled skill state is represented by symlinks in the toggle-owned
  // .pi/skills directory. Keep this no-op for compatibility with tests
  // and any external callers that still call save after mutating state.
}

function realPathOrNull(filePath: string): string | null {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return null;
  }
}

function symlinkPointsToSkill(targetPath: string, skill: Skill): boolean {
  const targetRealPath = realPathOrNull(targetPath);
  const sourceRealPath = realPathOrNull(getSkillBasePath(skill));
  return Boolean(
    targetRealPath && sourceRealPath && targetRealPath === sourceRealPath,
  );
}

function resolveSymlinkTarget(linkPath: string): string {
  const linkTarget = fs.readlinkSync(linkPath);
  return path.isAbsolute(linkTarget)
    ? linkTarget
    : path.resolve(path.dirname(linkPath), linkTarget);
}

function symlinkTargetMatchesPath(
  targetPath: string,
  expectedPath: string,
): boolean {
  return (
    path.resolve(resolveSymlinkTarget(targetPath)) ===
    path.resolve(expectedPath)
  );
}

function symlinkReferencesSkill(targetPath: string, skill: Skill): boolean {
  return (
    symlinkPointsToSkill(targetPath, skill) ||
    symlinkTargetMatchesPath(targetPath, getSkillBasePath(skill))
  );
}

function projectDiscoverySkillPath(cwd: string, skill: Skill): string {
  return path.join(projectAgentsSkillsDir(cwd), getProjectSkillLinkName(skill));
}

function getProjectSkillStatus(
  cwd: string,
  skill: Skill,
): "absent" | "same-skill" | "conflict" {
  const discoveryPath = projectDiscoverySkillPath(cwd, skill);
  try {
    const discoveryStat = fs.lstatSync(discoveryPath);
    if (!discoveryStat.isSymbolicLink()) return "conflict";
    return symlinkReferencesSkill(discoveryPath, skill)
      ? "same-skill"
      : "conflict";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
    return "absent";
  }
}

function isSkillEnabled(state: ToggleState, skill: Skill): boolean {
  return state.enabledSkills.has(normalizeSkillName(skill.name));
}

function markSkillEnabled(state: ToggleState, skill: Skill): void {
  state.enabledSkills.add(normalizeSkillName(skill.name));
}

function markSkillDisabled(state: ToggleState, skill: Skill): void {
  state.enabledSkills.delete(normalizeSkillName(skill.name));
}

export function enableSkill(
  state: ToggleState,
  skill: Skill,
): SkillLinkToggleResult {
  const targetPath = projectSkillTargetPath(state.cwd, skill);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });

  let targetAlreadyEnabled = false;
  let createdTarget = false;
  try {
    const stat = fs.lstatSync(targetPath);
    if (!stat.isSymbolicLink() || !symlinkPointsToSkill(targetPath, skill)) {
      return { status: "conflict", path: targetPath };
    }
    targetAlreadyEnabled = true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
    fs.symlinkSync(getSkillBasePath(skill), targetPath);
    createdTarget = true;
  }

  const projectSkillStatus = getProjectSkillStatus(state.cwd, skill);
  if (projectSkillStatus === "conflict") {
    if (createdTarget) fs.unlinkSync(targetPath);
    return {
      status: "conflict",
      path: projectDiscoverySkillPath(state.cwd, skill),
    };
  }

  markSkillEnabled(state, skill);
  return targetAlreadyEnabled || projectSkillStatus === "same-skill"
    ? { status: "already-enabled" }
    : { status: "enabled" };
}

export function disableSkill(
  state: ToggleState,
  skill: Skill,
): SkillLinkToggleResult {
  const targetPath = projectSkillTargetPath(state.cwd, skill);

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(targetPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;

    markSkillDisabled(state, skill);
    return { status: "already-disabled" };
  }

  if (!stat.isSymbolicLink()) {
    return { status: "conflict", path: targetPath };
  }

  if (!symlinkReferencesSkill(targetPath, skill)) {
    return { status: "conflict", path: targetPath };
  }

  fs.unlinkSync(targetPath);
  markSkillDisabled(state, skill);
  return { status: "disabled" };
}

export function toggleSkillLink(
  state: ToggleState,
  skill: Skill,
): SkillLinkToggleResult {
  return isSkillEnabled(state, skill)
    ? disableSkill(state, skill)
    : enableSkill(state, skill);
}

export function getDisabledSkillCommandForInput(
  text: string,
  skills: Skill[],
  disabledNames: Set<string>,
  disabledPaths: Set<string>,
): string | null {
  if (!text.startsWith("/skill:")) return null;
  const remainder = text.slice("/skill:".length).trim();
  if (!remainder) return null;
  const name = normalizeSkillName(remainder.split(/\s+/)[0] ?? "");
  if (!name) return null;

  const isDisabled = skills.some(
    (skill) =>
      normalizeSkillName(skill.name) === name &&
      isSkillDisabledForList(skill, skills, disabledNames, disabledPaths),
  );
  return isDisabled ? name : null;
}

export function pruneSettingsFiles(cwd: string, _skills: Skill[]): void {
  const { globalPath } = getSettingsPaths(cwd);
  removeLegacySkillToggleSettings(globalPath);
}

function getEnabledSkillDisplayNames(
  enabled: Set<string>,
  skills: Skill[],
): string[] {
  const displayNames = skills
    .filter((skill) => enabled.has(normalizeSkillName(skill.name)))
    .map((skill) => skill.name);
  return Array.from(new Set(displayNames)).sort((left, right) =>
    left.localeCompare(right),
  );
}

export function formatDisabledSkillsMessage(
  enabled: Set<string>,
  skills: Skill[],
): string {
  const displayNames = getEnabledSkillDisplayNames(enabled, skills);
  if (displayNames.length === 0) return "No enabled managed skills";
  return `Enabled managed skills (${displayNames.length}): ${displayNames.join(", ")}`;
}

function formatManagedList(
  enabled: Set<string>,
  skills: Skill[],
  maxWidth: number,
): string {
  const message = formatDisabledSkillsMessage(enabled, skills);
  const label =
    message === "No enabled managed skills"
      ? "Enabled: none"
      : message.replace(/^Enabled managed skills/, "Enabled");
  return truncateToWidth(label, maxWidth, "…", true);
}

function updateStatus(
  ctx: ExtensionContext,
  state: ToggleState,
  skills?: Skill[],
): void {
  if (!ctx.hasUI) return;

  const visibleCount = skills
    ? getEnabledSkillDisplayNames(state.enabledSkills, skills).length
    : state.enabledSkills.size;

  if (visibleCount === 0) {
    ctx.ui.setStatus("skill-toggle", undefined);
    return;
  }
  ctx.ui.setStatus("skill-toggle", `Skill toggle: ${visibleCount} enabled`);
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
    case "conflict":
      ctx.ui.notify(
        `Skill "${skill.name}" conflicts with existing path: ${result.path}`,
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

export class SkillTogglePicker {
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
    private enabled: Set<string>,
    _disabledPaths: Set<string>,
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

    if (matchesKey(data, "up")) {
      this.moveSelection(-1);
      return;
    }

    if (matchesKey(data, "down")) {
      this.moveSelection(1);
      return;
    }

    if (matchesKey(data, "return")) {
      const skill = this.filtered[this.selected];
      if (skill) {
        this.onToggle(skill);
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

  private moveSelection(delta: -1 | 1): void {
    if (this.filtered.length === 0) return;

    const next = this.selected + delta;
    if (next < 0) {
      this.showBoundaryMessage("Top");
      return;
    }
    if (next >= this.filtered.length) {
      this.showBoundaryMessage("Bottom");
      return;
    }
    this.selected = next;
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
    const enabledStatus = (s: string) => fg(t.enabledStatus, s);
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
        const isEnabled = this.enabled.has(normalizeSkillName(skill.name));

        const prefix = isSelected ? selected("▸") : border("·");
        const enabledBadge = isEnabled ? ` ${enabledStatus("✓")}` : "";
        const nameStr = isSelected
          ? bold(selectedText(skill.name))
          : isEnabled
            ? enabledStatus(skill.name)
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
        const skillLine = `${prefix} ${nameStr}${enabledBadge}${separator}${descStr}`;
        lines.push(row(skillLine));
      }
      lines.push(emptyRow());
    }

    lines.push(border(`├${"─".repeat(innerW)}┤`));
    lines.push(emptyRow());

    const managedList = formatManagedList(
      this.enabled,
      this.skills,
      innerW - 1,
    );
    lines.push(row(hint(managedList)));

    lines.push(emptyRow());
    lines.push(border(`├${"─".repeat(innerW)}┤`));
    lines.push(emptyRow());

    const hints = `${keyHint("↑/↓")} navigate  ${keyHint("enter")} toggle  ${keyHint("esc")} cancel`;
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

  void createLoggerReady(process.cwd());

  const refreshState = (ctx: ExtensionContext, skills: Skill[]) => {
    pruneSettingsFiles(ctx.cwd, skills);
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

      const skills = loadSkills(ctx.cwd);
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
            state.enabledSkills,
            state.disabledSkillPaths,
            (skill) => {
              const result = toggleSkillLink(state, skill);
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
      const skills = loadSkills(ctx.cwd);
      state = loadToggleState(ctx.cwd);
      updateStatus(ctx, state, skills);
      ctx.ui.notify(
        formatDisabledSkillsMessage(state.enabledSkills, skills),
        "info",
      );
    },
  });

  pi.on("input", async (_event, _ctx) => ({ action: "continue" }));

  pi.on("session_start", (_event, ctx) => {
    const skills = loadSkills(ctx.cwd);
    refreshState(ctx, skills);
  });
}
