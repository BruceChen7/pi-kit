import path from "node:path";
import { DEFAULT_GIT_TIMEOUT_MS, getGitCommonDir } from "./git.ts";

export const REVIEW_TARGET_PLAN_DIR = "plan";
export const REVIEW_TARGET_SPECS_DIR = "specs";

export const PLAN_REVIEW_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}-.+\.md$/;
export const SPEC_REVIEW_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}-.+-design\.md$/;
export const HTML_REVIEW_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}-.+\.html$/;

export const getRepoSlugFromGitCommonDir = (cwd: string): string | null => {
  const commonDir = getGitCommonDir(cwd, DEFAULT_GIT_TIMEOUT_MS);
  if (!commonDir) {
    return null;
  }

  const candidate = path.basename(path.dirname(commonDir)).trim();
  return candidate.length > 0 ? candidate : null;
};

/** Default `.pi/html/<repo>/` dirs (repo slug from the git common dir, falling back to the cwd basename). */
export const getDefaultHtmlDirs = (cwd: string): string[] =>
  Array.from(
    new Set(
      [getRepoSlugFromGitCommonDir(cwd), path.basename(cwd).trim()]
        .filter((candidate): candidate is string => Boolean(candidate))
        .map((candidate) => path.join(".pi", "html", candidate)),
    ),
  );

/**
 * Resolve the HTML artifact review dirs for `cwd` as absolute paths.
 *
 * HTML review locations are convention-based — always `.pi/html/<repo>/`
 * (repo slug from the git common dir, falling back to the cwd basename) —
 * and are NOT configurable. Single source of truth for both extensions
 * (plannotator-auto's review queue and plan-mode's prompt guidance +
 * plan-phase write guard), so the two can never disagree.
 */
export const resolveHtmlReviewDirs = (cwd: string): string[] =>
  Array.from(
    new Set(getDefaultHtmlDirs(cwd).map((dir) => path.resolve(cwd, dir))),
  );

const normalizeRelativePath = (relativePath: string): string =>
  relativePath.replaceAll("\\", "/").replace(/^@/, "");

/**
 * Classify a repo-relative path as a review target.
 *
 * The rule is deliberately broad: every `.md`/`.html` file anywhere under
 * the project `.pi/` directory counts as a review target. The well-known
 * locations (`.pi/plans/<repo>/{plan,specs,shaping,issues}`, `.pi/html/…`)
 * are subsumed by this single rule, which is shared by plan-mode (the
 * plan-phase write guard) and plannotator-auto (the review queue) so the
 * two extensions can never disagree.
 *
 * The agent-facing guidance about WHERE to write stays intentionally
 * narrower (`.pi/plans/<repo>/plan/…` etc.): the gate is permissive, the
 * guidance is prescriptive.
 */
export const defaultReviewTargetKindFromRelativePath = (
  relativePath: string,
): "plan" | null => {
  const normalized = normalizeRelativePath(relativePath);
  const parts = normalized.split("/");
  const leafName = parts[parts.length - 1] ?? "";
  return parts[0] === ".pi" && /\.(?:md|html)$/i.test(leafName) ? "plan" : null;
};

export const defaultReviewTargetKindFromAbsolutePath = (
  cwd: string,
  targetPath: string,
): "plan" | null => {
  const relative = path.relative(cwd, targetPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }

  return defaultReviewTargetKindFromRelativePath(relative);
};

/**
 * Narrow rule: which files are eligible for the AUTO review flow (pending
 * gate → `plannotator_auto_submit_review`). Only files whose parent directory
 * is exactly `plan` (md or html) or `specs` (md only) count; any repo slug
 * under `.pi/` works. Everything else under `.pi/` (teach, issues, shaping,
 * contexts, skills, …) is excluded from auto review, while manual review
 * (picker / Ctrl+Alt+L) still covers the whole `.pi/` tree.
 *
 * This complements (not replaces) the broad rule above: the broad rule keeps
 * gating what the agent may WRITE during plan phase (permissive), the narrow
 * rule gates what may QUEUE for auto review.
 */
export const defaultAutoReviewTargetKindFromRelativePath = (
  relativePath: string,
): "plan" | "spec" | null => {
  const normalized = normalizeRelativePath(relativePath);
  const parts = normalized.split("/");
  if (parts.length < 3 || parts[0] !== ".pi") {
    return null;
  }

  const dirName = parts[parts.length - 2];
  const fileName = parts[parts.length - 1];
  if (dirName === "plan") {
    return /^\d{4}-\d{2}-\d{2}-.+\.(?:md|html)$/i.test(fileName)
      ? "plan"
      : null;
  }
  if (dirName === "specs") {
    return /^\d{4}-\d{2}-\d{2}-.+-design\.md$/i.test(fileName) ? "spec" : null;
  }
  return null;
};

export const defaultAutoReviewTargetKindFromAbsolutePath = (
  cwd: string,
  targetPath: string,
): "plan" | "spec" | null => {
  const relative = path.relative(cwd, targetPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }

  return defaultAutoReviewTargetKindFromRelativePath(relative);
};
