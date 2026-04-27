/**
 * /toggle-plugin
 *
 * Manage project-local Pi extension symlinks from a shared plugin library.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@mariozechner/pi-tui";
import {
  getSettingsPaths,
  readSettingsFile,
  writeSettingsFile,
} from "../shared/settings.ts";

export interface PluginEntry {
  name: string;
  enabledName: string;
  sourcePath: string;
  kind: "directory" | "file";
}

interface PluginToggleSettingsEntry {
  managedPlugins?: string[];
}

interface PluginToggleSettings {
  byCwd?: Record<string, PluginToggleSettingsEntry>;
}

export type ToggleResult =
  | { status: "enabled" | "disabled" | "already-enabled" | "already-disabled" }
  | { status: "conflict"; path: string };

interface MigrationItem {
  name: string;
  sourcePath: string;
  targetPath: string;
}

interface MigrationOptions {
  home?: string;
  globalDir?: string;
  libraryDir?: string;
}

const DEFAULT_LIBRARY_DIR = path.join(os.homedir(), ".agents", "pi-plugins");
const GLOBAL_EXTENSION_DIR = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "extensions",
);
const GLOBAL_AUTOLOAD_BOOTSTRAP_ENTRIES = new Set(["plugin-toggle", "shared"]);
const PROJECT_EXTENSION_DIR = path.join(".pi", "extensions");
const PICKER_PAGE_SIZE = 8;
const SHARED_EXTENSION_NAME = "shared";
const PLUGIN_TOGGLE_EXTENSION_DIR = path.dirname(
  fileURLToPath(import.meta.url),
);

const normalizeName = (name: string): string => name.trim().toLowerCase();
const projectExtensionsDir = (cwd: string): string =>
  path.join(cwd, PROJECT_EXTENSION_DIR);
const pluginTargetPath = (cwd: string, plugin: PluginEntry): string =>
  path.join(projectExtensionsDir(cwd), plugin.enabledName);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function getCwdKey(cwd: string): string {
  return path.resolve(cwd);
}

function getPluginToggleSettings(filePath: string): {
  settings: Record<string, unknown>;
  pluginToggle: PluginToggleSettings;
  byCwd: Record<string, PluginToggleSettingsEntry>;
} {
  const settings = readSettingsFile(filePath);
  const pluginToggle = isRecord(settings.pluginToggle)
    ? (settings.pluginToggle as PluginToggleSettings)
    : {};
  const byCwd = isRecord(pluginToggle.byCwd)
    ? { ...(pluginToggle.byCwd as Record<string, PluginToggleSettingsEntry>) }
    : {};
  return { settings, pluginToggle, byCwd };
}

function readManagedPlugins(cwd: string): Set<string> {
  const { globalPath } = getSettingsPaths(cwd);
  const { byCwd } = getPluginToggleSettings(globalPath);
  const entry = byCwd[getCwdKey(cwd)] ?? {};
  return new Set(toStringList(entry.managedPlugins).map(normalizeName));
}

function writeManagedPlugins(cwd: string, managed: Set<string>): void {
  const { globalPath } = getSettingsPaths(cwd);
  const { settings, pluginToggle, byCwd } = getPluginToggleSettings(globalPath);
  const key = getCwdKey(cwd);
  const entry = isRecord(byCwd[key]) ? byCwd[key] : {};
  byCwd[key] = {
    ...entry,
    managedPlugins: Array.from(managed).sort(),
  };
  settings.pluginToggle = { ...pluginToggle, byCwd };
  writeSettingsFile(globalPath, settings);
}

function updateManagedPlugin(
  cwd: string,
  pluginName: string,
  update: (managed: Set<string>, normalizedName: string) => void,
): void {
  const managed = readManagedPlugins(cwd);
  update(managed, normalizeName(pluginName));
  writeManagedPlugins(cwd, managed);
}

function statTargetOrNull(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function isDirectoryTarget(filePath: string): boolean {
  return statTargetOrNull(filePath)?.isDirectory() ?? false;
}

function isPluginDir(dir: string): boolean {
  return fs.existsSync(path.join(dir, "index.ts"));
}

function isPluginFile(file: string): boolean {
  return file.endsWith(".ts") && path.basename(file) !== "index.ts";
}

export function getDefaultPluginLibraryDir(): string {
  return DEFAULT_LIBRARY_DIR;
}

export function discoverPlugins(
  libraryDir = DEFAULT_LIBRARY_DIR,
): PluginEntry[] {
  if (!fs.existsSync(libraryDir)) return [];

  const plugins: PluginEntry[] = [];
  for (const entryName of fs.readdirSync(libraryDir).sort()) {
    if (entryName.startsWith(".")) continue;
    const sourcePath = path.join(libraryDir, entryName);
    const stat = statTargetOrNull(sourcePath);
    if (!stat) continue;

    if (stat.isDirectory() && isPluginDir(sourcePath)) {
      plugins.push({
        name: entryName,
        enabledName: entryName,
        sourcePath,
        kind: "directory",
      });
      continue;
    }

    if (stat.isFile() && isPluginFile(sourcePath)) {
      const name = path.basename(entryName, ".ts");
      plugins.push({
        name,
        enabledName: entryName,
        sourcePath,
        kind: "file",
      });
    }
  }

  return plugins.sort((left, right) => left.name.localeCompare(right.name));
}

function realPathOrNull(filePath: string): string | null {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return null;
  }
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
  const targetPath = pluginTargetPath(cwd, plugin);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });

  try {
    const stat = fs.lstatSync(targetPath);
    if (stat.isSymbolicLink() && symlinkPointsToPlugin(targetPath, plugin)) {
      const sharedConflict = ensureSharedDependency(cwd, plugin);
      if (sharedConflict) return sharedConflict;

      updateManagedPlugin(cwd, plugin.name, (managed, name) =>
        managed.add(name),
      );
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
  updateManagedPlugin(cwd, plugin.name, (managed, name) => managed.add(name));
  return { status: "enabled" };
}

export function disablePlugin(cwd: string, plugin: PluginEntry): ToggleResult {
  const targetPath = pluginTargetPath(cwd, plugin);
  const managed = readManagedPlugins(cwd);
  const normalizedName = normalizeName(plugin.name);

  if (!fs.existsSync(targetPath)) {
    updateManagedPlugin(cwd, plugin.name, (managed, name) =>
      managed.delete(name),
    );
    return { status: "already-disabled" };
  }

  const stat = fs.lstatSync(targetPath);
  if (
    !stat.isSymbolicLink() ||
    !managed.has(normalizedName) ||
    !symlinkPointsToPlugin(targetPath, plugin)
  ) {
    return { status: "conflict", path: targetPath };
  }

  fs.unlinkSync(targetPath);
  updateManagedPlugin(cwd, plugin.name, (managed, name) =>
    managed.delete(name),
  );
  return { status: "disabled" };
}

export function getEnabledManagedPlugins(
  cwd: string,
  plugins: PluginEntry[],
): string[] {
  const managed = readManagedPlugins(cwd);
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

function globalPluginEntries(globalDir: string): PluginEntry[] {
  if (!fs.existsSync(globalDir)) return [];
  const plugins: PluginEntry[] = [];
  for (const entryName of fs.readdirSync(globalDir).sort()) {
    if (entryName === "shared" || entryName.startsWith(".")) continue;
    const sourcePath = path.join(globalDir, entryName);
    const stat = fs.lstatSync(sourcePath);
    if (
      (stat.isDirectory() || stat.isSymbolicLink()) &&
      fs.existsSync(path.join(sourcePath, "index.ts"))
    ) {
      plugins.push({
        name: entryName,
        enabledName: entryName,
        sourcePath,
        kind: "directory",
      });
    } else if (
      (stat.isFile() || stat.isSymbolicLink()) &&
      isPluginFile(sourcePath)
    ) {
      plugins.push({
        name: path.basename(entryName, ".ts"),
        enabledName: entryName,
        sourcePath,
        kind: "file",
      });
    }
  }
  return plugins;
}

export function migrateGlobalPlugins(options: MigrationOptions = {}): {
  migrated: MigrationItem[];
  needsConfirmation: MigrationItem[];
  skipped: MigrationItem[];
} {
  const home = options.home ?? os.homedir();
  const globalDir =
    options.globalDir ?? path.join(home, ".pi", "agent", "extensions");
  const libraryDir =
    options.libraryDir ?? path.join(home, ".agents", "pi-plugins");
  const migrated: MigrationItem[] = [];
  const needsConfirmation: MigrationItem[] = [];
  const skipped: MigrationItem[] = [];

  for (const plugin of globalPluginEntries(globalDir)) {
    const targetPath = path.join(libraryDir, plugin.enabledName);
    const item = {
      name: plugin.name,
      sourcePath: plugin.sourcePath,
      targetPath,
    };
    const stat = fs.lstatSync(plugin.sourcePath);

    if (!stat.isSymbolicLink()) {
      needsConfirmation.push(item);
      continue;
    }

    if (fs.existsSync(targetPath)) {
      skipped.push(item);
      continue;
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const linkTarget = fs.readlinkSync(plugin.sourcePath);
    fs.symlinkSync(linkTarget, targetPath);
    fs.unlinkSync(plugin.sourcePath);
    migrated.push(item);
  }

  return { migrated, needsConfirmation, skipped };
}

function filterPlugins(plugins: PluginEntry[], query: string): PluginEntry[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return plugins;
  return plugins.filter((plugin) =>
    plugin.name.toLowerCase().includes(normalized),
  );
}

function isGlobalAutoloadPlugin(entry: string): boolean {
  return (
    !entry.startsWith(".") &&
    !entry.endsWith(".log") &&
    !GLOBAL_AUTOLOAD_BOOTSTRAP_ENTRIES.has(entry)
  );
}

export class PluginTogglePicker {
  private filtered: PluginEntry[];
  private selected = 0;
  private query = "";

  constructor(
    private plugins: PluginEntry[],
    private enabled: Set<string>,
    private onToggle: (plugin: PluginEntry) => void,
    private onClose: () => void,
    private onUpdate: () => void,
  ) {
    this.filtered = plugins;
  }

  getSelectedName(): string | null {
    return this.filtered[this.selected]?.name ?? null;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.onClose();
      return;
    }
    if (matchesKey(data, "return")) {
      const plugin = this.filtered[this.selected];
      if (plugin) this.onToggle(plugin);
      return;
    }
    if (data === "k" || data === "\u001b[A") {
      this.moveSelection(-1);
      return;
    }
    if (data === "j" || data === "\u001b[B") {
      this.moveSelection(1);
      return;
    }
    if (matchesKey(data, "backspace")) {
      this.query = this.query.slice(0, -1);
      this.updateFilter();
      return;
    }
    if (data.length === 1 && data.charCodeAt(0) >= 32) {
      this.query += data;
      this.updateFilter();
    }
  }

  private moveSelection(delta: number): void {
    const lastIndex = Math.max(0, this.filtered.length - 1);
    this.selected = Math.min(lastIndex, Math.max(0, this.selected + delta));
  }

  private updateFilter(): void {
    this.filtered = filterPlugins(this.plugins, this.query);
    this.selected = 0;
    this.onUpdate();
  }

  render(width: number): string[] {
    const innerW = Math.max(20, width - 2);
    const border = (text: string) => `\x1b[2m${text}\x1b[0m`;
    const active = (text: string) => `\x1b[36m${text}\x1b[0m`;
    const muted = (text: string) => `\x1b[2m${text}\x1b[0m`;
    const reverse = (text: string) => `\x1b[7m${text}\x1b[0m`;
    const row = (content: string, isSelected = false) => {
      const body = truncateToWidth(` ${content}`, innerW, "…", true);
      return border("│") + (isSelected ? reverse(body) : body) + border("│");
    };
    const pluginRowContent = (plugin: PluginEntry, isSelected: boolean) => {
      const marker = isSelected ? "▸" : "·";
      const isEnabled = this.enabled.has(normalizeName(plugin.name));
      const enabledMark = isEnabled ? "✓" : " ";
      if (isSelected || !isEnabled) {
        return `${marker} ${enabledMark} ${plugin.name}`;
      }
      return `${marker} ${active(enabledMark)} ${plugin.name}`;
    };
    const title = " Plugin Picker ";
    const borderLen = Math.max(0, innerW - visibleWidth(title));
    const left = Math.floor(borderLen / 2);
    const right = borderLen - left;
    const lines = [
      border(`╭${"─".repeat(left)}`) +
        active(title) +
        border(`${"─".repeat(right)}╮`),
    ];
    lines.push(row(`Search: ${this.query || muted("type to filter...")}`));
    lines.push(border(`├${"─".repeat(innerW)}┤`));
    const pageStart =
      Math.floor(this.selected / PICKER_PAGE_SIZE) * PICKER_PAGE_SIZE;
    const visiblePlugins = this.filtered.slice(
      pageStart,
      pageStart + PICKER_PAGE_SIZE,
    );
    for (let i = 0; i < visiblePlugins.length; i++) {
      const plugin = visiblePlugins[i];
      const pluginIndex = pageStart + i;
      const isSelected = pluginIndex === this.selected;
      lines.push(row(pluginRowContent(plugin, isSelected), isSelected));
    }
    if (this.filtered.length === 0)
      lines.push(row(muted("No matching plugins")));
    lines.push(border(`├${"─".repeat(innerW)}┤`));
    lines.push(row(muted("j/k or ↑/↓ navigate  enter toggle  esc cancel")));
    lines.push(border(`╰${"─".repeat(innerW)}╯`));
    return lines;
  }

  invalidate(): void {}
  dispose(): void {}
}

function updateStatus(ctx: ExtensionContext, enabledCount: number): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(
    "plugin-toggle",
    enabledCount > 0 ? `Plugin toggle: ${enabledCount} enabled` : undefined,
  );
}

function notifyResult(
  ctx: ExtensionContext,
  plugin: PluginEntry,
  result: ToggleResult,
): void {
  if (result.status === "conflict") {
    ctx.ui.notify(
      `Plugin "${plugin.name}" conflicts with existing path: ${result.path}`,
      "warning",
    );
    return;
  }
  ctx.ui.notify(
    `Plugin "${plugin.name}": ${result.status}. Run /reload to apply discovery changes.`,
    "info",
  );
}

export default function pluginToggleExtension(pi: ExtensionAPI): void {
  pi.registerCommand("toggle-plugin", {
    description: "Toggle project-local plugins from ~/.agents/pi-plugins",
    handler: async (_args: string, ctx: ExtensionContext) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("toggle-plugin requires interactive mode", "warning");
        return;
      }

      const plugins = discoverPlugins();
      if (plugins.length === 0) {
        ctx.ui.notify(`No plugins found in ${DEFAULT_LIBRARY_DIR}`, "warning");
        return;
      }

      const enabled = new Set(
        getEnabledManagedPlugins(ctx.cwd, plugins).map(normalizeName),
      );
      await ctx.ui.custom<void>(
        (tui, _theme, _kb, done) => {
          const picker = new PluginTogglePicker(
            plugins,
            enabled,
            (plugin) => {
              const result = enabled.has(normalizeName(plugin.name))
                ? disablePlugin(ctx.cwd, plugin)
                : enablePlugin(ctx.cwd, plugin);
              if (
                result.status === "enabled" ||
                result.status === "already-enabled"
              )
                enabled.add(normalizeName(plugin.name));
              if (
                result.status === "disabled" ||
                result.status === "already-disabled"
              )
                enabled.delete(normalizeName(plugin.name));
              updateStatus(ctx, enabled.size);
              notifyResult(ctx, plugin, result);
              tui.requestRender();
            },
            () => done(),
            () => tui.requestRender(),
          );
          return {
            render: (width: number) => picker.render(width),
            invalidate: () => picker.invalidate(),
            handleInput: (data: string) => {
              picker.handleInput(data);
              tui.requestRender();
            },
          };
        },
        { overlay: true, overlayOptions: { anchor: "center", width: 70 } },
      );
    },
  });

  pi.registerCommand("enabled-plugins", {
    description: "Show enabled project-local managed plugins",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const plugins = discoverPlugins();
      const enabled = getEnabledManagedPlugins(ctx.cwd, plugins);
      updateStatus(ctx, enabled.length);
      ctx.ui.notify(formatEnabledPluginsMessage(enabled), "info");
    },
  });

  pi.registerCommand("installed-plugins", {
    description: "Show installed project-local plugins from .pi/extensions",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const installed = getInstalledProjectPlugins(ctx.cwd);
      ctx.ui.notify(formatInstalledPluginsMessage(installed), "info");
    },
  });

  pi.registerCommand("migrate-global-plugins", {
    description:
      "Move global symlink plugins to ~/.agents/pi-plugins for project opt-in",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const result = migrateGlobalPlugins();
      const parts = [
        `${result.migrated.length} migrated`,
        `${result.needsConfirmation.length} need confirmation`,
        `${result.skipped.length} skipped`,
      ];
      ctx.ui.notify(`Global plugin migration: ${parts.join(", ")}`, "info");
      if (result.needsConfirmation.length > 0) {
        ctx.ui.notify(
          `Real global plugins were left untouched: ${result.needsConfirmation.map((item) => item.name).join(", ")}`,
          "warning",
        );
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const enabled = getEnabledManagedPlugins(ctx.cwd, discoverPlugins());
    updateStatus(ctx, enabled.length);
    if (fs.existsSync(GLOBAL_EXTENSION_DIR)) {
      const globals = fs
        .readdirSync(GLOBAL_EXTENSION_DIR)
        .filter(isGlobalAutoloadPlugin);
      if (globals.length > 0 && ctx.hasUI) {
        ctx.ui.notify(
          "Global plugins still auto-load in every project. Use /migrate-global-plugins to opt in per project.",
          "info",
        );
      }
    }
  });
}
