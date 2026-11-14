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

const SETTINGS_FILE_NAME = "third_extension_settings.json";

const settingsCache = new Map<string, SettingsBundle>();

type GlobalSettingsCache = { globalPath: string; global: SettingsRecord };

type GlobalSettingsCacheStore = {
  value: GlobalSettingsCache | null;
};

const GLOBAL_SETTINGS_CACHE_KEY = Symbol.for("pi-kit.settings.globalCache");

const getGlobalCacheStore = (): GlobalSettingsCacheStore => {
  const store = (globalThis as Record<symbol, unknown>)[
    GLOBAL_SETTINGS_CACHE_KEY
  ];
  if (store && typeof store === "object" && "value" in store) {
    return store as GlobalSettingsCacheStore;
  }
  const next: GlobalSettingsCacheStore = { value: null };
  (globalThis as Record<symbol, unknown>)[GLOBAL_SETTINGS_CACHE_KEY] = next;
  return next;
};

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
  const cacheStore = getGlobalCacheStore();
  if (!options.forceReload && cacheStore.value) {
    return cacheStore.value;
  }

  const globalPath = getGlobalSettingsPath();
  const global = readSettingsFile(globalPath);
  const next = { globalPath, global };
  cacheStore.value = next;
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
    const cacheStore = getGlobalCacheStore();
    cacheStore.value = {
      globalPath: getGlobalSettingsPath(),
      global: settings,
    };
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
  const cacheStore = getGlobalCacheStore();
  cacheStore.value = null;
};

// ── 信任等级 ────────────────────────────────────────────────────────────
//
// `merged` 是 "项目覆盖全局"。对一个普通偏好项这没问题；对一个护栏开关就不是：
// clone 一个仓库到本机，只要它带一份 .pi/third_extension_settings.json，就能把
// 护栏放宽（ADR-0001 D2）。所以护栏类键走 `resolveTrustedSettings`：项目值只在
// 它"加严"时被采纳，放宽的项目值被忽略并记进诊断。

export type TrustRule = {
  /** 点分路径，例如 "planMode.guards.readBeforeWrite"。 */
  path: string;
  /** 返回 true 表示这个项目值在放宽护栏，不采纳。 */
  isWidening: (value: unknown) => boolean;
};

export type TrustedSettings = {
  effective: SettingsRecord;
  /** 被忽略的项目键，形如 "planMode.preset（项目值放宽护栏）"。 */
  ignored: string[];
};

type PathStep = string;

const pathSteps = (dotted: string): PathStep[] =>
  dotted.split(".").filter((step) => step !== "");

const readPath = (settings: SettingsRecord, steps: PathStep[]): unknown => {
  let current: unknown = settings;
  for (const step of steps) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[step];
  }
  return current;
};

const writePath = (
  settings: SettingsRecord,
  steps: PathStep[],
  value: unknown,
): SettingsRecord => {
  const [head, ...rest] = steps;
  if (head === undefined) {
    return settings;
  }
  if (rest.length === 0) {
    return { ...settings, [head]: value };
  }
  const child = isRecord(settings[head]) ? settings[head] : {};
  return { ...settings, [head]: writePath(child, rest, value) };
};

const deletePath = (
  settings: SettingsRecord,
  steps: PathStep[],
): SettingsRecord => {
  const [head, ...rest] = steps;
  if (head === undefined || !(head in settings)) {
    return settings;
  }
  if (rest.length === 0) {
    const { [head]: _removed, ...kept } = settings;
    return kept;
  }
  const child = settings[head];
  if (!isRecord(child)) {
    return settings;
  }
  return { ...settings, [head]: deletePath(child, rest) };
};

/**
 * 合并两层设置，并让 `rules` 里列出的键"只能加严"：项目值若在放宽，就保留
 * 全局值（全局也没有就删掉这个键，回到内置默认）。
 */
export const resolveTrustedSettings = (
  global: SettingsRecord,
  project: SettingsRecord,
  rules: readonly TrustRule[] = [],
): TrustedSettings => {
  let effective: SettingsRecord = { ...global, ...project };
  const ignored: string[] = [];

  for (const rule of rules) {
    const steps = pathSteps(rule.path);
    const projectValue = readPath(project, steps);
    if (projectValue === undefined || !rule.isWidening(projectValue)) {
      continue;
    }
    const globalValue = readPath(global, steps);
    effective =
      globalValue === undefined
        ? deletePath(effective, steps)
        : writePath(effective, steps, globalValue);
    ignored.push(`${rule.path}（项目值放宽护栏）`);
  }

  return { effective, ignored };
};

/**
 * 读盘并按信任等级解析。`ignored` 交给调用方上报 —— 被忽略的配置不能静默消失。
 */
export const loadTrustedSettings = (
  cwd: string,
  rules: readonly TrustRule[] = [],
  options: LoadSettingsOptions = {},
): TrustedSettings & SettingsBundle => {
  const bundle = loadSettings(cwd, options);
  const trusted = resolveTrustedSettings(bundle.global, bundle.project, rules);
  return { ...bundle, ...trusted };
};
