import type { StatusOutput } from "../shared/git.js";
import { runGit } from "../shared/git.js";

export type GitRunner = (args: string[]) => StatusOutput;

export const createRepoGitRunner =
  (repoRoot: string, timeoutMs: number): GitRunner =>
  (args) =>
    runGit(repoRoot, args, timeoutMs);

const toLines = (value: string): string[] =>
  value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

export const getCurrentBranchName = (run: GitRunner): string | null => {
  const result = run(["branch", "--show-current"]);
  if (result.exitCode !== 0) return null;
  const trimmed = result.stdout.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const listLocalBranches = (run: GitRunner): string[] => {
  const result = run(["branch", "--format=%(refname:short)"]);
  if (result.exitCode !== 0) return [];
  return toLines(result.stdout);
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
