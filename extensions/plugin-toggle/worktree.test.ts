import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearSettingsCache,
  getSettingsPaths,
  readSettingsFile,
  writeSettingsFile,
} from "../shared/settings.js";
import { PluginToggleSettingsStore } from "./settings-store.js";
import { parseMainWorktreePath } from "./worktree.js";

const tempDirs: string[] = [];
const originalHome = process.env.HOME;
const originalCwd = process.cwd();

const createTempDir = (prefix: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

const createTempHome = (): string => {
  const dir = createTempDir("pi-kit-plugin-toggle-wt-home-");
  process.env.HOME = dir;
  return dir;
};

const createPluginDir = (baseDir: string, name: string): string => {
  const pluginDir = path.join(baseDir, name);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "index.ts"), "");
  return pluginDir;
};

const run = (cwd: string, args: string[]): void => {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
};

/** Create a repo with one commit plus a linked worktree on a new branch. */
const createRepoWithWorktree = (): {
  root: string;
  worktree: string;
} => {
  const root = createTempDir("pi-kit-plugin-toggle-wt-root-");
  run(root, ["init", "-b", "main"]);
  run(root, ["config", "user.email", "test@example.com"]);
  run(root, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(root, "README.md"), "repo\n");
  run(root, ["add", "README.md"]);
  run(root, ["commit", "-m", "init"]);

  const worktree = createTempDir("pi-kit-plugin-toggle-wt-linked-");
  run(root, ["worktree", "add", "-b", "feat", worktree]);
  return { root, worktree };
};

const pluginByName = <T extends { name: string }>(
  plugins: T[],
  name: string,
): T => {
  const plugin = plugins.find((p) => p.name === name);
  if (!plugin) throw new Error(`plugin not found in test library: ${name}`);
  return plugin;
};

const importPluginToggle = async () => {
  vi.resetModules();
  return await import("./index.js");
};

afterEach(() => {
  clearSettingsCache();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  process.chdir(originalCwd);
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.resetModules();
});

describe("parseMainWorktreePath", () => {
  it("returns the first worktree entry (the main repo root)", () => {
    const porcelain = [
      "worktree /Users/me/repo",
      "HEAD 0123456789abcdef0123456789abcdef01234567",
      "branch refs/heads/master",
      "",
      "worktree /Users/me/repo-feat",
      "HEAD 89abcdef0123456789abcdef0123456789abcdef",
      "branch refs/heads/feat",
      "",
    ].join("\n");
    expect(parseMainWorktreePath(porcelain)).toBe("/Users/me/repo");
  });

  it("ignores a prunable linked worktree marker and still returns the main root", () => {
    const porcelain = [
      "worktree /Users/me/repo",
      "HEAD 0123456789abcdef0123456789abcdef01234567",
      "branch refs/heads/master",
      "",
      "worktree /Users/me/repo-gone",
      "HEAD 89abcdef0123456789abcdef0123456789abcdef",
      "branch refs/heads/old",
      "prunable gitdir file points to non-existent location",
      "",
    ].join("\n");
    expect(parseMainWorktreePath(porcelain)).toBe("/Users/me/repo");
  });

  it("handles a bare main worktree (bare key on the first entry)", () => {
    const porcelain = [
      "worktree /Users/me/proj/bare",
      "HEAD 0123456789abcdef0123456789abcdef01234567",
      "bare",
      "",
      "worktree /Users/me/proj/main",
      "HEAD 89abcdef0123456789abcdef0123456789abcdef",
      "branch refs/heads/main",
      "",
    ].join("\n");
    expect(parseMainWorktreePath(porcelain)).toBe("/Users/me/proj/bare");
  });

  it("returns null for empty or garbage output", () => {
    expect(parseMainWorktreePath("")).toBeNull();
    expect(
      parseMainWorktreePath("HEAD deadbeef\nbranch refs/heads/x\n"),
    ).toBeNull();
  });
});

