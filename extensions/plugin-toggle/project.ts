import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  GLOBAL_EXTENSION_DIR,
  PLUGIN_TOGGLE_EXTENSION_DIR,
  SHARED_EXTENSION_NAME,
} from "./constants.ts";
import { isPluginDir, isPluginFile } from "./library.ts";
import { PluginToggleSettingsStore } from "./settings-store.ts";
import type { PluginEntry, ToggleResult } from "./types.ts";
import {
  normalizeName,
  pluginTargetPath,
  projectExtensionsDir,
  realPathOrNull,
  statTargetOrNull,
} from "./utils.ts";

function isDirectoryTarget(filePath: string): boolean {
  return statTargetOrNull(filePath)?.isDirectory() ?? false;
}

function symlinkPointsToPlugin(
  targetPath: string,
  plugin: PluginEntry,
): boolean {
  const targetRealPath = realPathOrNull(targetPath);
  const sourceRealPath = realPathOrNull(plugin.sourcePath);
  return Boolean(
    targetRealPath && sourceRealPath && targetRealPath === sourceRealPath,
  );
}

function symlinkTargetMatchesPath(
  targetPath: string,
  expectedPath: string,
): boolean {
  const linkTarget = fs.readlinkSync(targetPath);
  const resolvedTarget = path.isAbsolute(linkTarget)
    ? linkTarget
    : path.resolve(path.dirname(targetPath), linkTarget);
  return path.resolve(resolvedTarget) === path.resolve(expectedPath);
}

function symlinkReferencesPlugin(
  targetPath: string,
  plugin: PluginEntry,
): boolean {
  return (
    symlinkPointsToPlugin(targetPath, plugin) ||
    symlinkTargetMatchesPath(targetPath, plugin.sourcePath)
  );
}

function findSharedSourcePath(plugin: PluginEntry): string | null {
  const pluginRealPath = realPathOrNull(plugin.sourcePath);
  const candidates = [
    path.join(PLUGIN_TOGGLE_EXTENSION_DIR, "..", SHARED_EXTENSION_NAME),
    path.join(GLOBAL_EXTENSION_DIR, SHARED_EXTENSION_NAME),
    path.join(os.homedir(), ".pi", "agent", SHARED_EXTENSION_NAME),
    pluginRealPath
      ? path.join(path.dirname(pluginRealPath), SHARED_EXTENSION_NAME)
      : null,
  ];

  for (const candidate of candidates) {
    if (candidate && isDirectoryTarget(candidate)) return candidate;
  }

  return null;
}

function ensureSharedDependency(
  cwd: string,
  plugin: PluginEntry,
): ToggleResult | null {
  const targetPath = path.join(
    projectExtensionsDir(cwd),
    SHARED_EXTENSION_NAME,
  );
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });

  try {
    const stat = fs.lstatSync(targetPath);
    if (
      stat.isDirectory() ||
      (stat.isSymbolicLink() && isDirectoryTarget(targetPath))
    ) {
      return null;
    }
    return { status: "conflict", path: targetPath };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }

  const sourcePath = findSharedSourcePath(plugin);
  if (!sourcePath) return { status: "conflict", path: targetPath };

  fs.symlinkSync(sourcePath, targetPath);
  return null;
}

export function isPluginEnabled(cwd: string, plugin: PluginEntry): boolean {
  const targetPath = pluginTargetPath(cwd, plugin);
  return fs.existsSync(targetPath) && symlinkPointsToPlugin(targetPath, plugin);
}

export function enablePlugin(cwd: string, plugin: PluginEntry): ToggleResult {
  const settingsStore = new PluginToggleSettingsStore(cwd);
  const targetPath = pluginTargetPath(cwd, plugin);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });

  try {
    const stat = fs.lstatSync(targetPath);
    if (stat.isSymbolicLink() && symlinkPointsToPlugin(targetPath, plugin)) {
      const sharedConflict = ensureSharedDependency(cwd, plugin);
      if (sharedConflict) return sharedConflict;

      settingsStore.markEnabled(plugin.name);
      return { status: "already-enabled" };
    }
    return { status: "conflict", path: targetPath };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }

  const sharedConflict = ensureSharedDependency(cwd, plugin);
  if (sharedConflict) return sharedConflict;

  fs.symlinkSync(plugin.sourcePath, targetPath);
  settingsStore.markEnabled(plugin.name);
  return { status: "enabled" };
}

