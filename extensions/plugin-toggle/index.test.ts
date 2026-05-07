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

const createPluginDir = (baseDir: string, name: string): string => {
  const pluginDir = path.join(baseDir, name);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "index.ts"), "");
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
      picker.handleInput("j");
    }

    const rendered = picker.render(70).join("\n");
    expect(picker.getSelectedName()).toBe("plugin-9");
    expect(rendered).toContain("plugin-9");
    picker.dispose();
  });

  it("supports j/k and arrow keys", async () => {
    const picker = await createPicker();

    expect(picker.getSelectedName()).toBe("alpha");
    picker.handleInput("j");
    expect(picker.getSelectedName()).toBe("beta");
    picker.handleInput("\u001b[A");
    expect(picker.getSelectedName()).toBe("alpha");
    picker.handleInput("\u001b[B");
    expect(picker.getSelectedName()).toBe("beta");
    picker.handleInput("k");
    expect(picker.getSelectedName()).toBe("alpha");
    picker.dispose();
  });
});
