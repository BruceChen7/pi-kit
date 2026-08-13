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
 * Pure decision (Functional Core): what the bootstrap should do for one
 * plugin, given its policy flags. IO (symlink creation/removal) is not
 * part of the decision — the shell executes the chosen action.
 *
 * - "skip": global autoload entry — never touched, never noted.
 * - "keep": effective and already linked — nothing to do.
 * - "enable": effective but not linked — create the project symlink.
 * - "remove": not effective — remove the managed symlink if present.
 *   `noteDefaultDisabled` records the plugin in `skippedDefaultDisabled`
 *   (default-disabled and not effective), orthogonal to the action.
 */
export type BootstrapDecision = {
  noteDefaultDisabled: boolean;
  action: "skip" | "keep" | "enable" | "remove";
};

export function decideBootstrapAction(input: {
  isGlobalAutoload: boolean;
  isDefaultDisabled: boolean;
  isEffective: boolean;
  isLinked: boolean;
}): BootstrapDecision {
  const { isGlobalAutoload, isDefaultDisabled, isEffective, isLinked } = input;
  if (isGlobalAutoload) {
    return { noteDefaultDisabled: false, action: "skip" };
  }
  if (isEffective) {
    return {
      noteDefaultDisabled: false,
      action: isLinked ? "keep" : "enable",
    };
  }
  return { noteDefaultDisabled: isDefaultDisabled, action: "remove" };
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
 *
 * Shell: read policy → per-plugin pure decision → execute symlink IO.
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
    const decision = decideBootstrapAction({
      isGlobalAutoload: GLOBAL_AUTOLOAD_BOOTSTRAP_ENTRIES.has(name),
      isDefaultDisabled: defaultDisabled.has(name),
      isEffective: effective.has(name),
      isLinked: isPluginEnabled(cwd, plugin),
    });

    if (decision.noteDefaultDisabled) {
      result.skippedDefaultDisabled.push(plugin.name);
    }

    switch (decision.action) {
      case "skip":
      case "keep":
        continue;
      case "enable": {
        const toggleResult = enablePlugin(cwd, plugin);
        if (toggleResult.status === "conflict") {
          result.conflicts.push(toggleResult.path);
          continue;
        }
        result.enabled.push(plugin.name);
        continue;
      }
      case "remove":
        if (removePluginSymlink(cwd, plugin)) {
          result.removed.push(plugin.name);
        }
    }
  }

  result.status =
    result.enabled.length > 0 || result.removed.length > 0
      ? "bootstrapped"
      : "already-configured";
  return sortDefaultBootstrapResult(result);
}
