import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearSettingsCache,
  getSettingsPaths,
  readSettingsFile,
  writeSettingsFile,
} from "../shared/settings.js";

const tempDirs: string[] = [];
const originalHome = process.env.HOME;
const originalCwd = process.cwd();
const DEFAULT_BOOTSTRAP_SUCCESS_MESSAGE =
  "同步插件成功，请重启 Pi 以加载新插件。";
const RELOAD_FOLLOW_UP = { deliverAs: "followUp" };
const ARROW_DOWN = "\u001b[B";
const ARROW_UP = "\u001b[A";

const createTempDir = (prefix: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

const createTempHome = (): string => {
  const dir = createTempDir("pi-kit-plugin-toggle-home-");
  process.env.HOME = dir;
  return dir;
};

const createPluginDir = (
  baseDir: string,
  name: string,
  content = "",
): string => {
  const pluginDir = path.join(baseDir, name);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "index.ts"), content);
  return pluginDir;
};

const pluginLibraryDir = (home: string): string =>
  path.join(home, ".agents", "pi-plugins");

const createPluginLibrary = (...pluginNames: string[]): string => {
  const library = pluginLibraryDir(createTempHome());
  for (const pluginName of pluginNames) {
    createPluginDir(library, pluginName);
  }
  return library;
};

const projectPluginPath = (cwd: string, name: string): string =>
  path.join(cwd, ".pi", "extensions", name);

const createInstallablePluginRoot = (prefix: string): string => {
  const pluginRoot = createTempDir(prefix);
  fs.writeFileSync(
    path.join(pluginRoot, "index.ts"),
    "export default function() {}\n",
  );
  return pluginRoot;
};

const createFakeExtensionRuntime = async () => {
  const { default: pluginToggleExtension } = await importPluginToggle();
  const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> =
    {};
  const sendUserMessage = vi.fn();
  const pi = {
    on: vi.fn(
      (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
        handlers[event] = handler;
      },
    ),
    registerCommand: vi.fn(),
    sendUserMessage,
  };
  pluginToggleExtension(pi as never);

  const runSessionStart = async (
    cwd: string,
    options: { hasUI?: boolean; notify?: typeof vi.fn } = {},
  ): Promise<void> => {
    await handlers.session_start?.(
      { type: "session_start", reason: "startup" },
      {
        cwd,
        hasUI: options.hasUI ?? false,
        ui: { setStatus: vi.fn(), notify: options.notify ?? vi.fn() },
      },
    );
  };

  return { runSessionStart, sendUserMessage };
};

const readManagedPluginNames = (cwd: string): string[] => {
  const { globalPath } = getSettingsPaths(cwd);
  const settings = readSettingsFile(globalPath);
  const entry = (
    settings.pluginToggle as {
      byCwd: Record<string, { managedPlugins: string[] }>;
    }
  ).byCwd[cwd];
  return entry.managedPlugins;
};

const restoreHome = (): void => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
};

const importPluginToggle = async () => {
  vi.resetModules();
  return await import("./index.js");
};

afterEach(() => {
  clearSettingsCache();
  restoreHome();
  process.chdir(originalCwd);
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.resetModules();
});

