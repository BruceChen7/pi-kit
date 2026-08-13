import path from "node:path";
import {
  getSettingsPaths,
  readSettingsFile,
  writeSettingsFile,
} from "../shared/settings.ts";
import { DEFAULT_DISABLED_PLUGINS } from "./constants.ts";
import { isRecord, normalizeName, toStringList } from "./utils.ts";
import { resolveSharedProjectRoot } from "./worktree.ts";

/**
 * Per-cwd difference entry. The default is "every library plugin enabled";
 * entries only record deviations from that default.
 *
 * - `enabledPlugins`: force-on overrides for plugins in the default-disabled set.
 * - `disabledPlugins`: plugins turned off relative to the default.
 * - `managedPlugins`: legacy field (pre-differential model). Read-only: folded
 *   into `enabledPlugins` on read, dropped on write.
 */
export interface PluginToggleSettingsEntry {
  enabledPlugins?: string[];
  disabledPlugins?: string[];
  managedPlugins?: string[];
}

export interface PluginToggleSettings {
  byCwd?: Record<string, PluginToggleSettingsEntry>;
  defaultDisabledPlugins?: string[];
}

/** Entry shape returned by reads: both lists always present as arrays. */
export type ResolvedPluginToggleEntry = {
  enabledPlugins: string[];
  disabledPlugins: string[];
};

function getCwdKey(cwd: string): string {
  // Linked worktrees resolve to the main repo root so worktree and root
  // sessions share one byCwd entry (see worktree.ts).
  return resolveSharedProjectRoot(cwd);
}

/**
 * The pre-worktree-sharing key for a cwd. Entries written by older versions
 * live under the plain resolved cwd path; they are read as a fallback and
 * migrated to the shared key on the next write.
 */
function getLegacyCwdKey(cwd: string): string {
  return path.resolve(cwd);
}

/**
 * Pure decision (Functional Core): the effective enabled set for a cwd.
 *
 *   effective = (library − defaultDisabled − entry.disabledPlugins) ∪ entry.enabledPlugins
 *
 * All names are normalized; names not present in the library are ignored, so
 * stale entries can never enable or disable a plugin that does not exist.
 */
export function computeEffectivePlugins(
  library: string[],
  defaultDisabled: Set<string>,
  entry: Pick<PluginToggleSettingsEntry, "enabledPlugins" | "disabledPlugins">,
): Set<string> {
  const libraryNames = new Set(library.map(normalizeName));
  const defaultDisabledNames = new Set(
    Array.from(defaultDisabled).map(normalizeName),
  );

  const effective = new Set<string>();
  for (const name of libraryNames) {
    if (!defaultDisabledNames.has(name)) effective.add(name);
  }
  for (const name of toStringList(entry.disabledPlugins)) {
    const normalized = normalizeName(name);
    if (libraryNames.has(normalized)) effective.delete(normalized);
  }
  for (const name of toStringList(entry.enabledPlugins)) {
    const normalized = normalizeName(name);
    if (libraryNames.has(normalized)) effective.add(normalized);
  }
  return effective;
}

/**
 * Pure decision (Functional Core): the minimal difference entry needed to
 * record `wantEnabled` for a plugin, given the default state. When the
 * wanted state equals the default, no difference is recorded and an entry
 * that ends up empty is removed entirely ("remove" — the caller also drops
 * any legacy key). Value in → value out, no IO.
 */
export type NextEntryDecision =
  | { kind: "write"; entry: PluginToggleSettingsEntry }
  | { kind: "remove" };

export function decideNextEntry(
  existing: PluginToggleSettingsEntry | undefined,
  pluginName: string,
  wantEnabled: boolean,
  defaultEnabled: boolean,
): NextEntryDecision {
  const normalized = normalizeName(pluginName);

  const enabled = toStringList(existing?.enabledPlugins).filter(
    (name) => normalizeName(name) !== normalized,
  );
  const disabled = toStringList(existing?.disabledPlugins).filter(
    (name) => normalizeName(name) !== normalized,
  );

  if (wantEnabled !== defaultEnabled) {
    if (wantEnabled) enabled.push(normalized);
    else disabled.push(normalized);
  }

  const nextEntry: PluginToggleSettingsEntry = {};
  if (enabled.length > 0) nextEntry.enabledPlugins = [...enabled].sort();
  if (disabled.length > 0) nextEntry.disabledPlugins = [...disabled].sort();
  // Legacy field is never written back.

  if (Object.keys(nextEntry).length === 0) {
    return { kind: "remove" };
  }
  return { kind: "write", entry: nextEntry };
}

