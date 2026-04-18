import { spawnSync } from "node:child_process";
import path from "node:path";

export type StatusOutput = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type GitRunner = (args: string[]) => StatusOutput;

export type DirtySummary = {
  staged: number;
  unstaged: number;
  untracked: number;
  dirty: boolean;
};

export const DEFAULT_GIT_TIMEOUT_MS = 5000;

export const runGit = (
  cwd: string,
  args: string[],
  timeoutMs: number = DEFAULT_GIT_TIMEOUT_MS,
): StatusOutput => {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout: timeoutMs,
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
};

export const createRepoGitRunner =
  (repoRoot: string, timeoutMs: number = DEFAULT_GIT_TIMEOUT_MS): GitRunner =>
  (args) =>
    runGit(repoRoot, args, timeoutMs);

const parseNonEmptyLines = (value: string): string[] =>
  value
    // Split both Unix and Windows newline sequences.
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

const normalizePorcelainPath = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed === "string" && parsed.trim().length > 0) {
        return parsed;
      }
    } catch {
      // fall back to raw path below
    }

    const unquoted = trimmed.slice(1, -1).trim();
    if (unquoted.length > 0) {
      return unquoted;
    }
  }

  return trimmed;
};

const extractPorcelainPath = (line: string): string | null => {
  if (line.length < 4) {
    return null;
  }

  const payload = line.slice(3).trim();
  if (!payload) {
    return null;
  }

  const renameMarker = " -> ";
  const renamedTarget = payload.includes(renameMarker)
    ? (payload.split(renameMarker).at(-1) ?? payload)
    : payload;

  const normalized = normalizePorcelainPath(renamedTarget);
  return normalized.length > 0 ? normalized : null;
};

export const listDirtyPaths = (porcelain: string): string[] => {
  const lines = porcelain
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  const deduped: string[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const path = extractPorcelainPath(line);
    if (!path || seen.has(path)) {
      continue;
    }

    seen.add(path);
    deduped.push(path);
  }

  return deduped;
};

export const getCurrentBranchName = (run: GitRunner): string | null => {
  const result = run(["branch", "--show-current"]);
  if (result.exitCode !== 0) return null;
  const branchName = result.stdout.trim();
  return branchName.length > 0 ? branchName : null;
};

export const listLocalBranches = (run: GitRunner): string[] => {
  const result = run(["branch", "--format=%(refname:short)"]);
  if (result.exitCode !== 0) return [];
  return parseNonEmptyLines(result.stdout);
};

export const branchExists = (run: GitRunner, branch: string): boolean => {
  const result = run([
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ]);
  return result.exitCode === 0;
};

export const getRepoRoot = (
  cwd: string,
  timeoutMs: number = DEFAULT_GIT_TIMEOUT_MS,
): string | null => {
  const result = runGit(cwd, ["rev-parse", "--show-toplevel"], timeoutMs);
  if (result.exitCode !== 0) return null;
  const root = result.stdout.trim();
  return root.length > 0 ? root : null;
};

export const getGitCommonDir = (
  cwd: string,
  timeoutMs: number = DEFAULT_GIT_TIMEOUT_MS,
): string | null => {
  const result = runGit(cwd, ["rev-parse", "--git-common-dir"], timeoutMs);
  if (result.exitCode !== 0) return null;

  const commonDir = result.stdout.trim();
  if (commonDir.length === 0) return null;

  return path.isAbsolute(commonDir) ? commonDir : path.resolve(cwd, commonDir);
};

export const computeDirtySummary = (porcelain: string): DirtySummary => {
  const lines = porcelain
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  let staged = 0;
  let unstaged = 0;
  let untracked = 0;

  for (const line of lines) {
    if (line.startsWith("??")) {
      untracked += 1;
      continue;
    }

    const index = line[0];
    const worktree = line[1];
    if (index && index !== " ") staged += 1;
    if (worktree && worktree !== " ") unstaged += 1;
  }

  return {
    staged,
    unstaged,
    untracked,
    dirty: lines.length > 0,
  };
};

export const checkRepoDirty = (
  repoRoot: string,
  timeoutMs: number = DEFAULT_GIT_TIMEOUT_MS,
): { porcelain: string; summary: DirtySummary } | null => {
  const result = runGit(repoRoot, ["status", "--porcelain"], timeoutMs);
  if (result.exitCode !== 0) {
    return null;
  }
  return {
    porcelain: result.stdout,
    summary: computeDirtySummary(result.stdout),
  };
};
