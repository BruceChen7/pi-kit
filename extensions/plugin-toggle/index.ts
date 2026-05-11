/**
 * /toggle-plugin
 *
 * Manage project-local Pi extension symlinks from a shared plugin library.
 */

import fs from "node:fs";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { bootstrapDefaultManagedPlugins } from "./bootstrap.ts";
import {
  DEFAULT_BOOTSTRAP_SUCCESS_MESSAGE,
  DEFAULT_LIBRARY_DIR,
  GLOBAL_AUTOLOAD_BOOTSTRAP_ENTRIES,
  GLOBAL_EXTENSION_DIR,
} from "./constants.ts";
import { discoverPlugins } from "./library.ts";
import { migrateGlobalPlugins } from "./migration.ts";
import { PluginTogglePicker } from "./picker.ts";
import {
  formatEnabledPluginsMessage,
  formatInstalledPluginsMessage,
  getEnabledManagedPlugins,
  getInstalledProjectPlugins,
  toggleManagedPlugin,
} from "./project.ts";
import type {
  DefaultBootstrapResult,
  PluginEntry,
  ToggleResult,
} from "./types.ts";
import { normalizeName } from "./utils.ts";

export { bootstrapDefaultManagedPlugins } from "./bootstrap.ts";
export {
  discoverPlugins,
  getDefaultPluginLibraryDir,
  installThirdPartyPluginToLibrary,
  readPluginLibraryManifest,
} from "./library.ts";
export { migrateGlobalPlugins } from "./migration.ts";
export { PluginTogglePicker } from "./picker.ts";
export {
  disablePlugin,
  enablePlugin,
  formatEnabledPluginsMessage,
  formatInstalledPluginsMessage,
  getEnabledManagedPlugins,
  getInstalledProjectPlugins,
  isPluginEnabled,
} from "./project.ts";
export type {
  DefaultBootstrapResult,
  MigrationItem,
  MigrationOptions,
  PluginEntry,
  PluginLibraryManifest,
  PluginLibraryManifestEntry,
  ThirdPartyInstallOptions,
  ThirdPartyInstallResult,
  ThirdPartySourceKind,
  ToggleResult,
} from "./types.ts";

function notifyDefaultBootstrapWarnings(
  ctx: ExtensionContext,
  bootstrap: DefaultBootstrapResult,
): void {
  if (!ctx.hasUI || bootstrap.conflicts.length === 0) return;

  ctx.ui.notify(
    `Default plugin bootstrap skipped conflicting paths: ${bootstrap.conflicts.join(", ")}`,
    "warning",
  );
}

function isGlobalAutoloadPlugin(entry: string): boolean {
  return (
    !entry.startsWith(".") &&
    !entry.endsWith(".log") &&
    !GLOBAL_AUTOLOAD_BOOTSTRAP_ENTRIES.has(entry)
  );
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
              const result = toggleManagedPlugin(ctx.cwd, plugin, enabled);
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
    const plugins = discoverPlugins();
    const bootstrap = bootstrapDefaultManagedPlugins(ctx.cwd, plugins);
    notifyDefaultBootstrapWarnings(ctx, bootstrap);
    if (bootstrap.enabled.length > 0) {
      if (ctx.hasUI) {
        ctx.ui.notify(DEFAULT_BOOTSTRAP_SUCCESS_MESSAGE, "info");
      }
      return;
    }
    const enabled = getEnabledManagedPlugins(ctx.cwd, plugins);
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
