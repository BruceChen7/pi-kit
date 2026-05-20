import path from "node:path";
import { DEFAULT_GIT_TIMEOUT_MS, getGitCommonDir } from "../shared/git.ts";
import {
  defaultReviewTargetKindFromAbsolutePath,
  PLAN_REVIEW_FILE_PATTERN,
  REVIEW_TARGET_PLAN_DIR,
  REVIEW_TARGET_SPECS_DIR,
  SPEC_REVIEW_FILE_PATTERN,
} from "../shared/review-targets.ts";
import type { ExtraReviewTargetConfig } from "./config.ts";
import { loadConfig } from "./config.ts";
import type {
  ExtraReviewTarget,
  PlanFileConfig,
  ReviewTargetKind,
} from "./plan-review/types.ts";

const resolveRepoSlugFromGitCommonDir = (cwd: string): string | null => {
  const commonDir = getGitCommonDir(cwd, DEFAULT_GIT_TIMEOUT_MS);
  if (!commonDir) {
    return null;
  }

  const candidate = path.basename(path.dirname(commonDir)).trim();
  return candidate.length > 0 ? candidate : null;
};

const getDefaultReviewRoots = (cwd: string): string[] => {
  const candidates = [
    resolveRepoSlugFromGitCommonDir(cwd),
    path.basename(cwd).trim(),
  ].filter((candidate): candidate is string => Boolean(candidate));

  return Array.from(
    new Set(
      candidates.map((candidate) => path.join(".pi", "plans", candidate)),
    ),
  );
};

export const getDefaultPlanDirs = (cwd: string): string[] =>
  getDefaultReviewRoots(cwd).map((root) =>
    path.join(root, REVIEW_TARGET_PLAN_DIR),
  );

export const getDefaultSpecDirs = (cwd: string): string[] =>
  getDefaultReviewRoots(cwd).map((root) =>
    path.join(root, REVIEW_TARGET_SPECS_DIR),
  );

export const resolveExtraReviewTargets = (
  cwd: string,
  extraReviewTargets: ExtraReviewTargetConfig[] | undefined,
): ExtraReviewTarget[] =>
  (extraReviewTargets ?? []).flatMap((target) => {
    try {
      return [
        {
          dir: path.resolve(cwd, target.dir),
          pattern: new RegExp(target.filePattern),
        },
      ];
    } catch {
      return [];
    }
  });

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

const isPlanFileMatch = (planDir: string, targetPath: string): boolean =>
  isDirectChildFileMatch(planDir, PLAN_REVIEW_FILE_PATTERN, targetPath);

const isPlanFileMatchAny = (planDirs: string[], targetPath: string): boolean =>
  planDirs.some((planDir) => isPlanFileMatch(planDir, targetPath));

const isSpecFileMatch = (specDir: string, targetPath: string): boolean =>
  isDirectChildFileMatch(specDir, SPEC_REVIEW_FILE_PATTERN, targetPath);

const isExtraReviewTargetMatch = (
  target: ExtraReviewTarget,
  targetPath: string,
): boolean => isDirectChildFileMatch(target.dir, target.pattern, targetPath);

const isSpecFileMatchAny = (specDirs: string[], targetPath: string): boolean =>
  specDirs.some((specDir) => isSpecFileMatch(specDir, targetPath));

const getCwdFromPlanConfig = (planConfig: PlanFileConfig): string =>
  path.dirname(
    path.dirname(path.dirname(path.dirname(planConfig.resolvedPlanPath))),
  );

const isExtraReviewTargetMatchAny = (
  targets: ExtraReviewTarget[] | undefined,
  targetPath: string,
): boolean =>
  (targets ?? []).some((target) =>
    isExtraReviewTargetMatch(target, targetPath),
  );

type ReviewTargetMatch = {
  kind: ReviewTargetKind;
  reviewFile: string;
};

const getReviewTargetKind = (
  planConfig: PlanFileConfig,
  targetPath: string,
  cwd: string,
): ReviewTargetKind | null => {
  if (isPlanFileMatchAny(planConfig.resolvedPlanPaths, targetPath)) {
    return "plan";
  }

  if (isSpecFileMatchAny(planConfig.resolvedSpecPaths, targetPath)) {
    return "spec";
  }

  const wildcardKind = defaultReviewTargetKindFromAbsolutePath(cwd, targetPath);
  if (wildcardKind) {
    return wildcardKind;
  }

  if (isExtraReviewTargetMatchAny(planConfig.extraReviewTargets, targetPath)) {
    return "plan";
  }

  return null;
};

export const resolveReviewTargetMatch = (
  ctx: { cwd: string },
  planConfig: PlanFileConfig,
  targetPath: string,
): ReviewTargetMatch | null => {
  const kind = getReviewTargetKind(planConfig, targetPath, ctx.cwd);
  if (!kind) {
    return null;
  }

  return {
    kind,
    reviewFile: toRepoRelativePath(ctx, targetPath),
  };
};

export const resolvePlanPath = (cwd: string, planFile: string): string =>
  path.resolve(cwd, planFile);

export const resolvePlanPaths = (cwd: string, planFiles: string[]): string[] =>
  planFiles.map((planFile) => resolvePlanPath(cwd, planFile));

export const getPlanFileConfig = (ctx: {
  cwd: string;
}): PlanFileConfig | null => {
  const config = loadConfig(ctx.cwd);
  if (config.planFile === null) {
    return null;
  }

  const planFiles = config.planFile
    ? [config.planFile]
    : getDefaultPlanDirs(ctx.cwd);
  const specFiles = config.planFile
    ? planFiles.map((planFile) =>
        path.join(path.dirname(planFile), REVIEW_TARGET_SPECS_DIR),
      )
    : getDefaultSpecDirs(ctx.cwd);
  const planFile = planFiles[0];
  const resolvedPlanPath = resolvePlanPath(ctx.cwd, planFile);
  const resolvedPlanPaths = resolvePlanPaths(ctx.cwd, planFiles);
  const resolvedSpecPaths = resolvePlanPaths(ctx.cwd, specFiles);
  const extraReviewTargets = resolveExtraReviewTargets(
    ctx.cwd,
    config.extraReviewTargets,
  );

  return {
    planFile,
    resolvedPlanPath,
    resolvedPlanPaths,
    resolvedSpecPaths,
    extraReviewTargets,
  };
};

export const resolvePlanFileForReview = (
  ctx: { cwd: string },
  planConfig: PlanFileConfig,
  targetPath: string,
): string | null =>
  resolveReviewTargetMatch(ctx, planConfig, targetPath)?.reviewFile ?? null;

export const shouldQueueReviewForToolPath = (
  planConfig: PlanFileConfig | null,
  targetPath: string,
): boolean => {
  if (!planConfig) {
    return true;
  }

  return !getReviewTargetKind(
    planConfig,
    targetPath,
    getCwdFromPlanConfig(planConfig),
  );
};

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
