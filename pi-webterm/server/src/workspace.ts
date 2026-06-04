// Workspace discovery — scan for git repos and detect local branches
// Cached in memory, refreshable via API.

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";

// ─── Types ─────────────────────────────────────────────────────

export interface GitRepo {
  path: string; // absolute path to the repo root
  name: string; // basename of the path
  branches: string[]; // local branch names
}

export interface WorkspaceCache {
  repos: GitRepo[];
  scannedAt: number; // unix ms timestamp
  basePath: string;
}

// ─── Short hash for session name disambiguation ────────────────

/**
 * Generate a short hash (first 4 hex chars) for a given string.
 * Used to disambiguate tmux session names when the same dirname+branch
 * points to different filesystem paths.
 */
export function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 4);
}

// ─── Git helpers ──────────────────────────────────────────────

/**
 * Check if a path is inside a valid git repository.
 */
function isValidGitRepo(repoPath: string): boolean {
  try {
    execSync("git rev-parse --git-dir 2>/dev/null", {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get all local branch names for a git repository.
 */
export function getLocalBranches(repoPath: string): string[] {
  try {
    const out = execSync(
      "git branch --format='%(refname:short)' 2>/dev/null",
      {
        cwd: repoPath,
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 10_000,
      },
    );
    if (!out) return [];
    return out
      .trim()
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } catch {
    return [];
  }
}

// ─── Scanning ──────────────────────────────────────────────────

/**
 * Resolve a potential git path: given a `.git` entry (file or directory),
 * return the repo root path. For worktrees, `.git` is a file containing
 * `gitdir: <path>` — we still use the file's parent as the repo root.
 */
function resolveGitPath(gitEntry: string): string | null {
  const parent = dirname(resolve(gitEntry));
  if (!existsSync(parent)) return null;
  // Verify it's a valid git repo
  if (isValidGitRepo(parent)) return parent;
  return null;
}

/**
 * Scan a base path for git repositories up to a given depth.
 *
 * Uses `find` to locate `.git` entries (both directories for regular repos
 * and files for git worktrees), resolves each to a valid repo root.
 */
export function scanGitRepos(
  basePath: string,
  maxDepth: number = 3,
): GitRepo[] {
  const resolvedBase = resolve(basePath);
  if (!existsSync(resolvedBase)) return [];

  let output: string;
  try {
    output = execSync(
      `find ${resolvedBase} -maxdepth ${maxDepth} -name ".git" 2>/dev/null`,
      { encoding: "utf-8", stdio: "pipe", timeout: 15_000 },
    );
  } catch {
    return [];
  }

  if (!output) return [];

  const seen = new Set<string>();
  const repos: GitRepo[] = [];

  const lines = output
    .trim()
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const gitEntry of lines) {
    const repoPath = resolveGitPath(gitEntry);
    if (!repoPath) continue;
    if (seen.has(repoPath)) continue;
    seen.add(repoPath);

    const branches = getLocalBranches(repoPath);
    repos.push({
      path: repoPath,
      name: repoPath.split("/").pop() ?? repoPath,
      branches,
    });
  }

  // Sort by name for deterministic UI ordering
  repos.sort((a, b) => a.name.localeCompare(b.name));

  return repos;
}

// ─── Cache management ─────────────────────────────────────────

let _cache: WorkspaceCache | null = null;

/**
 * Discover the workspace: scan for git repos and cache the result.
 * Uses `basePath` if provided, otherwise the current working directory.
 */
export function discoverWorkspace(basePath?: string): WorkspaceCache {
  const bp = basePath ? resolve(basePath) : process.cwd();
  const repos = scanGitRepos(bp);
  _cache = {
    repos,
    scannedAt: Date.now(),
    basePath: bp,
  };
  return _cache;
}

/**
 * Get the cached workspace result. If no cache exists, runs discovery
 * with the given basePath, or falls back to the current working directory.
 */
export function getWorkspaceCache(basePath?: string): WorkspaceCache {
  return _cache ?? discoverWorkspace(basePath);
}

/**
 * Force-refresh the workspace cache.
 */
export function refreshWorkspace(basePath?: string): WorkspaceCache {
  return discoverWorkspace(basePath);
}

/**
 * Reset the workspace cache (for testing).
 */
export function resetWorkspaceCache(): void {
  _cache = null;
}
