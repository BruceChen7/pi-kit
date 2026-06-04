// Workspace discovery — scan for git repos and detect local branches
// Cached in memory + on disk, refreshable via API.
//
// Functional Core / Imperative Shell:
//   Pure decision logic is in parseGitEntries() and computeRepoDiff().
//   Shell code (IO, subprocesses, state) stays at the edges.

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

// ─── Types ─────────────────────────────────────────────────────

export interface GitRepo {
  path: string; // absolute path to the repo root
  name: string; // basename of the path
  branches: string[]; // local branch names (may be empty, lazy-loaded)
}

export interface WorkspaceCache {
  repos: GitRepo[];
  scannedAt: number; // unix ms timestamp
  basePath: string;
}

export interface RepoDiff {
  kept: GitRepo[];
  added: GitRepo[];
  deleted: GitRepo[];
}

// ─── Disk cache (IO) ──────────────────────────────────────────

const CACHE_DIR = join(homedir(), ".pi-webterm");
const CACHE_FILE = join(CACHE_DIR, "workspace-cache.json");

/** Exposed for testing. */
export function getCachePath(): string {
  return CACHE_FILE;
}

function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
}

/** Persist workspace cache to disk (`~/.pi-webterm/workspace-cache.json`). */
export function saveCacheToDisk(cache: WorkspaceCache): void {
  ensureCacheDir();
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
}

/**
 * Load workspace cache from disk.
 * Returns `null` if the file is missing, invalid, or the basePath doesn't match.
 */
