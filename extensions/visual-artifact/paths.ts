/**
 * Path utilities for artifact storage.
 *
 * Artifacts are stored under the project's .pi/ directory:
 *   <project-root>/.pi/visual-artifact/artifacts/<project>/<slug>/artifact.json
 *   <project-root>/.pi/visual-artifact/artifacts/<project>/<slug>/annotations.json
 *
 * The project root is derived from the caller's git root or working directory.
 */

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
 * Get the default project root. Uses the current working directory.
 */
export function getDefaultProjectRoot(): string {
  return process.cwd();
}

/**
 * Get the system temp directory for atomic writes.
 */
export function getTempDir(): string {
  return os.tmpdir();
}