describe("plugin discovery", () => {
  it("discovers directory and single-file plugins from the library", async () => {
    const home = createTempHome();
    const library = path.join(home, ".agents", "pi-plugins");
    const alphaDir = createPluginDir(library, "alpha");
    fs.writeFileSync(
      path.join(alphaDir, "index.ts"),
      "export default function() {}\n",
    );
    fs.writeFileSync(
      path.join(library, "beta.ts"),
      "export default function() {}\n",
    );
    fs.mkdirSync(path.join(library, "ignored"), { recursive: true });

    const { discoverPlugins } = await importPluginToggle();
    const plugins = discoverPlugins(library);

    expect(plugins.map((plugin) => plugin.name)).toEqual(["alpha", "beta"]);
    expect(plugins[0]).toMatchObject({
      kind: "directory",
      enabledName: "alpha",
    });
    expect(plugins[1]).toMatchObject({ kind: "file", enabledName: "beta.ts" });
  });

  it("discovers symlinked directory and single-file plugins from the library", async () => {
    createTempHome();
    const source = createTempDir("pi-kit-plugin-toggle-source-");
    const library = createTempDir("pi-kit-plugin-toggle-library-");
    const alphaDir = createPluginDir(source, "alpha");
    const betaFile = path.join(source, "beta.ts");
    fs.writeFileSync(betaFile, "export default function() {}\n");
    fs.symlinkSync(alphaDir, path.join(library, "alpha"));
    fs.symlinkSync(betaFile, path.join(library, "beta.ts"));
    fs.symlinkSync(path.join(source, "missing"), path.join(library, "missing"));

    const { discoverPlugins } = await importPluginToggle();
    const plugins = discoverPlugins(library);

    expect(plugins.map((plugin) => plugin.name)).toEqual(["alpha", "beta"]);
    expect(plugins[0]).toMatchObject({ kind: "directory" });
    expect(plugins[1]).toMatchObject({ kind: "file" });
  });

  it("discovers package plugins that declare pi.extensions", async () => {
    const home = createTempHome();
    const library = path.join(home, ".agents", "pi-plugins");
    const packageDir = path.join(library, "pi-context");
    fs.mkdirSync(path.join(packageDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({ pi: { extensions: ["./src/index.ts"] } }),
    );
    fs.writeFileSync(
      path.join(packageDir, "src", "index.ts"),
      "export default function() {}\n",
    );

    const { discoverPlugins } = await importPluginToggle();
    const plugins = discoverPlugins(library);

    expect(plugins.map((plugin) => plugin.name)).toEqual(["pi-context"]);
    expect(plugins[0]).toMatchObject({
      kind: "directory",
      enabledName: "pi-context",
      sourcePath: packageDir,
    });
  });
});

describe("third-party plugin library", () => {
  it("records npm plugins in the library manifest and discovers the installed plugin", async () => {
    const home = createTempHome();
    const library = pluginLibraryDir(home);
    const packageRoot = createInstallablePluginRoot(
      "pi-kit-plugin-toggle-npm-package-",
    );

    const {
      discoverPlugins,
      installThirdPartyPluginToLibrary,
      readPluginLibraryManifest,
    } = await importPluginToggle();
    const result = installThirdPartyPluginToLibrary("npm:@scope/pkg", {
      libraryDir: library,
      npmPackageRoot: packageRoot,
    });

    expect(result).toMatchObject({ name: "scope-pkg", sourceKind: "npm" });
    expect(
      readPluginLibraryManifest(library).plugins["scope-pkg"],
    ).toMatchObject({
      kind: "npm",
      source: "npm:@scope/pkg",
    });
    expect(discoverPlugins(library).map((plugin) => plugin.name)).toContain(
      "scope-pkg",
    );
  });

  it("records github plugins in the library manifest and discovers the installed plugin", async () => {
    const home = createTempHome();
    const library = pluginLibraryDir(home);
    const repoRoot = createInstallablePluginRoot(
      "pi-kit-plugin-toggle-github-repo-",
    );

    const {
      discoverPlugins,
      installThirdPartyPluginToLibrary,
      readPluginLibraryManifest,
    } = await importPluginToggle();
    const result = installThirdPartyPluginToLibrary("github:owner/repo@v1", {
      libraryDir: library,
      githubRepoRoot: repoRoot,
    });

    expect(result).toMatchObject({ name: "repo", sourceKind: "github" });
    expect(readPluginLibraryManifest(library).plugins.repo).toMatchObject({
      kind: "github",
      source: "github:owner/repo@v1",
    });
    expect(discoverPlugins(library).map((plugin) => plugin.name)).toContain(
      "repo",
    );
  });

  it("rejects unsupported third-party plugin sources before installing", async () => {
    const home = createTempHome();
    const library = pluginLibraryDir(home);
    const repoRoot = createInstallablePluginRoot(
      "pi-kit-plugin-toggle-invalid-source-",
    );

    const { installThirdPartyPluginToLibrary } = await importPluginToggle();

    expect(() =>
      installThirdPartyPluginToLibrary("not-a-supported-source", {
        libraryDir: library,
        githubRepoRoot: repoRoot,
      }),
    ).toThrow(/Unsupported plugin source/);
    expect(fs.existsSync(library)).toBe(false);
  });

  it("adds source and target context when npm installation fails", async () => {
    createTempHome();
    const library = createTempDir("pi-kit-plugin-toggle-library-");
    const source = "npm:@scope/pkg";
    const targetPath = path.join(library, "scope-pkg");
    const execFileSync = vi
      .spyOn(childProcess, "execFileSync")
      .mockImplementation(() => {
        throw new Error("npm failed");
      });

    const { installThirdPartyPluginToLibrary } = await importPluginToggle();

    try {
      expect(() =>
        installThirdPartyPluginToLibrary(source, { libraryDir: library }),
      ).toThrow(
        `Failed to install plugin from ${source} during npm pack into ${targetPath}: npm failed`,
      );
    } finally {
      execFileSync.mockRestore();
    }
  });
});

describe("project symlink management", () => {
  it("enables a plugin by creating a project symlink and recording managed state", async () => {
    createTempHome();
    const cwd = createTempDir("pi-kit-plugin-toggle-project-");
    const library = createTempDir("pi-kit-plugin-toggle-library-");
    createPluginDir(library, "alpha");

    const { discoverPlugins, enablePlugin } = await importPluginToggle();
    const [plugin] = discoverPlugins(library);

    const result = enablePlugin(cwd, plugin);

    expect(result.status).toBe("enabled");
    const target = projectPluginPath(cwd, "alpha");
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(target)).toBe(fs.realpathSync(plugin.sourcePath));

    const sharedTarget = projectPluginPath(cwd, "shared");
    const expectedShared = fileURLToPath(new URL("../shared", import.meta.url));
    expect(fs.lstatSync(sharedTarget).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(sharedTarget)).toBe(fs.realpathSync(expectedShared));

    expect(readManagedPluginNames(cwd)).toEqual(["alpha"]);
  });

  it("disables only managed symlinks that point into the plugin library", async () => {
    createTempHome();
    const cwd = createTempDir("pi-kit-plugin-toggle-project-");
    const library = createTempDir("pi-kit-plugin-toggle-library-");
    createPluginDir(library, "alpha");
    const other = createTempDir("pi-kit-plugin-toggle-other-");
    const otherPlugin = createPluginDir(other, "beta");

    const { discoverPlugins, enablePlugin, disablePlugin } =
      await importPluginToggle();
    const [plugin] = discoverPlugins(library);
    enablePlugin(cwd, plugin);

    fs.symlinkSync(otherPlugin, projectPluginPath(cwd, "beta"));

    expect(disablePlugin(cwd, plugin).status).toBe("disabled");
    expect(fs.existsSync(projectPluginPath(cwd, "alpha"))).toBe(false);
    expect(fs.lstatSync(projectPluginPath(cwd, "beta")).isSymbolicLink()).toBe(
      true,
    );
  });

  it("removes a managed broken symlink when disabling", async () => {
    createTempHome();
    const cwd = createTempDir("pi-kit-plugin-toggle-project-");
    const library = createTempDir("pi-kit-plugin-toggle-library-");
    createPluginDir(library, "alpha");

    const { discoverPlugins, enablePlugin, disablePlugin } =
      await importPluginToggle();
    const [plugin] = discoverPlugins(library);
    const target = projectPluginPath(cwd, "alpha");
    enablePlugin(cwd, plugin);
    fs.rmSync(plugin.sourcePath, { recursive: true, force: true });

    expect(disablePlugin(cwd, plugin).status).toBe("disabled");
    expect(() => fs.lstatSync(target)).toThrow();
    expect(readManagedPluginNames(cwd)).toEqual([]);
  });

  it("does not remove a conflicting symlink when the source plugin is missing", async () => {
    createTempHome();
    const cwd = createTempDir("pi-kit-plugin-toggle-project-");
    const library = createTempDir("pi-kit-plugin-toggle-library-");
    createPluginDir(library, "alpha");
    const other = createTempDir("pi-kit-plugin-toggle-other-");
    const otherPlugin = createPluginDir(other, "beta");

    const { discoverPlugins, enablePlugin, disablePlugin } =
      await importPluginToggle();
    const [plugin] = discoverPlugins(library);
    const target = projectPluginPath(cwd, "alpha");
    enablePlugin(cwd, plugin);
    fs.unlinkSync(target);
    fs.symlinkSync(otherPlugin, target);
    fs.rmSync(plugin.sourcePath, { recursive: true, force: true });

    expect(disablePlugin(cwd, plugin).status).toBe("conflict");
    expect(fs.realpathSync(target)).toBe(fs.realpathSync(otherPlugin));
  });

  it("does not overwrite an existing user plugin when enabling", async () => {
    createTempHome();
    const cwd = createTempDir("pi-kit-plugin-toggle-project-");
    const library = createTempDir("pi-kit-plugin-toggle-library-");
    createPluginDir(library, "alpha");
    const projectPlugin = projectPluginPath(cwd, "alpha");
    fs.mkdirSync(projectPlugin, { recursive: true });
    fs.writeFileSync(path.join(projectPlugin, "index.ts"), "// user plugin\n");

    const { discoverPlugins, enablePlugin } = await importPluginToggle();
    const [plugin] = discoverPlugins(library);

    expect(enablePlugin(cwd, plugin).status).toBe("conflict");
    expect(fs.existsSync(projectPluginPath(cwd, "shared"))).toBe(false);
    expect(fs.readFileSync(path.join(projectPlugin, "index.ts"), "utf-8")).toBe(
      "// user plugin\n",
    );
  });
});

