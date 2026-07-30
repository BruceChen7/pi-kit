import path from "node:path";
import {
  getSettingsPaths,
  readSettingsFile,
  writeSettingsFile,
} from "../shared/settings.ts";
import { DEFAULT_DISABLED_PLUGINS } from "./constants.ts";
import { isRecord, normalizeName, toStringList } from "./utils.ts";

interface PluginToggleSettingsEntry {
  enabledPlugins?: string[];
  disabledPlugins?: string[];
  /** Legacy field, read-only: migrated into enabledPlugins on write. */
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
    return (
      isRecord(entry) &&
      (Array.isArray(entry.enabledPlugins) ||
        Array.isArray(entry.disabledPlugins) ||
        Array.isArray(entry.managedPlugins))
    );
  }

  readEnabledPlugins(): Set<string> {
    const { byCwd } = this.readState();
    const entry = byCwd[this.cwdKey] ?? {};
    const enabled = [
      ...toStringList(entry.enabledPlugins),
      // Legacy entries predate the enabled/disabled split; their
      // managedPlugins were exactly the enabled set.
      ...toStringList(entry.managedPlugins),
    ];
    return new Set(enabled.map(normalizeName));
  }

  readDisabledPlugins(): Set<string> {
    const { byCwd } = this.readState();
    const entry = byCwd[this.cwdKey] ?? {};
    return new Set(toStringList(entry.disabledPlugins).map(normalizeName));
  }

  markEnabled(pluginName: string): void {
    const enabled = this.readEnabledPlugins();
    const disabled = this.readDisabledPlugins();
    enabled.add(normalizeName(pluginName));
    disabled.delete(normalizeName(pluginName));
    this.writePluginSets(enabled, disabled);
  }

  markDisabled(pluginName: string): void {
    const enabled = this.readEnabledPlugins();
    const disabled = this.readDisabledPlugins();
    enabled.delete(normalizeName(pluginName));
    disabled.add(normalizeName(pluginName));
    this.writePluginSets(enabled, disabled);
  }

  ensureManagedPluginsEntry(): void {
    this.writePluginSets(this.readEnabledPlugins(), this.readDisabledPlugins());
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

  private writePluginSets(enabled: Set<string>, disabled: Set<string>): void {
    const { settings, pluginToggle, byCwd } = this.readState();
    const entry = isRecord(byCwd[this.cwdKey]) ? byCwd[this.cwdKey] : {};
    const nextEntry: PluginToggleSettingsEntry = {
      ...entry,
      enabledPlugins: Array.from(enabled).sort(),
      disabledPlugins: Array.from(disabled).sort(),
    };
    // Lazy migration: drop the legacy key once the new fields are written.
    delete nextEntry.managedPlugins;
    byCwd[this.cwdKey] = nextEntry;
    settings.pluginToggle = { ...pluginToggle, byCwd };
    writeSettingsFile(this.globalPath, settings);
  }
}
