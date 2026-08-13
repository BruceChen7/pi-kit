/**
 * /toggle-plugin
 *
 * Manage project-local Pi extension symlinks from a shared plugin library.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { bootstrapDefaultManagedPlugins } from "./bootstrap.ts";
import {
  DEFAULT_BOOTSTRAP_SUCCESS_MESSAGE,
  DEFAULT_LIBRARY_DIR,
  WORKTREE_LINK_CREATED_MESSAGE,
} from "./constants.ts";
import { discoverPlugins } from "./library.ts";
import { PluginTogglePicker } from "./picker.ts";
import {
  cleanupBrokenPluginSymlinks,
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
import { ensureSharedWorktreeConfig } from "./worktree.ts";

export { bootstrapDefaultManagedPlugins } from "./bootstrap.ts";
export {
  discoverPlugins,
  getDefaultPluginLibraryDir,
  installThirdPartyPluginToLibrary,
  readPluginLibraryManifest,
} from "./library.ts";
export { PluginTogglePicker } from "./picker.ts";
export {
  cleanupBrokenPluginSymlinks,
  disablePlugin,
  enablePlugin,
  formatEnabledPluginsMessage,
  formatInstalledPluginsMessage,
  getEnabledManagedPlugins,
  getInstalledProjectPlugins,
  isPluginEnabled,
  removePluginSymlink,
} from "./project.ts";
export type {
  PluginToggleSettings,
  PluginToggleSettingsEntry,
  ResolvedPluginToggleEntry,
} from "./settings-store.ts";
export {
  computeDiffs,
  computeEffectivePlugins,
  PluginToggleSettingsStore,
} from "./settings-store.ts";
export type {
  DefaultBootstrapResult,
  PluginEntry,
  PluginLibraryManifest,
  PluginLibraryManifestEntry,
  ThirdPartyInstallOptions,
  ThirdPartyInstallResult,
  ThirdPartySourceKind,
  ToggleResult,
} from "./types.ts";
export {
  ensureSharedWorktreeConfig,
  findGitWorktreeRoot,
  parseMainWorktreePath,
  resolveSharedProjectRoot,
} from "./worktree.ts";

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

      cleanupBrokenPluginSymlinks(ctx.cwd, plugins);

      const enabled = new Set(
        getEnabledManagedPlugins(ctx.cwd, plugins).map(normalizeName),
      );
      await ctx.ui.custom<void>(
        (tui, _theme, _kb, done) => {
          const picker = new PluginTogglePicker(
            plugins,
            enabled,
            (plugin) => {
              const { result, nextEnabled } = toggleManagedPlugin(
                ctx.cwd,
                plugin,
                enabled,
              );
              // The picker shares the same Set instance; sync it in the
              // shell so the checkbox state follows the toggle result.
              enabled.clear();
              for (const name of nextEnabled) {
                enabled.add(name);
              }
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

  pi.on("session_start", async (_event, ctx) => {
    const worktreeStatus = ensureSharedWorktreeConfig(ctx.cwd);
    if (worktreeStatus === "created" && ctx.hasUI) {
      ctx.ui.notify(WORKTREE_LINK_CREATED_MESSAGE, "info");
    }
    const plugins = discoverPlugins();
    cleanupBrokenPluginSymlinks(ctx.cwd, plugins);
    const bootstrap = bootstrapDefaultManagedPlugins(ctx.cwd, plugins);
    notifyDefaultBootstrapWarnings(ctx, bootstrap);
    if (bootstrap.enabled.length > 0 || bootstrap.removed.length > 0) {
      if (ctx.hasUI) {
        ctx.ui.notify(DEFAULT_BOOTSTRAP_SUCCESS_MESSAGE, "info");
      }
    }
  });
}
