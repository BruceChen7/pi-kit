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

function runInstall(
  home: string,
  args: string[] = [],
  extraEnv: Record<string, string> = {},
): string {
  return execFileSync("bash", [scriptPath, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      PI_KIT_SKIP_PLUGIN_DEP_INSTALL: "1",
      ...extraEnv,
    },
    encoding: "utf8",
  });
}

function createExtensionsFixture(baseDir: string): string {
  // A `foo/foo.ts` entry with a sibling module: exactly the layout that a
  // single-file symlink cannot expose (siblings are unreachable at runtime).
  const extensionsDir = path.join(baseDir, "extensions");
  const pluginDir = path.join(extensionsDir, "sample-plugin");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "sample-plugin.ts"),
    "export default function () {}\n",
  );
  fs.writeFileSync(
    path.join(pluginDir, "sample-config.ts"),
    "export const x = 1;\n",
  );
  return extensionsDir;
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

  it("installs review as a directory symlink so sibling modules stay reachable", () => {
    const home = createTempDir();

    runInstall(home);

    const libraryDir = path.join(home, ".agents", "pi-plugins");
    const reviewLink = path.join(libraryDir, "review");

    // With an index.ts entry, review installs as a directory symlink.
    expect(fs.lstatSync(reviewLink).isSymbolicLink()).toBe(true);
    expect(fs.statSync(reviewLink).isDirectory()).toBe(true);

    // Sibling modules must stay reachable through the symlinked directory,
    // otherwise pi cannot resolve `./review-config.ts` from review.ts.
    expect(fs.existsSync(path.join(reviewLink, "review-config.ts"))).toBe(true);

    // The old single-file symlink must not be created anymore.
    expect(fs.existsSync(path.join(libraryDir, "review.ts"))).toBe(false);
  });

  it("warns when a foo/foo.ts extension has sibling modules a file symlink cannot expose", () => {
    const home = createTempDir();
    const fixture = createTempDir();
    const extensionsDir = createExtensionsFixture(fixture);

    const output = runInstall(home, [], {
      PI_KIT_EXTENSIONS_DIR: extensionsDir,
    });

    const libraryDir = path.join(home, ".agents", "pi-plugins");
    expect(
      fs.lstatSync(path.join(libraryDir, "sample-plugin.ts")).isSymbolicLink(),
    ).toBe(true);
    // The sibling is NOT installed (a single-file symlink cannot expose it).
    expect(fs.existsSync(path.join(libraryDir, "sample-config.ts"))).toBe(
      false,
    );
    expect(output).toContain("has sibling .ts files not reachable");
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
