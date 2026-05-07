import path from "node:path";
import {
  getSettingsPaths,
  readSettingsFile,
  writeSettingsFile,
} from "../shared/settings.ts";
import { DEFAULT_DISABLED_PLUGINS } from "./constants.ts";
import { isRecord, normalizeName, toStringList } from "./utils.ts";

interface PluginToggleSettingsEntry {
  managedPlugins?: string[];
}

interface PluginToggleSettings {
  byCwd?: Record<string, PluginToggleSettingsEntry>;
  defaultDisabledPlugins?: string[];
}

function getCwdKey(cwd: string): string {
  return path.resolve(cwd);
}

export class PluginToggleSettingsStore {
  private globalPath: string;
  private cwdKey: string;

  constructor(cwd: string) {
    this.globalPath = getSettingsPaths(cwd).globalPath;
    this.cwdKey = getCwdKey(cwd);
  }

  readDefaultDisabledPlugins(): Set<string> {
    const { pluginToggle } = this.readState();
    const disabled = Array.isArray(pluginToggle.defaultDisabledPlugins)
      ? toStringList(pluginToggle.defaultDisabledPlugins)
      : DEFAULT_DISABLED_PLUGINS;
    return new Set(disabled.map(normalizeName));
  }

  hasManagedPluginsEntry(): boolean {
    const { byCwd } = this.readState();
    const entry = byCwd[this.cwdKey];
    return isRecord(entry) && Array.isArray(entry.managedPlugins);
  }

  readManagedPlugins(): Set<string> {
    const { byCwd } = this.readState();
    const entry = byCwd[this.cwdKey] ?? {};
    return new Set(toStringList(entry.managedPlugins).map(normalizeName));
  }

  markEnabled(pluginName: string): void {
    const managed = this.readManagedPlugins();
    managed.add(normalizeName(pluginName));
    this.writeManagedPlugins(managed);
  }

  markDisabled(pluginName: string): void {
    const managed = this.readManagedPlugins();
    managed.delete(normalizeName(pluginName));
    this.writeManagedPlugins(managed);
  }

  ensureManagedPluginsEntry(): void {
    this.writeManagedPlugins(this.readManagedPlugins());
  }

  private readState(): {
    settings: Record<string, unknown>;
    pluginToggle: PluginToggleSettings;
    byCwd: Record<string, PluginToggleSettingsEntry>;
  } {
    const settings = readSettingsFile(this.globalPath);
    const pluginToggle = isRecord(settings.pluginToggle)
      ? (settings.pluginToggle as PluginToggleSettings)
      : {};
    const byCwd = isRecord(pluginToggle.byCwd)
      ? { ...(pluginToggle.byCwd as Record<string, PluginToggleSettingsEntry>) }
      : {};
    return { settings, pluginToggle, byCwd };
  }

  private writeManagedPlugins(managed: Set<string>): void {
    const { settings, pluginToggle, byCwd } = this.readState();
    const entry = isRecord(byCwd[this.cwdKey]) ? byCwd[this.cwdKey] : {};
    byCwd[this.cwdKey] = {
      ...entry,
      managedPlugins: Array.from(managed).sort(),
    };
    settings.pluginToggle = { ...pluginToggle, byCwd };
    writeSettingsFile(this.globalPath, settings);
  }
}
