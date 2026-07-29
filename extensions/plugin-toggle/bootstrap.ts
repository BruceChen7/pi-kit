import fs from "node:fs";
import { GLOBAL_AUTOLOAD_BOOTSTRAP_ENTRIES } from "./constants.ts";
import { enablePlugin } from "./project.ts";
import { PluginToggleSettingsStore } from "./settings-store.ts";
import type { DefaultBootstrapResult, PluginEntry } from "./types.ts";
import { normalizeName, pluginTargetPath } from "./utils.ts";

function isDefaultBootstrapEntry(plugin: PluginEntry): boolean {
  return !GLOBAL_AUTOLOAD_BOOTSTRAP_ENTRIES.has(normalizeName(plugin.name));
}

function sortDefaultBootstrapResult(
  result: DefaultBootstrapResult,
): DefaultBootstrapResult {
  result.enabled.sort((left, right) => left.localeCompare(right));
  result.skippedDefaultDisabled.sort((left, right) =>
    left.localeCompare(right),
  );
  result.conflicts.sort((left, right) => left.localeCompare(right));
  return result;
}

function bootstrapPlugins(
  cwd: string,
  plugins: PluginEntry[],
  disabled: Set<string>,
): DefaultBootstrapResult {
  const result: DefaultBootstrapResult = {
    status: "bootstrapped",
    enabled: [],
    skippedDefaultDisabled: [],
    conflicts: [],
  };

  for (const plugin of plugins) {
    if (disabled.has(normalizeName(plugin.name))) {
      result.skippedDefaultDisabled.push(plugin.name);
      continue;
    }

    const toggleResult = enablePlugin(cwd, plugin);
    if (toggleResult.status === "conflict") {
      result.conflicts.push(toggleResult.path);
      continue;
    }
    result.enabled.push(plugin.name);
  }

  return result;
}

export function bootstrapDefaultManagedPlugins(
  cwd: string,
  plugins: PluginEntry[],
): DefaultBootstrapResult {
  const settingsStore = new PluginToggleSettingsStore(cwd);
  const disabled = settingsStore.readDefaultDisabledPlugins();

  if (settingsStore.hasManagedPluginsEntry()) {
    // Already configured: restore missing symlinks for managed plugins AND
    // auto-enable newly discovered plugins (not in managed, not yet linked).
    // Plugins that were explicitly disabled are removed from the managed set
    // and will be re-enabled only if they reappear in the library — this
    // matches the "new discovery" intent rather than overriding a user choice.
    const _managed = settingsStore.readManagedPlugins();
    const toBootstrap = plugins
      .filter(isDefaultBootstrapEntry)
      .filter((plugin) => !fs.existsSync(pluginTargetPath(cwd, plugin)));
    const result = bootstrapPlugins(cwd, toBootstrap, disabled);
    result.status =
      result.enabled.length > 0 ? "bootstrapped" : "already-configured";
    return sortDefaultBootstrapResult(result);
  }

  const result = bootstrapPlugins(
    cwd,
    plugins.filter(isDefaultBootstrapEntry),
    disabled,
  );
  settingsStore.ensureManagedPluginsEntry();
  return sortDefaultBootstrapResult(result);
}
