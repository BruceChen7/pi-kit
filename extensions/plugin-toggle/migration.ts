import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isPluginFile } from "./library.ts";
import type { MigrationItem, MigrationOptions, PluginEntry } from "./types.ts";

function globalPluginEntries(globalDir: string): PluginEntry[] {
  if (!fs.existsSync(globalDir)) return [];
  const plugins: PluginEntry[] = [];
  for (const entryName of fs.readdirSync(globalDir).sort()) {
    if (entryName === "shared" || entryName.startsWith(".")) continue;
    const sourcePath = path.join(globalDir, entryName);
    const stat = fs.lstatSync(sourcePath);
    if (
      (stat.isDirectory() || stat.isSymbolicLink()) &&
      fs.existsSync(path.join(sourcePath, "index.ts"))
    ) {
      plugins.push({
        name: entryName,
        enabledName: entryName,
        sourcePath,
        kind: "directory",
      });
    } else if (
      (stat.isFile() || stat.isSymbolicLink()) &&
      isPluginFile(sourcePath)
    ) {
      plugins.push({
        name: path.basename(entryName, ".ts"),
        enabledName: entryName,
        sourcePath,
        kind: "file",
      });
    }
  }
  return plugins;
}

export function migrateGlobalPlugins(options: MigrationOptions = {}): {
  migrated: MigrationItem[];
  needsConfirmation: MigrationItem[];
  skipped: MigrationItem[];
} {
  const home = options.home ?? os.homedir();
  const globalDir =
    options.globalDir ?? path.join(home, ".pi", "agent", "extensions");
  const libraryDir =
    options.libraryDir ?? path.join(home, ".agents", "pi-plugins");
  const migrated: MigrationItem[] = [];
  const needsConfirmation: MigrationItem[] = [];
  const skipped: MigrationItem[] = [];

  for (const plugin of globalPluginEntries(globalDir)) {
    const targetPath = path.join(libraryDir, plugin.enabledName);
    const item = {
      name: plugin.name,
      sourcePath: plugin.sourcePath,
      targetPath,
    };
    const stat = fs.lstatSync(plugin.sourcePath);

    if (!stat.isSymbolicLink()) {
      needsConfirmation.push(item);
      continue;
    }

    if (fs.existsSync(targetPath)) {
      skipped.push(item);
      continue;
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const linkTarget = fs.readlinkSync(plugin.sourcePath);
    fs.symlinkSync(linkTarget, targetPath);
    fs.unlinkSync(plugin.sourcePath);
    migrated.push(item);
  }

  return { migrated, needsConfirmation, skipped };
}
