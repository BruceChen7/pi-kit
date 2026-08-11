import path from "node:path";
import {
  defaultAutoReviewTargetKindFromAbsolutePath,
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
): ReviewTargetMatch | null => {
  const kind = getReviewTargetKind(htmlDirs, targetPath, ctx.cwd);
  if (!kind) {
    return null;
  }

  return {
    kind,
    reviewFile: toRepoRelativePath(ctx, targetPath),
  };
};

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
