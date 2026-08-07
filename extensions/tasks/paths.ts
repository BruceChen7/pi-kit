/**
 * Path utilities for tasks storage.
 *
 * Tasks are stored under the project's .pi/ directory:
 *   <project-root>/.pi/tasks/tasks.json
 */

import { execSync } from "node:child_process";

/**
 * Resolves to the git repository root (via `git rev-parse --show-toplevel`)
 * when inside a git repo, falling back to the current working directory.
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
