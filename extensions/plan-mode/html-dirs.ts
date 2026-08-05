import path from "node:path";
import { DEFAULT_GIT_TIMEOUT_MS, getGitCommonDir } from "../shared/git.ts";
import { loadSettings } from "../shared/settings.ts";

/**
 * Resolve the HTML artifact review directories for the session cwd.
 *
 * Source of truth is the `plannotatorAuto.htmlDirs` setting (same config the
 * plannotator-auto extension watches); when it is unset or empty the default
 * `.pi/html/<repo>/` is used (repo slug from the git common dir, falling back
 * to the cwd basename — equivalent to plannotator-auto's getDefaultHtmlDirs).
 *
 * Used both for the buildModePrompt guidance line and for the plan-phase
 * write guard, so the agent is told exactly the directories it may write to.
 */

const resolveRepoSlugFromGitCommonDir = (cwd: string): string | null => {
  const commonDir = getGitCommonDir(cwd, DEFAULT_GIT_TIMEOUT_MS);
  if (!commonDir) {
    return null;
  }
  const candidate = path.basename(path.dirname(commonDir)).trim();
  return candidate.length > 0 ? candidate : null;
};

const getDefaultHtmlDirs = (cwd: string): string[] =>
  Array.from(
    new Set(
      [resolveRepoSlugFromGitCommonDir(cwd), path.basename(cwd).trim()]
        .filter((candidate): candidate is string => Boolean(candidate))
        .map((candidate) => path.join(".pi", "html", candidate)),
    ),
  );

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const getConfiguredHtmlDirs = (cwd: string): string[] => {
  const { merged } = loadSettings(cwd);
  const config = merged.plannotatorAuto;
  if (!isRecord(config)) {
    return [];
  }
  const htmlDirs = config.htmlDirs;
  if (!Array.isArray(htmlDirs)) {
    return [];
  }
  return htmlDirs.flatMap((entry) => {
    if (typeof entry !== "string") {
      return [];
    }
    const trimmed = entry.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  });
};

/**
 * Absolute HTML artifact review directories for `cwd`.
 * Returns [] when htmlDirs is configured as null/[] (HTML review disabled).
 */
export const resolveHtmlArtifactDirs = (cwd: string): string[] => {
  const configured = getConfiguredHtmlDirs(cwd);
  const dirs = configured.length > 0 ? configured : getDefaultHtmlDirs(cwd);
  return Array.from(new Set(dirs.map((dir) => path.resolve(cwd, dir))));
};

/** True when `absolutePath` is a reviewable HTML artifact under htmlDirs. */
export const isHtmlArtifactPath = (
  cwd: string,
  absolutePath: string,
): boolean => {
  const dirs = resolveHtmlArtifactDirs(cwd);
  const fileName = path.basename(absolutePath);
  if (!/^\d{4}-\d{2}-\d{2}-.+\.html$/.test(fileName)) {
    return false;
  }
  return dirs.some((dir) => path.dirname(absolutePath) === dir);
};