export function disablePlugin(cwd: string, plugin: PluginEntry): ToggleResult {
  const settingsStore = new PluginToggleSettingsStore(cwd);
  const targetPath = pluginTargetPath(cwd, plugin);
  const managed = settingsStore.readManagedPlugins();
  const normalizedName = normalizeName(plugin.name);

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(targetPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;

    settingsStore.markDisabled(plugin.name);
    return { status: "already-disabled" };
  }

  if (!stat.isSymbolicLink() || !managed.has(normalizedName)) {
    return { status: "conflict", path: targetPath };
  }

  if (!symlinkReferencesPlugin(targetPath, plugin)) {
    return { status: "conflict", path: targetPath };
  }

  fs.unlinkSync(targetPath);
  settingsStore.markDisabled(plugin.name);
  return { status: "disabled" };
}

export function getEnabledManagedPlugins(
  cwd: string,
  plugins: PluginEntry[],
): string[] {
  const managed = new PluginToggleSettingsStore(cwd).readManagedPlugins();
  return plugins
    .filter(
      (plugin) =>
        managed.has(normalizeName(plugin.name)) && isPluginEnabled(cwd, plugin),
    )
    .map((plugin) => plugin.name)
    .sort((left, right) => left.localeCompare(right));
}

export function formatEnabledPluginsMessage(pluginNames: string[]): string {
  if (pluginNames.length === 0) return "No enabled managed plugins";
  const sorted = [...pluginNames].sort((left, right) =>
    left.localeCompare(right),
  );
  return `Enabled managed plugins (${sorted.length}): ${sorted.join(", ")}`;
}

function isProjectInstalledPlugin(
  entryName: string,
  entryPath: string,
): boolean {
  if (
    entryName.startsWith(".") ||
    entryName.endsWith(".log") ||
    entryName === "shared"
  ) {
    return false;
  }

  const stat = statTargetOrNull(entryPath);
  if (!stat) return false;
  if (stat.isDirectory()) return isPluginDir(entryPath);
  return stat.isFile() && isPluginFile(entryName);
}

export function getInstalledProjectPlugins(cwd: string): string[] {
  const extensionDir = projectExtensionsDir(cwd);
  if (!fs.existsSync(extensionDir)) return [];

  return fs
    .readdirSync(extensionDir)
    .filter((entryName) =>
      isProjectInstalledPlugin(entryName, path.join(extensionDir, entryName)),
    )
    .map((entryName) => path.basename(entryName, ".ts"))
    .sort((left, right) => left.localeCompare(right));
}

export function formatInstalledPluginsMessage(pluginNames: string[]): string {
  if (pluginNames.length === 0) return "No installed plugins";
  const sorted = [...pluginNames].sort((left, right) =>
    left.localeCompare(right),
  );
  return `Installed plugins (${sorted.length}): ${sorted.join(", ")}`;
}

function syncEnabledSet(
  enabled: Set<string>,
  pluginName: string,
  result: ToggleResult,
): void {
  const normalizedName = normalizeName(pluginName);
  if (result.status === "enabled" || result.status === "already-enabled") {
    enabled.add(normalizedName);
    return;
  }
  if (result.status === "disabled" || result.status === "already-disabled") {
    enabled.delete(normalizedName);
  }
}

export function toggleManagedPlugin(
  cwd: string,
  plugin: PluginEntry,
  enabled: Set<string>,
): ToggleResult {
  const result = enabled.has(normalizeName(plugin.name))
    ? disablePlugin(cwd, plugin)
    : enablePlugin(cwd, plugin);
  syncEnabledSet(enabled, plugin.name, result);
  return result;
}
