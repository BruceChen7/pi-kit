import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearSettingsCache,
  getSettingsPaths,
  readSettingsFile,
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
    const target = path.join(cwd, ".pi", "extensions", "alpha");
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(target)).toBe(fs.realpathSync(plugin.sourcePath));

    const sharedTarget = path.join(cwd, ".pi", "extensions", "shared");
    const expectedShared = fileURLToPath(new URL("../shared", import.meta.url));
    expect(fs.lstatSync(sharedTarget).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(sharedTarget)).toBe(fs.realpathSync(expectedShared));

    const { globalPath } = getSettingsPaths(cwd);
    const settings = readSettingsFile(globalPath);
    const entry = (
      settings.pluginToggle as {
        byCwd: Record<string, { managedPlugins: string[] }>;
      }
    ).byCwd[cwd];
    expect(entry.managedPlugins).toEqual(["alpha"]);
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

    const projectExtensions = path.join(cwd, ".pi", "extensions");
    fs.symlinkSync(otherPlugin, path.join(projectExtensions, "beta"));

    expect(disablePlugin(cwd, plugin).status).toBe("disabled");
    expect(fs.existsSync(path.join(projectExtensions, "alpha"))).toBe(false);
    expect(
      fs.lstatSync(path.join(projectExtensions, "beta")).isSymbolicLink(),
    ).toBe(true);
  });

  it("does not overwrite an existing user plugin when enabling", async () => {
    createTempHome();
    const cwd = createTempDir("pi-kit-plugin-toggle-project-");
    const library = createTempDir("pi-kit-plugin-toggle-library-");
    createPluginDir(library, "alpha");
    const projectPlugin = path.join(cwd, ".pi", "extensions", "alpha");
    fs.mkdirSync(projectPlugin, { recursive: true });
    fs.writeFileSync(path.join(projectPlugin, "index.ts"), "// user plugin\n");

    const { discoverPlugins, enablePlugin } = await importPluginToggle();
    const [plugin] = discoverPlugins(library);

    expect(enablePlugin(cwd, plugin).status).toBe("conflict");
    expect(fs.existsSync(path.join(cwd, ".pi", "extensions", "shared"))).toBe(
      false,
    );
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
