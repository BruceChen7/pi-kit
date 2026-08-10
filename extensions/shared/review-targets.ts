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
 * Single source of truth for both extensions (plannotator-auto's review
 * queue and plan-mode's prompt guidance + plan-phase write guard), so the
 * two can never disagree on when HTML review is enabled:
 * - `null` → HTML review disabled ([]);
 * - `[]` → disabled ([]);
 * - `undefined`/non-array → defaults (`.pi/html/<repo>/`);
 * - non-empty array → those dirs, resolved absolute against `cwd`.
 */
export const resolveHtmlReviewDirs = (
  cwd: string,
  htmlDirs: unknown,
): string[] => {
  if (htmlDirs === null) {
    return [];
  }
  const configured = Array.isArray(htmlDirs)
    ? htmlDirs.flatMap((entry) => {
        if (typeof entry !== "string") {
          return [];
        }
        const trimmed = entry.trim();
        return trimmed.length > 0 ? [trimmed] : [];
      })
    : [];
  const dirs =
    configured.length > 0
      ? configured
      : htmlDirs === undefined
        ? getDefaultHtmlDirs(cwd)
        : [];
  return Array.from(new Set(dirs.map((dir) => path.resolve(cwd, dir))));
};

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