describe("worktree shared configuration", () => {
  it("links the worktree .pi to the main repo and bootstraps the shared extensions", async () => {
    const home = createTempHome();
    const { root, worktree } = createRepoWithWorktree();
    const library = path.join(home, ".agents", "pi-plugins");
    createPluginDir(library, "alpha");
    createPluginDir(library, "cwd-history");
    createPluginDir(library, "copyx"); // default-disabled

    const {
      bootstrapDefaultManagedPlugins,
      discoverPlugins,
      ensureSharedWorktreeConfig,
    } = await importPluginToggle();
    const plugins = discoverPlugins(library);

    // Session-start order: ensure the shared link, then converge symlinks.
    expect(ensureSharedWorktreeConfig(worktree)).toBe("created");

    const linkPath = path.join(worktree, ".pi");
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(linkPath)).toBe(
      fs.realpathSync(path.join(root, ".pi")),
    );

    const result = bootstrapDefaultManagedPlugins(worktree, plugins);
    expect(result.enabled).toEqual(["alpha", "cwd-history"]);
    // Symlinks physically live in the main repo's .pi/extensions...
    expect(fs.existsSync(path.join(root, ".pi", "extensions", "alpha"))).toBe(
      true,
    );
    // ...and are visible through the worktree link.
    expect(
      fs.existsSync(path.join(worktree, ".pi", "extensions", "alpha")),
    ).toBe(true);
    expect(fs.existsSync(path.join(root, ".pi", "extensions", "copyx"))).toBe(
      false,
    );
  });

  it("shares settings between worktree and root: toggling in either place affects both", async () => {
    const home = createTempHome();
    const { root, worktree } = createRepoWithWorktree();
    const library = path.join(home, ".agents", "pi-plugins");
    createPluginDir(library, "alpha");
    createPluginDir(library, "cwd-history");

    const {
      bootstrapDefaultManagedPlugins,
      disablePlugin,
      discoverPlugins,
      enablePlugin,
      ensureSharedWorktreeConfig,
    } = await importPluginToggle();
    const plugins = discoverPlugins(library);

    ensureSharedWorktreeConfig(worktree);
    bootstrapDefaultManagedPlugins(worktree, plugins);

    // Disable from the worktree session...
    const result = disablePlugin(worktree, pluginByName(plugins, "alpha"));
    expect(result.status).toBe("disabled");
    // ...the symlink is removed from the shared (root) extensions dir.
    expect(fs.existsSync(path.join(root, ".pi", "extensions", "alpha"))).toBe(
      false,
    );

    // Settings are keyed by the main repo root, not the worktree path.
    const { globalPath } = getSettingsPaths(worktree);
    const byCwd = (
      readSettingsFile(globalPath).pluginToggle as { byCwd?: unknown }
    ).byCwd as Record<string, unknown>;
    expect(Object.keys(byCwd)).toEqual([fs.realpathSync(root)]);
    expect(
      (byCwd[fs.realpathSync(root)] as { disabledPlugins?: string[] })
        .disabledPlugins,
    ).toEqual(["alpha"]);

    // A root-session bootstrap honors the shared entry: alpha stays disabled.
    const rootBootstrap = bootstrapDefaultManagedPlugins(root, plugins);
    expect(rootBootstrap.removed).toEqual([]);
    expect(fs.existsSync(path.join(root, ".pi", "extensions", "alpha"))).toBe(
      false,
    );

    // Re-enable from the root session; the worktree sees it too.
    const reEnable = enablePlugin(root, pluginByName(plugins, "alpha"));
    expect(reEnable.status).toBe("enabled");
    expect(
      fs.existsSync(path.join(worktree, ".pi", "extensions", "alpha")),
    ).toBe(true);
    expect(new PluginToggleSettingsStore(worktree).readEntry()).toEqual({
      enabledPlugins: [],
      disabledPlugins: [],
    });
  });

  it("never overwrites a real .pi directory in the worktree", async () => {
    createTempHome();
    const { root, worktree } = createRepoWithWorktree();
    fs.mkdirSync(path.join(worktree, ".pi", "extensions"), { recursive: true });
    fs.writeFileSync(
      path.join(worktree, ".pi", "extensions", "user-plugin.ts"),
      "",
    );

    const { ensureSharedWorktreeConfig, resolveSharedProjectRoot } =
      await importPluginToggle();

    expect(ensureSharedWorktreeConfig(worktree)).toBe("existing");
    expect(fs.lstatSync(path.join(worktree, ".pi")).isSymbolicLink()).toBe(
      false,
    );
    // Per-worktree settings key: no sharing with the root.
    expect(resolveSharedProjectRoot(worktree)).toBe(fs.realpathSync(worktree));
    expect(resolveSharedProjectRoot(root)).toBe(fs.realpathSync(root));
    expect(
      fs.existsSync(path.join(worktree, ".pi", "extensions", "user-plugin.ts")),
    ).toBe(true);
  });

  it("is a no-op for non-git directories and regular repositories", async () => {
    createTempHome();
    const plainDir = createTempDir("pi-kit-plugin-toggle-wt-plain-");
    const { root } = createRepoWithWorktree();

    const { ensureSharedWorktreeConfig, resolveSharedProjectRoot } =
      await importPluginToggle();

    expect(ensureSharedWorktreeConfig(plainDir)).toBe("not-worktree");
    expect(resolveSharedProjectRoot(plainDir)).toBe(fs.realpathSync(plainDir));
    // Regular repo: not a worktree, plain cwd key.
    expect(ensureSharedWorktreeConfig(root)).toBe("not-worktree");
    expect(resolveSharedProjectRoot(root)).toBe(fs.realpathSync(root));
  });

  it("session_start handler links a worktree and notifies once", async () => {
    const home = createTempHome();
    const { root, worktree } = createRepoWithWorktree();
    const library = path.join(home, ".agents", "pi-plugins");
    createPluginDir(library, "alpha");

    const { default: pluginToggleExtension } = await importPluginToggle();
    const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> =
      {};
    const notify = vi.fn();
    const pi = {
      on: vi.fn(
        (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
          handlers[event] = handler;
        },
      ),
      registerCommand: vi.fn(),
    };
    pluginToggleExtension(pi as never);
    await handlers.session_start?.(
      { type: "session_start", reason: "startup" },
      { cwd: worktree, hasUI: true, ui: { notify } },
    );

    expect(fs.lstatSync(path.join(worktree, ".pi")).isSymbolicLink()).toBe(
      true,
    );
    expect(fs.realpathSync(path.join(worktree, ".pi"))).toBe(
      fs.realpathSync(path.join(root, ".pi")),
    );
    // Shared extensions bootstrapped through the link, plus the link notice.
    expect(
      fs.existsSync(path.join(worktree, ".pi", "extensions", "alpha")),
    ).toBe(true);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("工作树配置链接到主仓库"),
      "info",
    );
  });

  it("reads legacy worktree-path settings entries and migrates them on write", async () => {
    const home = createTempHome();
    const { root, worktree } = createRepoWithWorktree();
    const library = path.join(home, ".agents", "pi-plugins");
    createPluginDir(library, "alpha");

    const { ensureSharedWorktreeConfig } = await importPluginToggle();
    ensureSharedWorktreeConfig(worktree);

    // Simulate an entry written by the pre-sharing version (worktree-path key).
    const { globalPath } = getSettingsPaths(worktree);
    const legacyKey = path.resolve(worktree);
    writeSettingsFile(globalPath, {
      pluginToggle: {
        byCwd: { [legacyKey]: { disabledPlugins: ["alpha"] } },
      },
    });

    // The shared key resolves to the main repo root; the legacy entry is readable.
    const store = new PluginToggleSettingsStore(worktree);
    const storeKey = (store as unknown as { cwdKey: string }).cwdKey;
    expect(storeKey).toBe(fs.realpathSync(root));
    expect(store.readEntry()).toEqual({
      enabledPlugins: [],
      disabledPlugins: ["alpha"],
    });

    // A write migrates the entry to the shared key and drops the legacy one.
    store.setPluginState("cwd-history", true, new Set());
    const byCwd = (
      readSettingsFile(globalPath).pluginToggle as { byCwd?: unknown }
    ).byCwd as Record<string, unknown>;
    expect(Object.keys(byCwd)).toEqual([fs.realpathSync(root)]);
    expect(
      (byCwd[fs.realpathSync(root)] as { disabledPlugins?: string[] })
        .disabledPlugins,
    ).toEqual(["alpha"]);
  });
});
