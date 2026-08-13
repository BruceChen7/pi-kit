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
import { PluginToggleSettingsStore } from "./settings-store.js";

const tempDirs: string[] = [];
const originalHome = process.env.HOME;
const originalCwd = process.cwd();
const DEFAULT_BOOTSTRAP_SUCCESS_MESSAGE =
  "同步插件成功，请重启 Pi 以加载新插件。";
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

const readStoredEntry = (cwd: string) =>
  new PluginToggleSettingsStore(cwd).readEntry();

const readEffectiveNames = (cwd: string, pluginNames: string[]): string[] =>
  Array.from(
    new PluginToggleSettingsStore(cwd).readEffectivePlugins(pluginNames),
  ).sort();

const readStoredByCwd = (cwd: string): Record<string, unknown> | undefined => {
  const { globalPath } = getSettingsPaths(cwd);
  const pluginToggle = readSettingsFile(globalPath).pluginToggle;
  if (!pluginToggle || typeof pluginToggle !== "object") return undefined;
  const byCwd = (pluginToggle as { byCwd?: unknown }).byCwd;
  if (!byCwd || typeof byCwd !== "object") return undefined;
  // Stores now write canonical (realpath) keys; fixtures in this file still
  // use the raw lexical path, so fall back to it.
  let canonical: string;
  try {
    canonical = fs.realpathSync(cwd);
  } catch {
    canonical = path.resolve(cwd);
  }
  const entry =
    (byCwd as Record<string, unknown>)[canonical] ??
    (byCwd as Record<string, unknown>)[path.resolve(cwd)];
  return entry as Record<string, unknown> | undefined;
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
    const repoRoot = createTempDir("pi-kit-plugin-toggle-github-repo-");
    fs.mkdirSync(path.join(repoRoot, "extensions", "repo"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(repoRoot, "package.json"),
      JSON.stringify({ pi: { extensions: ["./extensions"] } }),
    );
    fs.writeFileSync(
      path.join(repoRoot, "extensions", "repo", "index.ts"),
      "export default function() {}\n",
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
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(library, "repo", "package.json"), "utf8"),
    );
    expect(packageJson.pi.extensions).toEqual(["extensions/repo"]);
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
  it("enables a plugin by creating a project symlink without recording the default state", async () => {
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

    // alpha is enabled by default: no settings entry is written.
    expect(readStoredByCwd(cwd)).toBeUndefined();
    expect(readStoredEntry(cwd)).toEqual({
      enabledPlugins: [],
      disabledPlugins: [],
    });
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
    expect(readStoredEntry(cwd).disabledPlugins).toEqual(["alpha"]);
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
    expect(readStoredEntry(cwd).disabledPlugins).toEqual(["alpha"]);
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

  it("replaces a broken symlink with a valid one when enabling", async () => {
    createTempHome();
    const cwd = createTempDir("pi-kit-plugin-toggle-project-");
    const library = createTempDir("pi-kit-plugin-toggle-library-");
    createPluginDir(library, "alpha");

    const { discoverPlugins, enablePlugin } = await importPluginToggle();
    const [plugin] = discoverPlugins(library);
    const target = projectPluginPath(cwd, "alpha");

    // Create a valid symlink first
    enablePlugin(cwd, plugin);
    // Delete the source to create a broken symlink
    fs.rmSync(plugin.sourcePath, { recursive: true, force: true });

    // Re-enable: should clean up the broken symlink and create a new one
    const result = enablePlugin(cwd, plugin);

    expect(result.status).toBe("enabled");
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(target)).toBe(plugin.sourcePath);
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

  it("removes a broken symlink that matches a known plugin source via cleanupBrokenPluginSymlinks", async () => {
    createTempHome();
    const cwd = createTempDir("pi-kit-plugin-toggle-project-");
    const library = createTempDir("pi-kit-plugin-toggle-library-");
    createPluginDir(library, "alpha");

    const { discoverPlugins, enablePlugin, cleanupBrokenPluginSymlinks } =
      await importPluginToggle();
    const [plugin] = discoverPlugins(library);
    const target = projectPluginPath(cwd, "alpha");

    enablePlugin(cwd, plugin);
    fs.rmSync(plugin.sourcePath, { recursive: true, force: true });

    cleanupBrokenPluginSymlinks(cwd, discoverPlugins(library));

    expect(() => fs.lstatSync(target)).toThrow();
  });

  it("does not remove a valid symlink in cleanupBrokenPluginSymlinks", async () => {
    createTempHome();
    const cwd = createTempDir("pi-kit-plugin-toggle-project-");
    const library = createTempDir("pi-kit-plugin-toggle-library-");
    createPluginDir(library, "alpha");

    const { discoverPlugins, enablePlugin, cleanupBrokenPluginSymlinks } =
      await importPluginToggle();
    const [plugin] = discoverPlugins(library);
    const target = projectPluginPath(cwd, "alpha");

    enablePlugin(cwd, plugin);

    cleanupBrokenPluginSymlinks(cwd, discoverPlugins(library));

    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(target)).toBe(fs.realpathSync(plugin.sourcePath));
  });

  it("enables a default-disabled plugin and records only the override", async () => {
    createTempHome();
    const cwd = createTempDir("pi-kit-plugin-toggle-project-");
    const library = createTempDir("pi-kit-plugin-toggle-library-");
    createPluginDir(library, "copyx");

    const { discoverPlugins, enablePlugin } = await importPluginToggle();
    const [plugin] = discoverPlugins(library);

    const result = enablePlugin(cwd, plugin);

    expect(result.status).toBe("enabled");
    expect(readStoredByCwd(cwd)).toEqual({ enabledPlugins: ["copyx"] });
    expect(fs.existsSync(projectPluginPath(cwd, "copyx"))).toBe(true);
  });
});

describe("default project bootstrap", () => {
  it("enables every library plugin except default-disabled plugins for a new cwd", async () => {
    const cwd = createTempDir("pi-kit-plugin-toggle-project-");
    const library = createPluginLibrary("alpha", "cwd-history", "copyx");

    const { bootstrapDefaultManagedPlugins, discoverPlugins } =
      await importPluginToggle();
    const plugins = discoverPlugins(library);

    const result = bootstrapDefaultManagedPlugins(cwd, plugins);

    expect(result.enabled).toEqual(["alpha", "cwd-history"]);
    expect(result.skippedDefaultDisabled).toEqual(["copyx"]);
    expect(result.removed).toEqual([]);
    expect(fs.existsSync(projectPluginPath(cwd, "alpha"))).toBe(true);
    expect(fs.existsSync(projectPluginPath(cwd, "cwd-history"))).toBe(true);
    expect(fs.existsSync(projectPluginPath(cwd, "copyx"))).toBe(false);
    // Bootstrap never writes settings: defaults need no entry.
    expect(readStoredByCwd(cwd)).toBeUndefined();
  });

  it("skips global autoload entries during per-project bootstrap", async () => {
    const cwd = createTempDir("pi-kit-plugin-toggle-project-");
    const library = createPluginLibrary(
      "alpha",
      "cc-switch",
      "plugin-toggle",
      "shared",
    );

    const { bootstrapDefaultManagedPlugins, discoverPlugins } =
      await importPluginToggle();
    const plugins = discoverPlugins(library);

    const result = bootstrapDefaultManagedPlugins(cwd, plugins);

    expect(result.enabled).toEqual(["alpha"]);
    expect(fs.existsSync(projectPluginPath(cwd, "alpha"))).toBe(true);
    expect(fs.existsSync(projectPluginPath(cwd, "cc-switch"))).toBe(false);
    expect(fs.existsSync(projectPluginPath(cwd, "plugin-toggle"))).toBe(false);
    // Note: a "shared" symlink may still exist — enablePlugin() links it as a
    // dependency of enabled plugins. What matters is that "shared" is not
    // bootstrapped as a managed plugin (covered by result.enabled above).
  });

  it("leaves default-disabled plugins visible as disabled choices", async () => {
    const cwd = createTempDir("pi-kit-plugin-toggle-project-");
    const library = createPluginLibrary("alpha", "copyx");

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
    expect(rendered).toContain("  copyx");
    picker.dispose();
  });

  it("does not record a cwd entry when every plugin is default-disabled", async () => {
    const cwd = createTempDir("pi-kit-plugin-toggle-project-");
    const library = createPluginLibrary("copyx");

    const { bootstrapDefaultManagedPlugins, discoverPlugins } =
      await importPluginToggle();
    bootstrapDefaultManagedPlugins(cwd, discoverPlugins(library));

    expect(readStoredByCwd(cwd)).toBeUndefined();
    expect(fs.existsSync(projectPluginPath(cwd, "copyx"))).toBe(false);
  });

  it("uses configured default-disabled plugins instead of the built-in list", async () => {
    const cwd = createTempDir("pi-kit-plugin-toggle-project-");
    const library = createPluginLibrary("alpha", "copyx");
    const { globalPath } = getSettingsPaths(cwd);
    writeSettingsFile(globalPath, {
      pluginToggle: { defaultDisabledPlugins: ["alpha"] },
    });

    const { bootstrapDefaultManagedPlugins, discoverPlugins } =
      await importPluginToggle();
    const plugins = discoverPlugins(library);

    const result = bootstrapDefaultManagedPlugins(cwd, plugins);

    expect(result.enabled).toEqual(["copyx"]);
    expect(result.skippedDefaultDisabled).toEqual(["alpha"]);
  });

  it("allows an empty configured default-disabled list", async () => {
    const cwd = createTempDir("pi-kit-plugin-toggle-project-");
    const library = createPluginLibrary("copyx");
    const { globalPath } = getSettingsPaths(cwd);
    writeSettingsFile(globalPath, {
      pluginToggle: { defaultDisabledPlugins: [] },
    });

    const { bootstrapDefaultManagedPlugins, discoverPlugins } =
      await importPluginToggle();
    const plugins = discoverPlugins(library);

    const result = bootstrapDefaultManagedPlugins(cwd, plugins);

    expect(result.enabled).toEqual(["copyx"]);
    expect(result.skippedDefaultDisabled).toEqual([]);
    expect(fs.existsSync(projectPluginPath(cwd, "copyx"))).toBe(true);
  });

  it("keeps an explicitly disabled plugin disabled across bootstraps", async () => {
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
    disablePlugin(cwd, plugin); // user explicitly disabled it

    const first = bootstrapDefaultManagedPlugins(cwd, [plugin]);

    expect(first.status).toBe("already-configured");
    expect(first.enabled).toEqual([]);
    expect(fs.existsSync(projectPluginPath(cwd, "alpha"))).toBe(false);
    expect(readStoredEntry(cwd).disabledPlugins).toEqual(["alpha"]);

    // Disable is persistent: subsequent bootstraps must not resurrect it.
    const second = bootstrapDefaultManagedPlugins(cwd, [plugin]);
    expect(second.enabled).toEqual([]);
    expect(fs.existsSync(projectPluginPath(cwd, "alpha"))).toBe(false);
  });

  it("re-enables a disabled plugin via enablePlugin", async () => {
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

    expect(enablePlugin(cwd, plugin).status).toBe("enabled");
    // Back to the default state: the recorded difference is dropped.
    expect(readStoredByCwd(cwd)).toBeUndefined();
    expect(readStoredEntry(cwd).disabledPlugins).toEqual([]);

    // Default-enabled again: missing symlinks are restored.
    fs.unlinkSync(projectPluginPath(cwd, "alpha"));
    const result = bootstrapDefaultManagedPlugins(cwd, [plugin]);
    expect(result.enabled).toEqual(["alpha"]);
    expect(fs.existsSync(projectPluginPath(cwd, "alpha"))).toBe(true);
  });

  it("pre-disabling a never-enabled plugin prevents future auto-enable", async () => {
    const cwd = createTempDir("pi-kit-plugin-toggle-project-");
    const library = createPluginLibrary("alpha");

    const { bootstrapDefaultManagedPlugins, disablePlugin, discoverPlugins } =
      await importPluginToggle();
    const [plugin] = discoverPlugins(library);

    // No symlink exists yet; disable records the explicit opt-out.
    expect(disablePlugin(cwd, plugin).status).toBe("already-disabled");
    expect(readStoredEntry(cwd).disabledPlugins).toEqual(["alpha"]);

    // First bootstrap for this cwd: alpha must stay disabled.
    const result = bootstrapDefaultManagedPlugins(cwd, [plugin]);
    expect(result.enabled).toEqual([]);
    expect(fs.existsSync(projectPluginPath(cwd, "alpha"))).toBe(false);
  });

  it("removes stale symlinks for plugins that became default-disabled", async () => {
    const cwd = createTempDir("pi-kit-plugin-toggle-project-");
    const library = createPluginLibrary("alpha");

    const { bootstrapDefaultManagedPlugins, discoverPlugins, enablePlugin } =
      await importPluginToggle();
    const [plugin] = discoverPlugins(library);

    // Enabled first under the default policy (no settings entry written).
    enablePlugin(cwd, plugin);
    expect(readStoredByCwd(cwd)).toBeUndefined();
    expect(fs.existsSync(projectPluginPath(cwd, "alpha"))).toBe(true);

    // The plugin becomes default-disabled afterwards.
    const { globalPath } = getSettingsPaths(cwd);
    writeSettingsFile(globalPath, {
      pluginToggle: { defaultDisabledPlugins: ["alpha"] },
    });

    const result = bootstrapDefaultManagedPlugins(cwd, [plugin]);

    expect(result.removed).toEqual(["alpha"]);
    expect(fs.existsSync(projectPluginPath(cwd, "alpha"))).toBe(false);
    expect(readStoredByCwd(cwd)).toBeUndefined();
  });

  it("does not remove a symlink pointing outside the library during convergence", async () => {
    const cwd = createTempDir("pi-kit-plugin-toggle-project-");
    const library = createPluginLibrary("alpha");
    const { globalPath } = getSettingsPaths(cwd);
    writeSettingsFile(globalPath, {
      pluginToggle: { defaultDisabledPlugins: ["alpha"] },
    });
    const other = createTempDir("pi-kit-plugin-toggle-other-");
    const otherPlugin = createPluginDir(other, "alpha");
    const target = projectPluginPath(cwd, "alpha");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(otherPlugin, target);

    const { bootstrapDefaultManagedPlugins, discoverPlugins } =
      await importPluginToggle();

    const result = bootstrapDefaultManagedPlugins(
      cwd,
      discoverPlugins(library),
    );

    expect(result.removed).toEqual([]);
    expect(fs.realpathSync(target)).toBe(fs.realpathSync(otherPlugin));
  });

  it("does not remove a conflicting non-symlink path during convergence", async () => {
    const cwd = createTempDir("pi-kit-plugin-toggle-project-");
    const library = createPluginLibrary("alpha");
    const { globalPath } = getSettingsPaths(cwd);
    writeSettingsFile(globalPath, {
      pluginToggle: { defaultDisabledPlugins: ["alpha"] },
    });
    const projectPlugin = projectPluginPath(cwd, "alpha");
    fs.mkdirSync(projectPlugin, { recursive: true });
    fs.writeFileSync(path.join(projectPlugin, "index.ts"), "// user plugin\n");

    const { bootstrapDefaultManagedPlugins, discoverPlugins } =
      await importPluginToggle();

    const result = bootstrapDefaultManagedPlugins(
      cwd,
      discoverPlugins(library),
    );

    expect(result.removed).toEqual([]);
    expect(fs.readFileSync(path.join(projectPlugin, "index.ts"), "utf-8")).toBe(
      "// user plugin\n",
    );
  });

  it("notifies without queueing reload after bootstrapping newly enabled plugins", async () => {
    const cwd = createTempDir("pi-kit-plugin-toggle-project-");
    createPluginLibrary("alpha");
    const notify = vi.fn();
    const { runSessionStart, sendUserMessage } =
      await createFakeExtensionRuntime();

    await runSessionStart(cwd, { hasUI: true, notify });

    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      DEFAULT_BOOTSTRAP_SUCCESS_MESSAGE,
      "info",
    );
    expect(readEffectiveNames(cwd, ["alpha"])).toEqual(["alpha"]);
  });

  it("does not queue reload when plugins are already linked", async () => {
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

  it("restores symlinks for enabled plugins whose symlinks were accidentally removed", async () => {
    const cwd = createTempDir("pi-kit-plugin-toggle-project-");
    const library = createPluginLibrary("alpha", "beta");
    const { bootstrapDefaultManagedPlugins, discoverPlugins } =
      await importPluginToggle();
    const plugins = discoverPlugins(library);

    // First bootstrap → all plugins enabled
    const first = bootstrapDefaultManagedPlugins(cwd, plugins);
    expect(first.enabled).toEqual(["alpha", "beta"]);

    // Simulate accidental symlink deletion for "alpha"
    fs.unlinkSync(projectPluginPath(cwd, "alpha"));

    // Second bootstrap → only alpha (still default-enabled) gets restored
    const second = bootstrapDefaultManagedPlugins(cwd, plugins);

    expect(second.status).toBe("bootstrapped");
    expect(second.enabled).toEqual(["alpha"]);
    expect(fs.existsSync(projectPluginPath(cwd, "alpha"))).toBe(true);
    expect(fs.existsSync(projectPluginPath(cwd, "beta"))).toBe(true);
  });

  it("auto-enables newly discovered plugins even when the project is already configured", async () => {
    const cwd = createTempDir("pi-kit-plugin-toggle-project-");
    const library = createPluginLibrary("alpha");
    const { bootstrapDefaultManagedPlugins, discoverPlugins } =
      await importPluginToggle();

    // First bootstrap with only "alpha"
    bootstrapDefaultManagedPlugins(
      cwd,
      discoverPlugins(library).filter((p) => p.name === "alpha"),
    );

    // New plugin "beta" appears in library
    createPluginDir(library, "beta");

    // Second bootstrap with all plugins → beta should be auto-enabled
    const result = bootstrapDefaultManagedPlugins(
      cwd,
      discoverPlugins(library),
    );

    expect(result.status).toBe("bootstrapped");
    expect(result.enabled).toEqual(["beta"]);
    expect(fs.existsSync(projectPluginPath(cwd, "beta"))).toBe(true);
    // alpha's symlink still exists from first bootstrap
    expect(fs.existsSync(projectPluginPath(cwd, "alpha"))).toBe(true);
  });

  it("does not queue reload when every discovered plugin is default-disabled", async () => {
    const cwd = createTempDir("pi-kit-plugin-toggle-project-");
    createPluginLibrary("copyx");
    const { runSessionStart, sendUserMessage } =
      await createFakeExtensionRuntime();

    await runSessionStart(cwd);

    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(readStoredByCwd(cwd)).toBeUndefined();
  });

  it("does not default-bootstrap plugin-toggle itself", async () => {
    const cwd = createTempDir("pi-kit-plugin-toggle-project-");
    const library = createPluginLibrary("alpha", "plugin-toggle");

    const {
      bootstrapDefaultManagedPlugins,
      discoverPlugins,
      getEnabledManagedPlugins,
    } = await importPluginToggle();

    const result = bootstrapDefaultManagedPlugins(
      cwd,
      discoverPlugins(library),
    );

    expect(result.enabled).toEqual(["alpha"]);
    expect(getEnabledManagedPlugins(cwd, discoverPlugins(library))).toEqual([
      "alpha",
    ]);
    expect(fs.existsSync(projectPluginPath(cwd, "plugin-toggle"))).toBe(false);
  });

  it("does not queue reload when a plugin is enabled and another conflicts", async () => {
    const cwd = createTempDir("pi-kit-plugin-toggle-project-");
    createPluginLibrary("alpha", "beta");
    const projectPlugin = projectPluginPath(cwd, "beta");
    fs.mkdirSync(projectPlugin, { recursive: true });
    fs.writeFileSync(path.join(projectPlugin, "index.ts"), "// user plugin\n");
    const notify = vi.fn();
    const { runSessionStart, sendUserMessage } =
      await createFakeExtensionRuntime();

    await runSessionStart(cwd, { hasUI: true, notify });

    expect(sendUserMessage).not.toHaveBeenCalled();
    const { getEnabledManagedPlugins, discoverPlugins } =
      await importPluginToggle();
    expect(getEnabledManagedPlugins(cwd, discoverPlugins())).toEqual(["alpha"]);
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

describe("decideBootstrapAction", () => {
  const importBootstrap = async () => {
    vi.resetModules();
    return await import("./bootstrap.js");
  };

  it("skips global autoload entries without noting them", async () => {
    const { decideBootstrapAction } = await importBootstrap();
    expect(
      decideBootstrapAction({
        isGlobalAutoload: true,
        isDefaultDisabled: false,
        isEffective: true,
        isLinked: false,
      }),
    ).toEqual({ noteDefaultDisabled: false, action: "skip" });
  });

  it("keeps effective plugins that are already linked", async () => {
    const { decideBootstrapAction } = await importBootstrap();
    expect(
      decideBootstrapAction({
        isGlobalAutoload: false,
        isDefaultDisabled: false,
        isEffective: true,
        isLinked: true,
      }),
    ).toEqual({ noteDefaultDisabled: false, action: "keep" });
  });

  it("enables effective plugins that are not linked", async () => {
    const { decideBootstrapAction } = await importBootstrap();
    expect(
      decideBootstrapAction({
        isGlobalAutoload: false,
        isDefaultDisabled: true,
        isEffective: true,
        isLinked: false,
      }),
    ).toEqual({ noteDefaultDisabled: false, action: "enable" });
  });

  it("removes not-effective plugins and notes default-disabled ones", async () => {
    const { decideBootstrapAction } = await importBootstrap();
    expect(
      decideBootstrapAction({
        isGlobalAutoload: false,
        isDefaultDisabled: true,
        isEffective: false,
        isLinked: false,
      }),
    ).toEqual({ noteDefaultDisabled: true, action: "remove" });
    expect(
      decideBootstrapAction({
        isGlobalAutoload: false,
        isDefaultDisabled: false,
        isEffective: false,
        isLinked: true,
      }),
    ).toEqual({ noteDefaultDisabled: false, action: "remove" });
  });
});

describe("plugin toggle settings store", () => {
  const importSettingsStore = async () => {
    vi.resetModules();
    return await import("./settings-store.js");
  };

  it("reads legacy managedPlugins as enabled overrides", async () => {
    createTempHome();
    const cwd = createTempDir("pi-kit-plugin-toggle-project-");
    const { globalPath } = getSettingsPaths(cwd);
    writeSettingsFile(globalPath, {
      pluginToggle: { byCwd: { [cwd]: { managedPlugins: ["alpha"] } } },
    });

    const { PluginToggleSettingsStore } = await importSettingsStore();
    const store = new PluginToggleSettingsStore(cwd);

    expect(store.readEntry()).toEqual({
      enabledPlugins: ["alpha"],
      disabledPlugins: [],
    });
  });

  it("computes the effective enabled set from library and differences", async () => {
    createTempHome();
    const cwd = createTempDir("pi-kit-plugin-toggle-project-");
    const { globalPath } = getSettingsPaths(cwd);
    writeSettingsFile(globalPath, {
      pluginToggle: {
        byCwd: {
          [cwd]: {
            enabledPlugins: ["copyx"],
            disabledPlugins: ["alpha"],
          },
        },
      },
    });

    const { PluginToggleSettingsStore } = await importSettingsStore();
    const store = new PluginToggleSettingsStore(cwd);

    // library = all, defaultDisabled = copyx, entry disables alpha, enables copyx
    const effective = store.readEffectivePlugins(["alpha", "beta", "copyx"]);
    expect(Array.from(effective).sort()).toEqual(["beta", "copyx"]);
  });

  it("ignores entry names that are not in the library", async () => {
    const { computeEffectivePlugins } = await importSettingsStore();
    const effective = computeEffectivePlugins(
      ["alpha", "beta"],
      new Set(["copyx"]),
      { enabledPlugins: ["ghost"], disabledPlugins: ["phantom"] },
    );

    expect(Array.from(effective).sort()).toEqual(["alpha", "beta"]);
  });

  it("normalizes case in the effective set computation", async () => {
    const { computeEffectivePlugins } = await importSettingsStore();
    const effective = computeEffectivePlugins(
      ["Alpha", "beta"],
      new Set(["ALPHA"]),
      { enabledPlugins: ["ALPHA"], disabledPlugins: ["BETA"] },
    );

    expect(Array.from(effective).sort()).toEqual(["alpha"]);
  });

  it("decideNextEntry records no difference when the state matches the default", async () => {
    const { decideNextEntry } = await importSettingsStore();
    expect(decideNextEntry(undefined, "alpha", true, true)).toEqual({
      kind: "remove",
    });
    expect(decideNextEntry(undefined, "copyx", false, false)).toEqual({
      kind: "remove",
    });
  });

  it("decideNextEntry records a disabled override for a default-enabled plugin", async () => {
    const { decideNextEntry } = await importSettingsStore();
    expect(decideNextEntry(undefined, "alpha", false, true)).toEqual({
      kind: "write",
      entry: { disabledPlugins: ["alpha"] },
    });
  });

  it("decideNextEntry records an enabled override for a default-disabled plugin", async () => {
    const { decideNextEntry } = await importSettingsStore();
    expect(decideNextEntry(undefined, "copyx", true, false)).toEqual({
      kind: "write",
      entry: { enabledPlugins: ["copyx"] },
    });
  });

  it("decideNextEntry moves a name between the two lists", async () => {
    const { decideNextEntry } = await importSettingsStore();
    expect(
      decideNextEntry(
        { enabledPlugins: ["copyx"], disabledPlugins: ["alpha"] },
        "alpha",
        true,
        true,
      ),
    ).toEqual({ kind: "write", entry: { enabledPlugins: ["copyx"] } });
    expect(
      decideNextEntry(
        { enabledPlugins: ["copyx"], disabledPlugins: ["alpha"] },
        "copyx",
        false,
        false,
      ),
    ).toEqual({ kind: "write", entry: { disabledPlugins: ["alpha"] } });
  });

  it("decideNextEntry drops the entry when the last override is undone", async () => {
    const { decideNextEntry } = await importSettingsStore();
    expect(
      decideNextEntry({ disabledPlugins: ["alpha"] }, "alpha", true, true),
    ).toEqual({ kind: "remove" });
    expect(
      decideNextEntry({ enabledPlugins: ["copyx"] }, "copyx", false, false),
    ).toEqual({ kind: "remove" });
  });

  it("decideNextEntry keeps other names and normalizes the plugin name", async () => {
    const { decideNextEntry } = await importSettingsStore();
    expect(
      decideNextEntry(
        { disabledPlugins: ["Alpha", "beta"] },
        "ALPHA",
        true,
        true,
      ),
    ).toEqual({ kind: "write", entry: { disabledPlugins: ["beta"] } });
  });

  it("setPluginState writes no entry when the state matches the default", async () => {
    createTempHome();
    const cwd = createTempDir("pi-kit-plugin-toggle-project-");

    const { PluginToggleSettingsStore } = await importSettingsStore();
    const store = new PluginToggleSettingsStore(cwd);

    // alpha is default-enabled and we want it enabled: no write at all.
    store.setPluginState("alpha", true, new Set(["copyx"]));
    expect(readStoredByCwd(cwd)).toBeUndefined();

    // copyx is default-disabled and we want it disabled: no write at all.
    store.setPluginState("copyx", false, new Set(["copyx"]));
    expect(readStoredByCwd(cwd)).toBeUndefined();
  });

  it("setPluginState records a disabled override for a default-enabled plugin", async () => {
    createTempHome();
    const cwd = createTempDir("pi-kit-plugin-toggle-project-");

    const { PluginToggleSettingsStore } = await importSettingsStore();
    const store = new PluginToggleSettingsStore(cwd);

    store.setPluginState("alpha", false, new Set());
    expect(readStoredByCwd(cwd)).toEqual({ disabledPlugins: ["alpha"] });

    // Back to the default: the entry is removed again.
    store.setPluginState("alpha", true, new Set());
    expect(readStoredByCwd(cwd)).toBeUndefined();
  });

  it("setPluginState records an enabled override for a default-disabled plugin", async () => {
    createTempHome();
    const cwd = createTempDir("pi-kit-plugin-toggle-project-");

    const { PluginToggleSettingsStore } = await importSettingsStore();
    const store = new PluginToggleSettingsStore(cwd);

    store.setPluginState("copyx", true, new Set(["copyx"]));
    expect(readStoredByCwd(cwd)).toEqual({ enabledPlugins: ["copyx"] });

    // Back to the default (disabled): the entry is removed again.
    store.setPluginState("copyx", false, new Set(["copyx"]));
    expect(readStoredByCwd(cwd)).toBeUndefined();
  });

  it("setPluginState moves a name between the two lists", async () => {
    createTempHome();
    const cwd = createTempDir("pi-kit-plugin-toggle-project-");

    const { PluginToggleSettingsStore } = await importSettingsStore();
    const store = new PluginToggleSettingsStore(cwd);

    store.setPluginState("copyx", true, new Set(["copyx"]));
    expect(readStoredByCwd(cwd)).toEqual({ enabledPlugins: ["copyx"] });

    // Disabling a default-disabled plugin matches the default: entry removed.
    store.setPluginState("copyx", false, new Set(["copyx"]));
    expect(readStoredByCwd(cwd)).toBeUndefined();

    // Now disable a default-enabled plugin, then enable it while copyx is
    // still default-disabled: the name moves between lists.
    store.setPluginState("alpha", false, new Set(["copyx"]));
    store.setPluginState("alpha", true, new Set(["copyx"]));
    expect(readStoredByCwd(cwd)).toBeUndefined();

    store.setPluginState("copyx", true, new Set(["copyx"]));
    expect(readStoredByCwd(cwd)).toEqual({ enabledPlugins: ["copyx"] });
  });

  it("setPluginState keeps other names and other cwd entries intact", async () => {
    createTempHome();
    const cwd = createTempDir("pi-kit-plugin-toggle-project-");
    const otherCwd = createTempDir("pi-kit-plugin-toggle-other-project-");
    const { globalPath } = getSettingsPaths(cwd);
    writeSettingsFile(globalPath, {
      pluginToggle: {
        byCwd: {
          [otherCwd]: { disabledPlugins: ["beta"] },
        },
      },
    });

    const { PluginToggleSettingsStore } = await importSettingsStore();
    const store = new PluginToggleSettingsStore(cwd);

    store.setPluginState("alpha", false, new Set());
    expect(readStoredByCwd(cwd)).toEqual({ disabledPlugins: ["alpha"] });
    expect(readStoredByCwd(otherCwd)).toEqual({ disabledPlugins: ["beta"] });

    // Toggling alpha back to default keeps the other cwd entry.
    store.setPluginState("alpha", true, new Set());
    expect(readStoredByCwd(cwd)).toBeUndefined();
    expect(readStoredByCwd(otherCwd)).toEqual({ disabledPlugins: ["beta"] });
  });

  it("drops legacy managedPlugins when writing an entry", async () => {
    createTempHome();
    const cwd = createTempDir("pi-kit-plugin-toggle-project-");
    const { globalPath } = getSettingsPaths(cwd);
    writeSettingsFile(globalPath, {
      pluginToggle: { byCwd: { [cwd]: { managedPlugins: ["alpha"] } } },
    });

    const { PluginToggleSettingsStore } = await importSettingsStore();
    const store = new PluginToggleSettingsStore(cwd);

    // alpha is default-enabled; recording the default state drops the legacy
    // entry entirely.
    store.setPluginState("alpha", true, new Set());
    expect(readStoredByCwd(cwd)).toBeUndefined();

    // With a real difference, the legacy field is replaced by the new one.
    store.setPluginState("alpha", false, new Set());
    expect(readStoredByCwd(cwd)).toEqual({ disabledPlugins: ["alpha"] });
  });

  it("reads configured default-disabled plugins with the built-in fallback", async () => {
    createTempHome();
    const cwd = createTempDir("pi-kit-plugin-toggle-project-");

    const { PluginToggleSettingsStore } = await importSettingsStore();
    const store = new PluginToggleSettingsStore(cwd);

    expect(Array.from(store.readDefaultDisabledPlugins()).sort()).toEqual([
      "copyx",
      "pi-autoresearch",
    ]);

    const { globalPath } = getSettingsPaths(cwd);
    writeSettingsFile(globalPath, {
      pluginToggle: { defaultDisabledPlugins: ["alpha"] },
    });
    const freshStore = new PluginToggleSettingsStore(cwd);
    expect(Array.from(freshStore.readDefaultDisabledPlugins())).toEqual([
      "alpha",
    ]);
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

describe("messages", () => {
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
});

describe("settings difference migration (computeDiffs)", () => {
  const importSettingsStore = async () => {
    vi.resetModules();
    return await import("./settings-store.js");
  };

  it("derives minimal differences that reproduce the linked set", async () => {
    const { computeDiffs, computeEffectivePlugins } =
      await importSettingsStore();

    const library = ["alpha", "beta", "gamma", "copyx"];
    const defaultDisabled = new Set(["copyx"]);
    const linked = new Set(["alpha", "beta", "copyx"]);

    const diffs = computeDiffs(linked, library, defaultDisabled);

    expect(diffs).toEqual({
      enabledPlugins: ["copyx"],
      disabledPlugins: ["gamma"],
    });

    // Round-trip: the entry reproduces exactly the linked set.
    const effective = computeEffectivePlugins(library, defaultDisabled, diffs);
    expect(Array.from(effective).sort()).toEqual(["alpha", "beta", "copyx"]);
  });

  it("returns empty differences when the linked set equals the default", async () => {
    const { computeDiffs } = await importSettingsStore();

    const library = ["alpha", "beta"];
    const defaultDisabled = new Set<string>();
    const linked = new Set(["alpha", "beta"]);

    expect(computeDiffs(linked, library, defaultDisabled)).toEqual({
      enabledPlugins: [],
      disabledPlugins: [],
    });
  });

  it("ignores linked names that are not in the library", async () => {
    const { computeDiffs } = await importSettingsStore();

    const library = ["alpha", "beta"];
    const defaultDisabled = new Set<string>();
    const linked = new Set(["alpha", "ghost"]);

    const diffs = computeDiffs(linked, library, defaultDisabled);

    expect(diffs).toEqual({
      enabledPlugins: [],
      disabledPlugins: ["beta"],
    });
  });

  it("normalizes case in linked names", async () => {
    const { computeDiffs } = await importSettingsStore();

    const library = ["alpha", "copyx"];
    const defaultDisabled = new Set(["copyx"]);
    const linked = new Set(["ALPHA", "COPYX"]);

    expect(computeDiffs(linked, library, defaultDisabled)).toEqual({
      enabledPlugins: ["copyx"],
      disabledPlugins: [],
    });
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