/**
 * Pure decision: derive the minimal per-cwd difference entry that reproduces
 * `linked` as the effective enabled set (round-trips through
 * `computeEffectivePlugins`). Used by the one-off settings migration.
 */
export function computeDiffs(
  linked: Iterable<string>,
  library: string[],
  defaultDisabled: Set<string>,
): ResolvedPluginToggleEntry {
  const linkedNames = new Set(Array.from(linked).map(normalizeName));
  const libraryNames = new Set(library.map(normalizeName));
  const defaultDisabledNames = new Set(
    Array.from(defaultDisabled).map(normalizeName),
  );

  const enabledPlugins: string[] = [];
  const disabledPlugins: string[] = [];
  for (const name of libraryNames) {
    if (defaultDisabledNames.has(name)) {
      if (linkedNames.has(name)) enabledPlugins.push(name);
    } else if (!linkedNames.has(name)) {
      disabledPlugins.push(name);
    }
  }
  return {
    enabledPlugins: enabledPlugins.sort(),
    disabledPlugins: disabledPlugins.sort(),
  };
}

export class PluginToggleSettingsStore {
  private globalPath: string;
  private cwdKey: string;
  private legacyCwdKey: string;

  constructor(cwd: string) {
    this.globalPath = getSettingsPaths(cwd).globalPath;
    this.cwdKey = getCwdKey(cwd);
    this.legacyCwdKey = getLegacyCwdKey(cwd);
  }

  readDefaultDisabledPlugins(): Set<string> {
    const { pluginToggle } = this.readState();
    const disabled = Array.isArray(pluginToggle.defaultDisabledPlugins)
      ? toStringList(pluginToggle.defaultDisabledPlugins)
      : DEFAULT_DISABLED_PLUGINS;
    return new Set(disabled.map(normalizeName));
  }

  /** Raw per-cwd difference entry (legacy managedPlugins folded into enabledPlugins). */
  readEntry(): ResolvedPluginToggleEntry {
    const { byCwd } = this.readState();
    const entry = isRecord(byCwd[this.cwdKey])
      ? byCwd[this.cwdKey]
      : this.legacyCwdKey !== this.cwdKey && isRecord(byCwd[this.legacyCwdKey])
        ? byCwd[this.legacyCwdKey]
        : {};
    return {
      enabledPlugins: [
        ...toStringList(entry.enabledPlugins),
        ...toStringList(entry.managedPlugins),
      ],
      disabledPlugins: toStringList(entry.disabledPlugins),
    };
  }

  /** Effective enabled set for this cwd given the library plugin names. */
  readEffectivePlugins(library: string[]): Set<string> {
    return computeEffectivePlugins(
      library,
      this.readDefaultDisabledPlugins(),
      this.readEntry(),
    );
  }

  /**
   * Persist the minimal difference needed to record `wantEnabled` for a
   * plugin. When the wanted state equals the default, no difference is
   * recorded and an entry that ends up empty is removed entirely.
   *
   * Shell: read state → call the pure {@link decideNextEntry} → interpret
   * the decision (drop legacy key on write/remove) → persist.
   */
  setPluginState(
    pluginName: string,
    wantEnabled: boolean,
    defaultDisabled: Set<string>,
  ): void {
    const normalized = normalizeName(pluginName);
    const defaultEnabled = !defaultDisabled.has(normalized);
    const { settings, pluginToggle, byCwd } = this.readState();
    const existing = isRecord(byCwd[this.cwdKey])
      ? byCwd[this.cwdKey]
      : this.legacyCwdKey !== this.cwdKey && isRecord(byCwd[this.legacyCwdKey])
        ? byCwd[this.legacyCwdKey]
        : undefined;

    const decision = decideNextEntry(
      existing,
      normalized,
      wantEnabled,
      defaultEnabled,
    );
    if (decision.kind === "remove") {
      if (existing) {
        delete byCwd[this.cwdKey];
        if (this.legacyCwdKey !== this.cwdKey) {
          delete byCwd[this.legacyCwdKey];
        }
        settings.pluginToggle = { ...pluginToggle, byCwd };
        writeSettingsFile(this.globalPath, settings);
      }
      return;
    }

    byCwd[this.cwdKey] = decision.entry;
    if (this.legacyCwdKey !== this.cwdKey) {
      delete byCwd[this.legacyCwdKey];
    }
    settings.pluginToggle = { ...pluginToggle, byCwd };
    writeSettingsFile(this.globalPath, settings);
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
}
