import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type SettingsRecord = Record<string, unknown>;

export type SettingsPaths = {
  projectPath: string;
  globalPath: string;
};

export type SettingsBundle = SettingsPaths & {
  global: SettingsRecord;
  project: SettingsRecord;
  merged: SettingsRecord;
};

export type LoadSettingsOptions = {
  forceReload?: boolean;
};

const SETTINGS_FILE_NAME = "settings.json";

const settingsCache = new Map<string, SettingsBundle>();
let globalCache: { globalPath: string; global: SettingsRecord } | null = null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const normalizeSettings = (value: unknown): SettingsRecord =>
  isRecord(value) ? value : {};

const normalizePath = (value: string): string => path.resolve(value);

const normalizeCwd = (cwd: string): string => path.resolve(cwd);

export const getGlobalSettingsPath = (): string =>
  path.join(os.homedir(), ".pi", "agent", SETTINGS_FILE_NAME);

export const getSettingsPaths = (cwd: string): SettingsPaths => ({
  projectPath: path.join(cwd, ".pi", SETTINGS_FILE_NAME),
  globalPath: getGlobalSettingsPath(),
});

export const readSettingsFile = (filePath: string): SettingsRecord => {
  try {
    if (!fs.existsSync(filePath)) {
      return {};
    }
    const content = fs.readFileSync(filePath, "utf-8");
    return normalizeSettings(JSON.parse(content));
  } catch {
    return {};
  }
};

export const loadGlobalSettings = (
  options: LoadSettingsOptions = {},
): { globalPath: string; global: SettingsRecord } => {
  if (!options.forceReload && globalCache) {
    return globalCache;
  }

  const globalPath = getGlobalSettingsPath();
  const global = readSettingsFile(globalPath);
  const next = { globalPath, global };
  globalCache = next;
  return next;
};

export const loadSettings = (
  cwd: string,
  options: LoadSettingsOptions = {},
): SettingsBundle => {
  const cacheKey = normalizeCwd(cwd);
  if (!options.forceReload) {
    const cached = settingsCache.get(cacheKey);
    if (cached) {
      return cached;
    }
  }

  const { projectPath, globalPath } = getSettingsPaths(cwd);
  const { global } = loadGlobalSettings(options);
  const project = readSettingsFile(projectPath);
  const merged = { ...global, ...project };

  const bundle = {
    projectPath,
    globalPath,
    global,
    project,
    merged,
  };
  settingsCache.set(cacheKey, bundle);
  return bundle;
};

const updateCachesAfterWrite = (
  filePath: string,
  settings: SettingsRecord,
): void => {
  const normalized = normalizePath(filePath);
  const globalPath = normalizePath(getGlobalSettingsPath());

  if (normalized === globalPath) {
    globalCache = { globalPath: getGlobalSettingsPath(), global: settings };
    for (const [cwd, cached] of settingsCache) {
      settingsCache.set(cwd, {
        ...cached,
        global: settings,
        merged: { ...settings, ...cached.project },
      });
    }
    return;
  }

  for (const [cwd, cached] of settingsCache) {
    if (normalizePath(cached.projectPath) === normalized) {
      settingsCache.set(cwd, {
        ...cached,
        project: settings,
        merged: { ...cached.global, ...settings },
      });
      break;
    }
  }
};

export const writeSettingsFile = (
  filePath: string,
  settings: SettingsRecord,
): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
  updateCachesAfterWrite(filePath, settings);
};

export const updateSettings = (
  cwd: string,
  scope: "project" | "global",
  updater: (settings: SettingsRecord) => SettingsRecord | undefined,
): { path: string; settings: SettingsRecord } => {
  const { projectPath, globalPath } = getSettingsPaths(cwd);
  const targetPath = scope === "project" ? projectPath : globalPath;
  const current = readSettingsFile(targetPath);
  const next = updater(current) ?? current;
  writeSettingsFile(targetPath, next);
  return { path: targetPath, settings: next };
};

export const clearSettingsCache = (): void => {
  settingsCache.clear();
  globalCache = null;
};
