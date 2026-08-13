import fs from "node:fs";
import path from "node:path";
import { runGit } from "../shared/git.ts";

/**
 * Git-worktree-aware project scope resolution.
 *
 * pi resolves its project scope strictly from `<cwd>/.pi` (no ancestor walk,
 * no git-root detection). For a session inside a linked git worktree this
 * would isolate the worktree from the main repo's configuration. To share
 * configuration between a worktree and the main repo root we:
 *
 * 1. detect the worktree via its `.git` file (a file whose content starts
 *    with `gitdir: `, as written by `git worktree add`);
 * 2. resolve the main repo root from `git worktree list --porcelain` (first
 *    entry is always the main worktree; also correct for bare layouts);
 * 3. link `<worktreeRoot>/.pi` to `<mainRoot>/.pi` so pi itself reads the
 *    shared project scope from the worktree session (ensureSharedWorktreeConfig);
 * 4. key plugin-toggle settings by the shared root (resolveSharedProjectRoot).
 */

export type WorktreeScope = {
  worktreeRoot: string;
  mainRoot: string;
};

export type SharedConfigStatus =
  | "created"
  | "existing"
  | "not-worktree"
  | "skipped";

const WORKTREE_LINK_PREFIX = "gitdir: ";

/**
 * Process-wide cache: worktreeRoot -> mainRoot (resolved successfully).
 * Only successful resolutions are cached — a transient `git worktree list`
 * failure must not pin a permanent negative result. Bounded: the map is
 * capped and evicts oldest entries first (Map insertion order).
 */
const mainRootCache = new Map<string, string>();
const MAIN_ROOT_CACHE_MAX = 64;

function cacheMainRoot(worktreeRoot: string, mainRoot: string): void {
  if (mainRootCache.size >= MAIN_ROOT_CACHE_MAX) {
    const oldest = mainRootCache.keys().next().value;
    if (oldest !== undefined) mainRootCache.delete(oldest);
  }
  mainRootCache.set(worktreeRoot, mainRoot);
}

/**
 * Pure decision: extract the main worktree path from
 * `git worktree list --porcelain` output. The first `worktree <path>` line
 * is always the main worktree (linked ones follow; bare main is marked with
 * a `bare` key but still first). Returns null when no entry is found.
 */
export function parseMainWorktreePath(porcelain: string): string | null {
  for (const line of porcelain.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("worktree ")) {
      const worktreePath = trimmed.slice("worktree ".length).trim();
      return worktreePath.length > 0 ? worktreePath : null;
    }
  }
  return null;
}

/**
 * Find the linked-worktree scope for a directory: walk up from `cwd` to the
 * nearest `.git` entry. A directory `.git` is a regular repository (no
 * worktree scope). A `.git` file whose content starts with `gitdir: ` marks
 * a linked worktree; the containing directory is the worktree root and the
 * main repo root comes from `git worktree list --porcelain`.
 *
 * Returns null for regular repos, non-git directories, and worktrees whose
 * main root cannot be resolved (porcelain failed) — callers fall back to
 * plain per-cwd behavior in all these cases.
 */
export function findGitWorktreeRoot(cwd: string): WorktreeScope | null {
  const startDir = path.resolve(cwd);
  let dir = startDir;

  while (true) {
    let gitStat: fs.Stats | null = null;
    try {
      gitStat = fs.lstatSync(path.join(dir, ".git"));
    } catch {
      // ENOENT: keep walking up
    }

    if (gitStat?.isFile()) {
      let content = "";
      try {
        content = fs.readFileSync(path.join(dir, ".git"), "utf8").trim();
      } catch {
        return null;
      }
      if (!content.startsWith(WORKTREE_LINK_PREFIX)) return null;

      const worktreeRoot = dir;
      const cached = mainRootCache.get(worktreeRoot);
      if (cached !== undefined) {
        return { worktreeRoot, mainRoot: cached };
      }

      const porcelain = runGit(worktreeRoot, [
        "worktree",
        "list",
        "--porcelain",
      ]);
      const mainRoot =
        porcelain.exitCode === 0
          ? parseMainWorktreePath(porcelain.stdout)
          : null;

      if (mainRoot && mainRoot !== worktreeRoot) {
        cacheMainRoot(worktreeRoot, mainRoot);
        return { worktreeRoot, mainRoot };
      }
      return null;
    }

    if (gitStat?.isDirectory()) return null; // regular repo

    const parentDir = path.dirname(dir);
    if (parentDir === dir) return null;
    dir = parentDir;
  }
}

