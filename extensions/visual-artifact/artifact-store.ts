/**
 * Artifact store — atomic read/write for VisualArtifactSpec bundles.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { type VisualArtifactSpec, validate } from "./artifact-schema.ts";
import { normalizeMermaidNodesInSpec } from "./mermaid-boundary.ts";
import {
  getArtifactBundleDir,
  getArtifactJsonPath,
  getArtifactsRoot,
  getTempDir,
} from "./paths.ts";

export type ArtifactSummary = {
  slug: string;
  title: string;
  description?: string;
  artifactType?: string;
  createdAt: string;
};

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function nowISO(): string {
  return new Date().toISOString();
}

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Write an artifact spec to disk using atomic write (temp file + rename).
 */
export function writeArtifact(
  projectRoot: string,
  projectName: string,
  spec: VisualArtifactSpec,
): void {
  const bundleDir = getArtifactBundleDir(projectRoot, projectName, spec.slug);
  ensureDir(bundleDir);

  const targetPath = getArtifactJsonPath(projectRoot, projectName, spec.slug);
  const tmpPath = path.join(
    getTempDir(),
    `visual-artifact-${spec.slug}-${Date.now()}.json`,
  );

  const payload = JSON.stringify(spec, null, 2);
  writeFileSync(tmpPath, payload, "utf8");
  renameSync(tmpPath, targetPath);
}

/**
 * Read an artifact spec from disk. Returns null if not found or invalid.
 */
export function readArtifact(
  projectRoot: string,
  projectName: string,
  slug: string,
): VisualArtifactSpec | null {
  const targetPath = getArtifactJsonPath(projectRoot, projectName, slug);
  if (!existsSync(targetPath)) return null;

  try {
    const raw = readFileSync(targetPath, "utf8");
    const parsed = JSON.parse(raw);
    const result = validate(parsed);
    return result.ok ? normalizeMermaidNodesInSpec(result.spec) : null;
  } catch {
    return null;
  }
}

/**
 * List projects that have artifacts.
 */
export function listProjects(projectRoot: string): string[] {
  const root = getArtifactsRoot(projectRoot);
  if (!existsSync(root)) return [];

  try {
    return readdirSync(root).filter((name) => {
      const dir = path.join(root, name);
      return existsSync(dir) && isDirectory(dir);
    });
  } catch {
    return [];
  }
}

/**
 * List artifact summaries for a project.
 */
export function listArtifacts(
  projectRoot: string,
  projectName: string,
): ArtifactSummary[] {
  const projectDir = path.join(getArtifactsRoot(projectRoot), projectName);
  if (!existsSync(projectDir)) return [];

  try {
    const slugs = readdirSync(projectDir).filter((name) => {
      const dir = path.join(projectDir, name);
      return existsSync(dir) && isDirectory(dir);
    });

    const summaries: ArtifactSummary[] = [];
    for (const slug of slugs) {
      const spec = readArtifact(projectRoot, projectName, slug);
      if (spec) {
        summaries.push({
          slug: spec.slug,
          title: spec.title,
          description: spec.description,
          artifactType: spec.artifactType,
          createdAt: getCreationTime(
            getArtifactJsonPath(projectRoot, projectName, slug),
          ),
        });
      }
    }
    return summaries.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  } catch {
    return [];
  }
}

/**
 * Delete an artifact bundle.
 */
export function deleteArtifact(
  projectRoot: string,
  projectName: string,
  slug: string,
): void {
  const bundleDir = getArtifactBundleDir(projectRoot, projectName, slug);
  if (!existsSync(bundleDir)) return;

  try {
    const files = readdirSync(bundleDir);
    for (const file of files) {
      unlinkSync(path.join(bundleDir, file));
    }
    rmdirSync(bundleDir);
  } catch {
    // best effort
  }
}

/**
 * Delete all artifacts in a project (remove the project directory).
 */
export function cleanProject(projectRoot: string, projectName: string): void {
  const projectDir = path.join(getArtifactsRoot(projectRoot), projectName);
  if (!existsSync(projectDir)) return;

  try {
    const entries = readdirSync(projectDir);
    for (const entry of entries) {
      const entryPath = path.join(projectDir, entry);
      if (isDirectory(entryPath)) {
        const files = readdirSync(entryPath);
        for (const file of files) {
          unlinkSync(path.join(entryPath, file));
        }
        rmdirSync(entryPath);
      } else {
        unlinkSync(entryPath);
      }
    }
    rmdirSync(projectDir);
  } catch {
    // best effort
  }
}

/**
 * Delete all artifacts across all projects.
 */
export function cleanAll(projectRoot: string): void {
  const root = getArtifactsRoot(projectRoot);
  if (!existsSync(root)) return;

  let projects: string[];
  try {
    projects = readdirSync(root);
  } catch (err) {
    console.error(`[cleanAll] Failed to read artifacts root "${root}":`, err);
    return;
  }

  for (const projectName of projects) {
    const projectDir = path.join(root, projectName);
    if (!isDirectory(projectDir)) continue;

    try {
      cleanProject(projectRoot, projectName);
    } catch (err) {
      console.error(
        `[cleanAll] Failed to clean project "${projectName}":`,
        err,
      );
      // Continue cleaning other projects
    }
  }
}

function getCreationTime(filePath: string): string {
  try {
    const stat = statSync(filePath);
    return stat.birthtime.toISOString();
  } catch {
    return nowISO();
  }
}
