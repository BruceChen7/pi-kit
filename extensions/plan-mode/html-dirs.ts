import path from "node:path";
import {
  HTML_REVIEW_FILE_PATTERN,
  resolveHtmlReviewDirs,
} from "../shared/review-targets.ts";

/**
 * Resolve the HTML artifact review directories for the session cwd.
 *
 * Convention-based and NOT configurable: always `.pi/html/<repo>/` (repo
 * slug from the git common dir, falling back to the cwd basename), resolved
 * by the shared `resolveHtmlReviewDirs` — the same single source
 * plannotator-auto uses for its review queue, so the two can never disagree.
 *
 * Used both for the buildModePrompt guidance line and for the plan-phase
 * write guard, so the agent is told exactly the directories it may write to.
 *
 * Callers that run on the tool-call hot path (the write guard) should cache
 * the result per session (the controller resolves it in restore()) instead
 * of re-running the git spawn on every tool call.
 */

/**
 * Absolute HTML artifact review directories for `cwd`.
 */
export const resolveHtmlArtifactDirs = (cwd: string): string[] =>
  resolveHtmlReviewDirs(cwd);

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
