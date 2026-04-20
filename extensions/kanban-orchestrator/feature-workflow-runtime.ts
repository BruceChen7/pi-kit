import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const FEATURE_WORKFLOW_ROOT_ENV = "PI_FEATURE_WORKFLOW_EXTENSION_DIR";
const here = path.dirname(fileURLToPath(import.meta.url));
const moduleCache = new Map<string, Promise<unknown>>();

function normalizeModulePath(modulePath: string): string {
  return modulePath.replace(/\\/g, "/");
}

function resolveFeatureWorkflowRoot(): string {
  const envRoot = process.env[FEATURE_WORKFLOW_ROOT_ENV]?.trim();
  const candidateRoots = [
    envRoot,
    path.resolve(here, "../feature-workflow"),
    path.join(os.homedir(), ".pi", "agent", "extensions", "feature-workflow"),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidateRoots) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `feature-workflow extension not found. Checked ${candidateRoots.join(", ")}`,
  );
}

export function resolveFeatureWorkflowModulePath(modulePath: string): string {
  const normalizedModulePath = normalizeModulePath(modulePath);
  const root = resolveFeatureWorkflowRoot();
  const jsPath = path.join(root, normalizedModulePath);
  if (fs.existsSync(jsPath)) {
    return jsPath;
  }

  if (normalizedModulePath.endsWith(".js")) {
    const tsPath = path.join(
      root,
      normalizedModulePath.replace(/\.js$/, ".ts"),
    );
    if (fs.existsSync(tsPath)) {
      return tsPath;
    }
  }

  throw new Error(
    `feature-workflow module not found: ${normalizedModulePath} under ${root}`,
  );
}

export async function importFeatureWorkflowModule<T>(
  modulePath: string,
): Promise<T> {
  const resolvedPath = resolveFeatureWorkflowModulePath(modulePath);
  const href = pathToFileURL(resolvedPath).href;
  const cached = moduleCache.get(href);
  if (cached) {
    return (await cached) as T;
  }

  const loaded = import(href);
  moduleCache.set(href, loaded);
  return (await loaded) as T;
}
