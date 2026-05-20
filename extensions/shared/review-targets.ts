import path from "node:path";

export type SharedReviewTargetKind = "plan" | "spec";

export const REVIEW_TARGET_PLAN_DIR = "plan";
export const REVIEW_TARGET_SPECS_DIR = "specs";
export const REVIEW_TARGET_SHAPING_DIR = "shaping";
export const REVIEW_TARGET_ISSUES_DIR = "issues";

export const PLAN_REVIEW_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}-.+\.(?:md|html)$/;
export const SPEC_REVIEW_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}-.+-design\.md$/;
export const REVIEW_MARKDOWN_FILE_PATTERN = /^.+\.md$/;

const normalizeRelativePath = (relativePath: string): string =>
  relativePath.replaceAll("\\", "/").replace(/^@/, "");

export const defaultReviewTargetKindFromRelativePath = (
  relativePath: string,
): SharedReviewTargetKind | null => {
  const normalized = normalizeRelativePath(relativePath);
  const parts = normalized.split("/");
  const [dotPi, plans, repoSlug, targetDir, fileName, issueFileName] = parts;

  if (dotPi !== ".pi" || plans !== "plans" || !repoSlug || !targetDir) {
    return null;
  }

  if (parts.length === 5) {
    if (
      targetDir === REVIEW_TARGET_PLAN_DIR &&
      PLAN_REVIEW_FILE_PATTERN.test(fileName)
    ) {
      return "plan";
    }

    if (
      targetDir === REVIEW_TARGET_SPECS_DIR &&
      SPEC_REVIEW_FILE_PATTERN.test(fileName)
    ) {
      return "spec";
    }

    if (
      targetDir === REVIEW_TARGET_SHAPING_DIR &&
      REVIEW_MARKDOWN_FILE_PATTERN.test(fileName)
    ) {
      return "spec";
    }
  }

  const topicSlug = fileName;
  if (
    parts.length === 6 &&
    targetDir === REVIEW_TARGET_ISSUES_DIR &&
    Boolean(topicSlug) &&
    REVIEW_MARKDOWN_FILE_PATTERN.test(issueFileName)
  ) {
    return "plan";
  }

  return null;
};

export const defaultReviewTargetKindFromAbsolutePath = (
  cwd: string,
  targetPath: string,
): SharedReviewTargetKind | null => {
  const relative = path.relative(cwd, targetPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }

  return defaultReviewTargetKindFromRelativePath(relative);
};