/**
 * The state of `<worktreeRoot>/.pi` on disk (one lstat, value-in/value-out).
 */
function piStateAt(worktreeRoot: string): "symlink" | "absent" | "real-dir" {
  try {
    const stat = fs.lstatSync(path.join(worktreeRoot, ".pi"));
    return stat.isSymbolicLink() ? "symlink" : "real-dir";
  } catch {
    return "absent";
  }
}

/**
 * Pure decision: whether a worktree shares the main repo's `.pi`.
 * Shared when the path is already a symlink or not present at all (the
 * session_start hook creates the link before anything else runs). A real
 * per-worktree `.pi` directory means per-worktree behavior.
 */
export function isSharedPiScope(
  state: "symlink" | "absent" | "real-dir",
): boolean {
  return state === "symlink" || state === "absent";
}

/**
 * The settings key for a cwd. In a linked worktree with a shared `.pi`
 * (symlink, or absent — ensureSharedWorktreeConfig will create it), the key
 * is the main repo root so worktree and root sessions share one entry.
 * Everything else uses the canonical (realpath) cwd — git reports worktree
 * paths in canonical form, so a lexical key could never match the root
 * session's key when the path contains symlinks (e.g. /var -> /private/var).
 */
export function resolveSharedProjectRoot(cwd: string): string {
  const scope = findGitWorktreeRoot(cwd);
  if (!scope) return canonicalPath(cwd);

  if (isSharedPiScope(piStateAt(scope.worktreeRoot))) {
    return scope.mainRoot;
  }
  return canonicalPath(cwd); // real per-worktree .pi: keep per-worktree key
}

function canonicalPath(cwd: string): string {
  try {
    return fs.realpathSync(cwd);
  } catch {
    return path.resolve(cwd);
  }
}

/**
 * Establish shared configuration for a linked worktree session: link
 * `<worktreeRoot>/.pi` to `<mainRoot>/.pi` so pi loads the main repo's
 * project extensions/skills/prompts/themes from the worktree session.
 *
 * - `"created"`: link created (notify caller; /reload needed to load plugins).
 * - `"existing"`: worktree already has its own `.pi` (real dir or link) — never
 *   clobbered; per-worktree behavior continues.
 * - `"not-worktree"`: regular repo / non-git dir — nothing to do.
 * - `"skipped"`: link could not be created (e.g. main root `.pi` mkdir failed);
 *   a real `<worktreeRoot>/.pi` is materialized so the mode is deterministic.
 */
export function ensureSharedWorktreeConfig(cwd: string): SharedConfigStatus {
  const scope = findGitWorktreeRoot(cwd);
  if (!scope) return "not-worktree";

  const piPath = path.join(scope.worktreeRoot, ".pi");
  if (piStateAt(scope.worktreeRoot) !== "absent") {
    return "existing";
  }

  try {
    fs.mkdirSync(path.join(scope.mainRoot, ".pi"), { recursive: true });
    fs.symlinkSync(path.join(scope.mainRoot, ".pi"), piPath, "dir");
    return "created";
  } catch {
    // Fall back to a real per-worktree .pi so subsequent reads/writes are
    // deterministic instead of creating one implicitly mid-session.
    try {
      fs.mkdirSync(piPath, { recursive: true });
    } catch {
      // Ignore: mkdir will be retried by the normal plugin flows.
    }
    return "skipped";
  }
}