export function loadCacheFromDisk(basePath: string): WorkspaceCache | null {
  try {
    const raw = readFileSync(CACHE_FILE, "utf-8");
    const cache: WorkspaceCache = JSON.parse(raw);
    if (cache.basePath === resolve(basePath) && Array.isArray(cache.repos)) {
      return cache;
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Short hash (for session name disambiguation) ──────────────

/**
 * Generate a short hash (first 4 hex chars) for a given string.
 * Used to disambiguate tmux session names when the same dirname+branch
 * points to different filesystem paths.
 */
export function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 4);
}

// ─── Git helpers (IO) ──────────────────────────────────────────

/**
 * Get all local branch names for a git repository.
 */
export function getLocalBranches(repoPath: string): string[] {
  try {
    const out = execSync("git branch --format='%(refname:short)' 2>/dev/null", {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 10_000,
    });
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

// ─── Functional Core: pure decision logic ─────────────────────

/**
 * Parse raw `fd` output into a sorted, deduplicated list of repo root paths.
 *
 * Pure function — no IO. Takes the raw output string from `fd` and returns
 * an array of absolute directory paths (parent of each `.git` entry).
 */
export function parseGitEntries(rawOutput: string): string[] {
  if (!rawOutput) return [];

  const lines = rawOutput
    .trim()
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (lines.length === 0) return [];

  const seen = new Set<string>();
  const roots: string[] = [];
  for (const entry of lines) {
    // fd returns absolute paths, so resolve is effectively a no-op for safety
    const parent = dirname(resolve(entry));
    if (seen.has(parent)) continue;
    seen.add(parent);
    roots.push(parent);
  }

  return roots.sort((a, b) => a.localeCompare(b));
}

/**
 * Compute repo diff: given old cached repos and the current filesystem state,
 * determine which repos to keep, delete, and add.
 *
 * Pure function — no IO. All filesystem state is passed in as values.
 *
 * @param cachedRepos — repos from the previous scan
 * @param existingWithGit — set of paths that still have a `.git` entry
 * @param allDirPaths — all directory entries currently at depth 1 under basePath
 */
export function computeRepoDiff(
  cachedRepos: GitRepo[],
  existingWithGit: Set<string>,
  allDirPaths: Set<string>,
): RepoDiff {
  const kept: GitRepo[] = [];
  const deleted: GitRepo[] = [];

  for (const repo of cachedRepos) {
    if (existingWithGit.has(repo.path)) {
      kept.push(repo);
    } else {
      deleted.push(repo);
    }
  }

  const seen = new Set(kept.map((r) => r.path));
  const added: GitRepo[] = [];
  for (const dirPath of allDirPaths) {
    if (seen.has(dirPath)) continue;
    if (existingWithGit.has(dirPath)) {
      added.push({
        path: dirPath,
        name: basename(dirPath),
        branches: [], // lazy — fetched on demand
      });
    }
  }

  return { kept, added, deleted };
}

// ─── Shell: scanning + IO ─────────────────────────────────────

function repoExists(repoPath: string): boolean {
  return existsSync(join(repoPath, ".git"));
}

/**
 * Full scan: use `fd` to locate `.git` entries under `basePath`,
 * excluding `node_modules`. Returns repos with empty branches
 * (lazy-loaded on demand via API).
 */
export function scanGitRepos(
  basePath: string,
  maxDepth: number = 3,
): GitRepo[] {
  const resolvedBase = resolve(basePath);
  if (!existsSync(resolvedBase)) return [];

  let output: string;
  try {
    // fd -H (include hidden), -d N (max depth),
    // -E node_modules (exclude), regex pattern '^\.git$'
    output = execSync(
      `fd -H -d ${maxDepth} -E node_modules '^\\.git$' ${resolvedBase} 2>/dev/null`,
      { encoding: "utf-8", stdio: "pipe", timeout: 15_000 },
    );
  } catch {
    return [];
  }

  const roots = parseGitEntries(output);

  return roots
    .filter((r) => repoExists(r))
    .map((p) => ({ path: p, name: basename(p), branches: [] }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Incremental refresh: check existing cached repos, scan depth-1
 * directories for new ones. Pure diff logic delegated to computeRepoDiff.
 */
function incrementalRefresh(
  old: WorkspaceCache,
  basePath: string,
): WorkspaceCache {
  // IO: read directory entries at depth 1
  let dirPaths: string[];
  try {
    const entries = readdirSync(basePath, { withFileTypes: true });
    dirPaths = entries
      .filter((e) => e.isDirectory())
      .map((e) => join(basePath, e.name));
  } catch {
    dirPaths = [];
  }

  // IO: check .git existence for all candidate paths
  const allCandidatePaths = [...old.repos.map((r) => r.path), ...dirPaths];
  const existingWithGit = new Set(
    allCandidatePaths.filter((p) => repoExists(p)),
  );

  // Pure: compute which repos changed
  const { kept, added } = computeRepoDiff(
    old.repos,
    existingWithGit,
    new Set(dirPaths),
  );

  return {
    repos: [...kept, ...added].sort((a, b) => a.name.localeCompare(b.name)),
    scannedAt: Date.now(),
    basePath,
  };
}

// ─── WorkspaceScanner (cache lifecycle as first-class object) ──

export class WorkspaceScanner {
  private _cache: WorkspaceCache | null = null;

  /**
   * Full scan from scratch. Persists to disk.
   */
  discoverWorkspace(basePath?: string): WorkspaceCache {
    const bp = basePath ? resolve(basePath) : process.cwd();
    const repos = scanGitRepos(bp);
    this._cache = {
      repos,
      scannedAt: Date.now(),
      basePath: bp,
    };
    saveCacheToDisk(this._cache);
    return this._cache;
  }

  /**
   * Get cached workspace. Priority: memory → disk → full scan.
   */
  getWorkspaceCache(basePath?: string): WorkspaceCache {
    if (this._cache) return this._cache;

    const bp = basePath ? resolve(basePath) : process.cwd();

    const disk = loadCacheFromDisk(bp);
    if (disk) {
      this._cache = disk;
      return this._cache;
    }

    return this.discoverWorkspace(bp);
  }

  /**
   * Incremental refresh (no subprocesses when cache exists).
   * Falls back to full scan when no cache is found.
   */
  refreshWorkspace(basePath?: string): WorkspaceCache {
    const bp = basePath ? resolve(basePath) : process.cwd();
    const old = this._cache ?? loadCacheFromDisk(bp);

    if (!old) {
      return this.discoverWorkspace(bp);
    }

    this._cache = incrementalRefresh(old, bp);
    saveCacheToDisk(this._cache);
    return this._cache;
  }

  /** Reset the in-memory cache (for testing). */
  resetCache(): void {
    this._cache = null;
  }
}

// ─── Default singleton (backward-compatible function exports) ──

const _defaultScanner = new WorkspaceScanner();

export const discoverWorkspace =
  _defaultScanner.discoverWorkspace.bind(_defaultScanner);
export const getWorkspaceCache =
  _defaultScanner.getWorkspaceCache.bind(_defaultScanner);
export const refreshWorkspace =
  _defaultScanner.refreshWorkspace.bind(_defaultScanner);
export const resetWorkspaceCache =
  _defaultScanner.resetCache.bind(_defaultScanner);
