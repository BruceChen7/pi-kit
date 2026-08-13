import { GLOBAL_AUTOLOAD_BOOTSTRAP_ENTRIES } from "./constants.ts";
import {
  enablePlugin,
  isPluginEnabled,
  removePluginSymlink,
} from "./project.ts";
import { PluginToggleSettingsStore } from "./settings-store.ts";
import type { DefaultBootstrapResult, PluginEntry } from "./types.ts";
import { normalizeName } from "./utils.ts";

function sortDefaultBootstrapResult(
  result: DefaultBootstrapResult,
): DefaultBootstrapResult {
  result.enabled.sort((left, right) => left.localeCompare(right));
  result.skippedDefaultDisabled.sort((left, right) =>
    left.localeCompare(right),
  );
  result.conflicts.sort((left, right) => left.localeCompare(right));
  result.removed.sort((left, right) => left.localeCompare(right));
  return result;
}

/**
 * Converge the project's .pi/extensions symlinks with the differential
 * policy: every library plugin is enabled by default (except the hardcoded
 * default-disabled set and per-cwd differences). Missing symlinks for
 * effective-enabled plugins are linked; symlinks for effective-disabled
 * plugins are removed (only when they point into the managed library).
 *
 * Bootstrap never writes settings — the symlink state converges to the
 * policy, and settings only records user differences.
 */
export function bootstrapDefaultManagedPlugins(
  cwd: string,
  plugins: PluginEntry[],
): DefaultBootstrapResult {
  const settingsStore = new PluginToggleSettingsStore(cwd);
  const defaultDisabled = settingsStore.readDefaultDisabledPlugins();
  const effective = settingsStore.readEffectivePlugins(
    plugins.map((plugin) => plugin.name),
  );

  const result: DefaultBootstrapResult = {
    status: "bootstrapped",
    enabled: [],
    skippedDefaultDisabled: [],
    conflicts: [],
    removed: [],
  };

  for (const plugin of plugins) {
    const name = normalizeName(plugin.name);
    if (GLOBAL_AUTOLOAD_BOOTSTRAP_ENTRIES.has(name)) continue;

    if (defaultDisabled.has(name) && !effective.has(name)) {
      result.skippedDefaultDisabled.push(plugin.name);
    }

    if (effective.has(name)) {
      // Already linked to this plugin: nothing to do. Anything else at the
      // target path (user plugin dir, foreign symlink) falls through to
      // enablePlugin, which reports it as a conflict without touching it.
      if (isPluginEnabled(cwd, plugin)) continue;
      const toggleResult = enablePlugin(cwd, plugin);
      if (toggleResult.status === "conflict") {
        result.conflicts.push(toggleResult.path);
        continue;
      }
      result.enabled.push(plugin.name);
    } else if (removePluginSymlink(cwd, plugin)) {
      result.removed.push(plugin.name);
    }
  }

  result.status =
    result.enabled.length > 0 || result.removed.length > 0
      ? "bootstrapped"
      : "already-configured";
  return sortDefaultBootstrapResult(result);
}
