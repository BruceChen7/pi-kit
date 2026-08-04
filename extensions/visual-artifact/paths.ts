/**
 * Path utilities for artifact storage.
 *
 * Artifacts are stored under the project's .pi/ directory:
 *   <project-root>/.pi/visual-artifact/artifacts/<project>/<slug>/artifact.json
 *   <project-root>/.pi/visual-artifact/artifacts/<project>/<slug>/annotations.json
 *
 * The project root is derived from the caller's git root or working directory.
 */

import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

export const ARTIFACTS_RELATIVE_DIR = path.join(
  ".pi",
  "visual-artifact",
  "artifacts",
);

/**
 * Derive the project name from a directory path.
 * Uses the directory basename as the project name.
 */
export function deriveProjectName(dir: string): string {
  return path.basename(path.resolve(dir));
}

/**
 * Get the artifact storage root for a given project root directory.
 * Returns `<projectRoot>/.pi/visual-artifact/artifacts/`
 */
export function getArtifactsRoot(projectRoot: string): string {
  return path.join(projectRoot, ARTIFACTS_RELATIVE_DIR);
}

/**
 * Get the bundle directory for a specific artifact.
 * Returns `<artifactsRoot>/<project>/<slug>/`
 */
export function getArtifactBundleDir(
  projectRoot: string,
  projectName: string,
  slug: string,
): string {
  return path.join(getArtifactsRoot(projectRoot), projectName, slug);
}

/**
 * Get the artifact.json path for a specific artifact.
 */
export function getArtifactJsonPath(
  projectRoot: string,
  projectName: string,
  slug: string,
): string {
  return path.join(
    getArtifactBundleDir(projectRoot, projectName, slug),
    "artifact.json",
  );
}

/**
 * Get the annotations.json path for a specific artifact.
 */
export function getAnnotationsJsonPath(
  projectRoot: string,
  projectName: string,
  slug: string,
): string {
  return path.join(
    getArtifactBundleDir(projectRoot, projectName, slug),
    "annotations.json",
  );
}

/**
 * Get the default project root.
 *
 * Resolves to the git repository root (via `git rev-parse --show-toplevel`)
 * when inside a git repo, falling back to the current working directory otherwise.
 * This ensures worktrees resolve to the main repo root, so all artifacts share
 * a single `.pi/visual-artifact/artifacts/` tree regardless of worktree location.
 */
export function getDefaultProjectRoot(): string {
  try {
    const gitRoot = execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
      timeout: 3000,
    }).trim();
    if (gitRoot) return gitRoot;
  } catch {
    // not a git repository, or git unavailable
  }
  return process.cwd();
}

/**
 * Get the system temp directory for atomic writes.
 */
export function getTempDir(): string {
  return os.tmpdir();
}
