import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..");
const scriptPath = path.join(repoRoot, "install-plugins.sh");
const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-install-plugins-"));
  tempDirs.push(dir);
  return dir;
}

function createPluginDir(baseDir: string, name: string): string {
  const pluginDir = path.join(baseDir, name);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "index.ts"), "");
  return pluginDir;
}

function runInstall(home: string, args: string[] = []): string {
  return execFileSync("bash", [scriptPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, HOME: home, PI_KIT_SKIP_PLUGIN_DEP_INSTALL: "1" },
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

describe("install-plugins.sh", () => {
  it("installs local plugins into a shared library and only bootstraps plugin-toggle globally", () => {
    const home = createTempDir();

    runInstall(home);

    const libraryDir = path.join(home, ".agents", "pi-plugins");
    const globalExtensionsDir = path.join(home, ".pi", "agent", "extensions");

    expect(fs.lstatSync(path.join(libraryDir, "copyx")).isSymbolicLink()).toBe(
      true,
    );
    expect(
      fs.lstatSync(path.join(libraryDir, "safe-delete.ts")).isSymbolicLink(),
    ).toBe(true);
    expect(
      fs
        .lstatSync(path.join(globalExtensionsDir, "plugin-toggle"))
        .isSymbolicLink(),
    ).toBe(true);
    expect(
      fs.lstatSync(path.join(globalExtensionsDir, "shared")).isSymbolicLink(),
    ).toBe(true);
    expect(fs.existsSync(path.join(globalExtensionsDir, "copyx"))).toBe(false);
  });

  it("migrates old global symlink plugins into the shared library by default", () => {
    const home = createTempDir();
    const oldSource = createTempDir();
    const oldPlugin = createPluginDir(oldSource, "old-plugin");

    const globalExtensionsDir = path.join(home, ".pi", "agent", "extensions");
    fs.mkdirSync(globalExtensionsDir, { recursive: true });
    fs.symlinkSync(oldPlugin, path.join(globalExtensionsDir, "old-plugin"));

    const output = runInstall(home);

    const migratedPath = path.join(home, ".agents", "pi-plugins", "old-plugin");
    expect(fs.lstatSync(migratedPath).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(migratedPath)).toBe(fs.realpathSync(oldPlugin));
    expect(fs.existsSync(path.join(globalExtensionsDir, "old-plugin"))).toBe(
      false,
    );
    expect(output).toContain(
      "Migrated old global autoload symlink: old-plugin",
    );
  });

  it("leaves conflicting global symlink plugins untouched for manual review", () => {
    const home = createTempDir();
    const oldSource = createTempDir();
    const oldPlugin = createPluginDir(oldSource, "copyx");

    const globalExtensionsDir = path.join(home, ".pi", "agent", "extensions");
    fs.mkdirSync(globalExtensionsDir, { recursive: true });
    fs.symlinkSync(oldPlugin, path.join(globalExtensionsDir, "copyx"));

    const output = runInstall(home);

    expect(fs.realpathSync(path.join(globalExtensionsDir, "copyx"))).toBe(
      fs.realpathSync(oldPlugin),
    );
    expect(output).toContain(
      "Global plugin name conflict needs manual review: copyx",
    );
  });

  it("leaves real global plugins untouched when installing the default library", () => {
    const home = createTempDir();
    const globalExtensionsDir = path.join(home, ".pi", "agent", "extensions");
    const realPlugin = createPluginDir(globalExtensionsDir, "real-plugin");

    const output = runInstall(home);

    expect(fs.existsSync(realPlugin)).toBe(true);
    expect(output).toContain(
      "Real global plugin needs manual review: real-plugin",
    );
  });

  it("still supports explicitly installing all plugins as global autoload extensions", () => {
    const home = createTempDir();

    runInstall(home, ["--autoload"]);

    const globalExtensionsDir = path.join(home, ".pi", "agent", "extensions");
    expect(
      fs.lstatSync(path.join(globalExtensionsDir, "copyx")).isSymbolicLink(),
    ).toBe(true);
    expect(
      fs.lstatSync(path.join(globalExtensionsDir, "shared")).isSymbolicLink(),
    ).toBe(true);
  });
});