describe("default project bootstrap", () => {
  it("enables every library plugin except default-disabled plugins for a new cwd", async () => {
    const cwd = createTempDir("pi-kit-plugin-toggle-project-");
    const library = createPluginLibrary("alpha", "dirty-git-status");

    const { bootstrapDefaultManagedPlugins, discoverPlugins } =
      await importPluginToggle();
    const plugins = discoverPlugins(library);

    const result = bootstrapDefaultManagedPlugins(cwd, plugins);

    expect(result.enabled).toEqual(["alpha"]);
    expect(result.skippedDefaultDisabled).toEqual(["dirty-git-status"]);
    expect(fs.existsSync(projectPluginPath(cwd, "alpha"))).toBe(true);
    expect(fs.existsSync(projectPluginPath(cwd, "dirty-git-status"))).toBe(
      false,
    );
  });

  it("leaves default-disabled plugins visible as disabled choices", async () => {
    const cwd = createTempDir("pi-kit-plugin-toggle-project-");
    const library = createPluginLibrary("alpha", "dirty-git-status");

    const {
      bootstrapDefaultManagedPlugins,
      discoverPlugins,
      getEnabledManagedPlugins,
      PluginTogglePicker,
    } = await importPluginToggle();
    const plugins = discoverPlugins(library);
    bootstrapDefaultManagedPlugins(cwd, plugins);
    const enabled = new Set(getEnabledManagedPlugins(cwd, plugins));

    const picker = new PluginTogglePicker(
      plugins,
      enabled,
      () => undefined,
      () => undefined,
      () => undefined,
    );

    const rendered = picker.render(70).join("\n");
    expect(rendered).toContain("✓ alpha");
    expect(rendered).toContain("  dirty-git-status");
    picker.dispose();
  });

  it("records a new cwd even when every plugin is default-disabled", async () => {
    const cwd = createTempDir("pi-kit-plugin-toggle-project-");
    const library = createPluginLibrary("dirty-git-status");

    const { bootstrapDefaultManagedPlugins, discoverPlugins } =
      await importPluginToggle();
    bootstrapDefaultManagedPlugins(cwd, discoverPlugins(library));

    expect(readManagedPluginNames(cwd)).toEqual([]);
  });

  it("uses configured default-disabled plugins instead of the built-in list", async () => {
    const cwd = createTempDir("pi-kit-plugin-toggle-project-");
    const library = createPluginLibrary("alpha", "dirty-git-status");
    const { globalPath } = getSettingsPaths(cwd);
    writeSettingsFile(globalPath, {
      pluginToggle: { defaultDisabledPlugins: ["alpha"] },
    });

    const { bootstrapDefaultManagedPlugins, discoverPlugins } =
      await importPluginToggle();
    const plugins = discoverPlugins(library);

    const result = bootstrapDefaultManagedPlugins(cwd, plugins);

    expect(result.enabled).toEqual(["dirty-git-status"]);
    expect(result.skippedDefaultDisabled).toEqual(["alpha"]);
  });

  it("allows an empty configured default-disabled list", async () => {
    const cwd = createTempDir("pi-kit-plugin-toggle-project-");
    const library = createPluginLibrary("dirty-git-status");
    const { globalPath } = getSettingsPaths(cwd);
    writeSettingsFile(globalPath, {
      pluginToggle: { defaultDisabledPlugins: [] },
    });

    const { bootstrapDefaultManagedPlugins, discoverPlugins } =
      await importPluginToggle();
    const plugins = discoverPlugins(library);

    const result = bootstrapDefaultManagedPlugins(cwd, plugins);

    expect(result.enabled).toEqual(["dirty-git-status"]);
    expect(result.skippedDefaultDisabled).toEqual([]);
  });

  it("does not bootstrap defaults when the cwd already has an empty managed record", async () => {
    const cwd = createTempDir("pi-kit-plugin-toggle-project-");
    const library = createPluginLibrary("alpha");

    const {
      bootstrapDefaultManagedPlugins,
      disablePlugin,
      discoverPlugins,
      enablePlugin,
    } = await importPluginToggle();
    const [plugin] = discoverPlugins(library);
    enablePlugin(cwd, plugin);
    disablePlugin(cwd, plugin);

    const result = bootstrapDefaultManagedPlugins(cwd, [plugin]);

    expect(result.status).toBe("already-configured");
    expect(fs.existsSync(projectPluginPath(cwd, "alpha"))).toBe(false);
  });

  it("queues reload and notifies after bootstrapping newly enabled plugins", async () => {
    const cwd = createTempDir("pi-kit-plugin-toggle-project-");
    createPluginLibrary("alpha");
    const notify = vi.fn();
    const { runSessionStart, sendUserMessage } =
      await createFakeExtensionRuntime();

    await runSessionStart(cwd, { hasUI: true, notify });

    expect(sendUserMessage).toHaveBeenCalledWith("/reload", RELOAD_FOLLOW_UP);
    expect(notify).toHaveBeenCalledWith(
      DEFAULT_BOOTSTRAP_SUCCESS_MESSAGE,
      "info",
    );
    expect(readManagedPluginNames(cwd)).toEqual(["alpha"]);
  });

  it("does not queue reload when the cwd already has a managed record", async () => {
    const cwd = createTempDir("pi-kit-plugin-toggle-project-");
    const library = createPluginLibrary("alpha");
    const { bootstrapDefaultManagedPlugins, discoverPlugins } =
      await importPluginToggle();
    bootstrapDefaultManagedPlugins(cwd, discoverPlugins(library));
    const { runSessionStart, sendUserMessage } =
      await createFakeExtensionRuntime();

    await runSessionStart(cwd);

    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it("enables plannotator by default even after the cwd was configured", async () => {
    const cwd = createTempDir("pi-kit-plugin-toggle-project-");
    const library = createPluginLibrary("alpha", "plannotator-pi-extension");
    const { bootstrapDefaultManagedPlugins, discoverPlugins } =
      await importPluginToggle();
    const plugins = discoverPlugins(library);
    bootstrapDefaultManagedPlugins(
      cwd,
      plugins.filter((plugin) => plugin.name === "alpha"),
    );

    const result = bootstrapDefaultManagedPlugins(cwd, plugins);

    expect(result.status).toBe("bootstrapped");
    expect(result.enabled).toEqual(["plannotator-pi-extension"]);
    expect(readManagedPluginNames(cwd)).toEqual([
      "alpha",
      "plannotator-pi-extension",
    ]);
    expect(
      fs
        .lstatSync(projectPluginPath(cwd, "plannotator-pi-extension"))
        .isSymbolicLink(),
    ).toBe(true);
  });

  it("does not queue reload when every discovered plugin is default-disabled", async () => {
    const cwd = createTempDir("pi-kit-plugin-toggle-project-");
    createPluginLibrary("dirty-git-status");
    const { runSessionStart, sendUserMessage } =
      await createFakeExtensionRuntime();

    await runSessionStart(cwd);

    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(readManagedPluginNames(cwd)).toEqual([]);
  });

  it("does not default-bootstrap plugin-toggle itself", async () => {
    const cwd = createTempDir("pi-kit-plugin-toggle-project-");
    const library = createPluginLibrary("alpha", "plugin-toggle");

    const { bootstrapDefaultManagedPlugins, discoverPlugins } =
      await importPluginToggle();

    const result = bootstrapDefaultManagedPlugins(
      cwd,
      discoverPlugins(library),
    );

    expect(result.enabled).toEqual(["alpha"]);
    expect(readManagedPluginNames(cwd)).toEqual(["alpha"]);
    expect(fs.existsSync(projectPluginPath(cwd, "plugin-toggle"))).toBe(false);
  });

  it("queues reload when at least one plugin is enabled even if another plugin conflicts", async () => {
    const cwd = createTempDir("pi-kit-plugin-toggle-project-");
    createPluginLibrary("alpha", "beta");
    const projectPlugin = projectPluginPath(cwd, "beta");
    fs.mkdirSync(projectPlugin, { recursive: true });
    fs.writeFileSync(path.join(projectPlugin, "index.ts"), "// user plugin\n");
    const notify = vi.fn();
    const { runSessionStart, sendUserMessage } =
      await createFakeExtensionRuntime();

    await runSessionStart(cwd, { hasUI: true, notify });

    expect(sendUserMessage).toHaveBeenCalledWith("/reload", RELOAD_FOLLOW_UP);
    expect(readManagedPluginNames(cwd)).toEqual(["alpha"]);
    expect(notify).toHaveBeenCalledWith(
      `Default plugin bootstrap skipped conflicting paths: ${projectPlugin}`,
      "warning",
    );
  });

  it("does not overwrite an existing project plugin during bootstrap", async () => {
    const cwd = createTempDir("pi-kit-plugin-toggle-project-");
    const library = createPluginLibrary("alpha");
    const projectPlugin = projectPluginPath(cwd, "alpha");
    fs.mkdirSync(projectPlugin, { recursive: true });
    fs.writeFileSync(path.join(projectPlugin, "index.ts"), "// user plugin\n");

    const { bootstrapDefaultManagedPlugins, discoverPlugins } =
      await importPluginToggle();
    const [plugin] = discoverPlugins(library);

    const result = bootstrapDefaultManagedPlugins(cwd, [plugin]);

    expect(result.conflicts).toEqual([projectPlugin]);
    expect(fs.readFileSync(path.join(projectPlugin, "index.ts"), "utf-8")).toBe(
      "// user plugin\n",
    );
  });
});

describe("project plugin inspection", () => {
  it("lists installed project plugins from .pi/extensions", async () => {
    createTempHome();
    const cwd = createTempDir("pi-kit-plugin-toggle-project-");
    const source = createTempDir("pi-kit-plugin-toggle-source-");
    const extensionsDir = path.join(cwd, ".pi", "extensions");
    fs.mkdirSync(extensionsDir, { recursive: true });

    fs.symlinkSync(
      createPluginDir(source, "alpha"),
      path.join(extensionsDir, "alpha"),
    );
    fs.writeFileSync(path.join(extensionsDir, "beta.ts"), "");
    createPluginDir(extensionsDir, "shared");
    fs.mkdirSync(path.join(extensionsDir, "invalid"));
    fs.writeFileSync(path.join(extensionsDir, "plugin.log"), "");

    const { getInstalledProjectPlugins } = await importPluginToggle();

    expect(getInstalledProjectPlugins(cwd)).toEqual(["alpha", "beta"]);
  });
});

describe("messages and migration", () => {
  it("formats enabled and installed plugin messages", async () => {
    const { formatEnabledPluginsMessage, formatInstalledPluginsMessage } =
      await importPluginToggle();

    expect(formatEnabledPluginsMessage([])).toBe("No enabled managed plugins");
    expect(formatEnabledPluginsMessage(["beta", "alpha"])).toBe(
      "Enabled managed plugins (2): alpha, beta",
    );
    expect(formatInstalledPluginsMessage([])).toBe("No installed plugins");
    expect(formatInstalledPluginsMessage(["beta", "alpha"])).toBe(
      "Installed plugins (2): alpha, beta",
    );
  });

  it("migrates global symlink plugins into the plugin library and removes global entries", async () => {
    const home = createTempHome();
    const source = createTempDir("pi-kit-plugin-toggle-source-");
    const sourcePlugin = createPluginDir(source, "alpha");
    const globalDir = path.join(home, ".pi", "agent", "extensions");
    fs.mkdirSync(globalDir, { recursive: true });
    fs.symlinkSync(sourcePlugin, path.join(globalDir, "alpha"));

    const { migrateGlobalPlugins } = await importPluginToggle();
    const result = migrateGlobalPlugins({ home });

    expect(result.migrated.map((item) => item.name)).toEqual(["alpha"]);
    expect(fs.existsSync(path.join(globalDir, "alpha"))).toBe(false);
    expect(
      fs
        .lstatSync(path.join(home, ".agents", "pi-plugins", "alpha"))
        .isSymbolicLink(),
    ).toBe(true);
  });

  it("reports real global plugin files as needing confirmation without deleting them", async () => {
    const home = createTempHome();
    const globalDir = path.join(home, ".pi", "agent", "extensions");
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(path.join(globalDir, "alpha.ts"), "");

    const { migrateGlobalPlugins } = await importPluginToggle();
    const result = migrateGlobalPlugins({ home });

    expect(result.needsConfirmation.map((item) => item.name)).toEqual([
      "alpha",
    ]);
    expect(fs.existsSync(path.join(globalDir, "alpha.ts"))).toBe(true);
  });
});

describe("picker navigation", () => {
  const createPicker = async (pluginNames = ["alpha", "beta"]) => {
    const { PluginTogglePicker } = await importPluginToggle();
    return new PluginTogglePicker(
      pluginNames.map((name) => ({
        name,
        enabledName: name,
        sourcePath: `/tmp/${name}`,
        kind: "directory" as const,
      })),
      new Set(),
      () => undefined,
      () => undefined,
      () => undefined,
    );
  };

  it("highlights the selected row", async () => {
    const picker = await createPicker();

    expect(picker.render(70).join("\n")).toContain("\u001b[7m");
    picker.dispose();
  });

  it("keeps the selected plugin visible after moving past the first page", async () => {
    const pluginNames = Array.from(
      { length: 10 },
      (_, index) => `plugin-${index + 1}`,
    );
    const picker = await createPicker(pluginNames);

    for (let i = 0; i < 8; i++) {
      picker.handleInput(ARROW_DOWN);
    }

    const rendered = picker.render(70).join("\n");
    expect(picker.getSelectedName()).toBe("plugin-9");
    expect(rendered).toContain("plugin-9");
    picker.dispose();
  });

  it("supports arrow up and arrow down navigation", async () => {
    const picker = await createPicker();

    expect(picker.getSelectedName()).toBe("alpha");
    picker.handleInput(ARROW_DOWN);
    expect(picker.getSelectedName()).toBe("beta");
    picker.handleInput(ARROW_UP);
    expect(picker.getSelectedName()).toBe("alpha");
    picker.dispose();
  });

  it("treats plain j and k as filter text", async () => {
    const picker = await createPicker(["alpha", "jira", "kilo", "jk-tool"]);

    picker.handleInput("j");
    picker.handleInput("k");

    expect(picker.getSelectedName()).toBe("jk-tool");
    picker.dispose();
  });
});
