import fs from "node:fs";
import path from "node:path";
import { PROJECT_EXTENSION_DIR } from "./constants.ts";
import type { PluginEntry } from "./types.ts";

export const normalizeName = (name: string): string =>
  name.trim().toLowerCase();

export const projectExtensionsDir = (cwd: string): string =>
  path.join(cwd, PROJECT_EXTENSION_DIR);

export const pluginTargetPath = (cwd: string, plugin: PluginEntry): string =>
  path.join(projectExtensionsDir(cwd), plugin.enabledName);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

export function statTargetOrNull(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

export function realPathOrNull(filePath: string): string | null {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return null;
  }
}
