import path from "node:path";
import {
  HTML_REVIEW_FILE_PATTERN,
  resolveHtmlReviewDirs,
} from "../shared/review-targets.ts";
import { loadSettings } from "../shared/settings.ts";

/**
 * Resolve the HTML artifact review directories for the session cwd.
 *
 * Source of truth is the `plannotatorAuto.htmlDirs` setting, resolved by the
 * shared `resolveHtmlReviewDirs` (the same single source plannotator-auto
 * uses for its review queue): `null`/`[]` disables HTML review, unset falls
 * back to the default `.pi/html/<repo>/` (repo slug from the git common
 * dir, falling back to the cwd basename).
 *
 * Used both for the buildModePrompt guidance line and for the plan-phase
 * write guard, so the agent is told exactly the directories it may write to.
 *
 * Callers that run on the tool-call hot path (the write guard) should cache
 * the result per session (the controller resolves it in restore()) instead
 * of re-running the settings load / git spawn on every tool call.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const getConfiguredHtmlDirs = (cwd: string): unknown => {
  const { merged } = loadSettings(cwd);
  const config = merged.plannotatorAuto;
  if (!isRecord(config)) {
    return undefined;
  }
  return config.htmlDirs;
};

/**
 * Absolute HTML artifact review directories for `cwd`.
 * Returns [] when htmlDirs is configured as null/[] (HTML review disabled).
 */
export const resolveHtmlArtifactDirs = (cwd: string): string[] =>
  resolveHtmlReviewDirs(cwd, getConfiguredHtmlDirs(cwd));

/** True when `absolutePath` is a reviewable HTML artifact under `dirs`. */
export const isHtmlArtifactPathIn = (
  dirs: readonly string[],
  absolutePath: string,
): boolean => {
  const fileName = path.basename(absolutePath);
  if (!HTML_REVIEW_FILE_PATTERN.test(fileName)) {
    return false;
  }
  return dirs.some((dir) => path.dirname(absolutePath) === dir);
};
