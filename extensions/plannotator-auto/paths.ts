import path from "node:path";
import {
  defaultAutoReviewTargetKindFromAbsolutePath,
  defaultReviewTargetKindFromAbsolutePath,
  HTML_REVIEW_FILE_PATTERN,
} from "../shared/review-targets.ts";
import type { ReviewTargetKind } from "./plan-review/types.ts";

export const toRepoRelativePath = (
  ctx: { cwd: string },
  targetPath: string,
): string => {
  const relative = path.relative(ctx.cwd, targetPath);
  if (
    relative.length > 0 &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  ) {
    return relative;
  }

  return targetPath;
};

export const isDirectChildFileMatch = (
  dir: string,
  pattern: RegExp,
  targetPath: string,
): boolean => {
  if (path.dirname(targetPath) !== dir) {
    return false;
  }

  return pattern.test(path.basename(targetPath));
};

const isHtmlFileMatch = (htmlDir: string, targetPath: string): boolean =>
  isDirectChildFileMatch(htmlDir, HTML_REVIEW_FILE_PATTERN, targetPath);

const isHtmlFileMatchAny = (
  htmlDirs: readonly string[],
  targetPath: string,
): boolean => htmlDirs.some((htmlDir) => isHtmlFileMatch(htmlDir, targetPath));

type ReviewTargetMatch = {
  kind: ReviewTargetKind;
  reviewFile: string;
};

type ReviewTargetOptions = {
  /**
   * The user reviewed this document by hand this session. Manual review
   * covers the whole `.pi/` tree, so it also makes a document outside the
   * auto-review conventions (`.pi/research/…`) queueable.
   */
  manuallyReviewed?: boolean;
};

/**
 * Pure: is this a `.pi/` document at all? The broad rule — any `.md`/`.html`
 * under `.pi/` — is the manual review scope, wider than the auto-review
 * conventions (`plan` / `specs` / `.pi/html`).
 */
export const isRepoReviewDocument = (
  cwd: string,
  targetPath: string,
): boolean => defaultReviewTargetKindFromAbsolutePath(cwd, targetPath) !== null;

const getReviewTargetKind = (
  htmlDirs: readonly string[],
  targetPath: string,
  cwd: string,
): ReviewTargetKind | null => {
  // Plan/spec review locations are convention-based: any directory named
  // `plan` / `specs` under `.pi/` is a review target. HTML artifact dirs
  // are the convention `.pi/html/<repo>/`. No configuration exists.
  const autoReviewKind = defaultAutoReviewTargetKindFromAbsolutePath(
    cwd,
    targetPath,
  );
  if (autoReviewKind) {
    return autoReviewKind;
  }

  if (isHtmlFileMatchAny(htmlDirs, targetPath)) {
    return "html";
  }

  return null;
};

export const resolveReviewTargetMatch = (
  ctx: { cwd: string },
  htmlDirs: readonly string[],
  targetPath: string,
  options: ReviewTargetOptions = {},
): ReviewTargetMatch | null => {
  const kind = getReviewTargetKind(htmlDirs, targetPath, ctx.cwd);
  if (kind) {
    return {
      kind,
      reviewFile: toRepoRelativePath(ctx, targetPath),
    };
  }

  // A document the user reviewed by hand keeps taking part in the review
  // loop for the rest of the session: its next write queues again, so the
  // revision can be auto-submitted instead of dead-ending at "no pending
  // review draft".
  if (options.manuallyReviewed && isRepoReviewDocument(ctx.cwd, targetPath)) {
    return {
      kind: isHtmlPath(targetPath) ? "html" : "plan",
      reviewFile: toRepoRelativePath(ctx, targetPath),
    };
  }

  return null;
};

/**
 * Pure predicate: is `targetPath` a path the auto review flow may queue?
 * Value in / value out — `htmlDirs` come from `resolveHtmlReviewDirs` (Shell),
 * everything else is derived from the arguments.
 */
export const isAutoReviewTarget = (
  htmlDirs: readonly string[],
  cwd: string,
  targetPath: string,
): boolean => getReviewTargetKind(htmlDirs, targetPath, cwd) !== null;

export const resolvePlanFileForReview = (
  ctx: { cwd: string },
  htmlDirs: readonly string[],
  targetPath: string,
): string | null =>
  resolveReviewTargetMatch(ctx, htmlDirs, targetPath)?.reviewFile ?? null;

export const isReviewDocumentPath = (targetPath: string): boolean =>
  [".md", ".html"].includes(path.extname(targetPath).toLowerCase());

export const isHtmlPath = (targetPath: string): boolean =>
  path.extname(targetPath).toLowerCase() === ".html";

export const isPathWithinCwd = (
  ctx: { cwd: string },
  targetPath: string,
): boolean => {
  const relative = path.relative(ctx.cwd, targetPath);
  return (
    relative.length === 0 ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};
