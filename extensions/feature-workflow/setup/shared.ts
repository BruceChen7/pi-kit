import os from "node:os";
import path from "node:path";

import type { Result } from "../../shared/result.js";
import type {
  FeatureWorkflowIgnoredSyncConfig,
  IgnoredSyncEnsureOnCommand,
  IgnoredSyncRule,
} from "../config.js";
import { isRecord, trimToNull } from "../utils.js";

export type FeatureWorkflowSetupTarget =
  | "settings"
  | "gitignore"
  | "worktreeinclude"
  | "hook-script"
  | "wt-toml"
  | "wt-user-config";

export type FeatureWorkflowSetupProfile = {
  id: string;
  title: string;
  description: string;
  ignoredSyncPreset: FeatureWorkflowIgnoredSyncConfig;
  worktreeIncludeEntries: string[];
  hook: {
    hookType: "pre-start";
    name: string;
    scriptRelativePath: string;
    symlinkPaths: string[];
  };
};

export type FeatureWorkflowSetupCliOptions = {
  profileId: string | null;
  onlyTargets: FeatureWorkflowSetupTarget[] | null;
  skipTargets: FeatureWorkflowSetupTarget[];
  yes: boolean;
};

export type FeatureWorkflowSetupApplyInput = {
  cwd: string;
  repoRoot: string;
  profile: FeatureWorkflowSetupProfile;
  targets: Iterable<FeatureWorkflowSetupTarget>;
  userHomePath?: string;
};

export type FeatureWorkflowSetupFileChange = {
  target: FeatureWorkflowSetupTarget;
  path: string;
  changed: boolean;
  message: string;
};

export type FeatureWorkflowSetupApplyResult = {
  profileId: string;
  targets: FeatureWorkflowSetupTarget[];
  changes: FeatureWorkflowSetupFileChange[];
  changedCount: number;
};

export type FeatureWorkflowSetupParseResult =
  Result<FeatureWorkflowSetupCliOptions>;

export const FEATURE_WORKFLOW_WT_TOML_PATH = ".config/wt.toml";
export const FEATURE_WORKFLOW_RECOMMENDED_WORKTREE_PATH_TEMPLATE =
  "{{ repo_path }}/../{{ repo }}.{{ branch | sanitize }}";
export const DEFAULT_FEATURE_WORKFLOW_SETUP_PROFILE_ID = "npm";
export const DEFAULT_FEATURE_WORKFLOW_COPY_IGNORED_HOOK =
  "project-copy-ignored";
export const HOME_HOOK_SCRIPT_PATH = "$HOME/.pi/pi-feature-workflow-links.sh";
export const WORKTRUNK_USER_CONFIG_RELATIVE_PATH =
  ".config/worktrunk/config.toml";

export const SETUP_TARGETS: FeatureWorkflowSetupTarget[] = [
  "settings",
  "gitignore",
  "worktreeinclude",
  "hook-script",
  "wt-toml",
  "wt-user-config",
];

const HOME_SCRIPT_PATH_PREFIX = "$HOME/";
const WORKTREE_INCLUDE_EXCLUDED_ENTRIES = new Set<string>([".pi"]);

export { isRecord, trimToNull };

export function toRelativeDisplayPath(
  repoRoot: string,
  absolutePath: string,
): string {
  const relative = path.relative(repoRoot, absolutePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return absolutePath;
  }
  return relative;
}

export function uniqueStrings(values: Iterable<string>): string[] {
  const deduped: string[] = [];
  for (const value of values) {
    const trimmed = trimToNull(value);
    if (!trimmed || deduped.includes(trimmed)) {
      continue;
    }
    deduped.push(trimmed);
  }
  return deduped;
}

function normalizeWorktreeIncludeEntry(value: string): string {
  return value.trim().replace(/^\.\//, "").replace(/\/+$/, "");
}

export function isExcludedWorktreeIncludeEntry(value: string): boolean {
  return WORKTREE_INCLUDE_EXCLUDED_ENTRIES.has(
    normalizeWorktreeIncludeEntry(value),
  );
}

export function resolveUserHomePath(inputHomePath?: string): string {
  const explicit = trimToNull(inputHomePath);
  if (explicit) {
    return path.resolve(explicit);
  }

  const fromEnv = trimToNull(process.env.HOME);
  if (fromEnv) {
    return path.resolve(fromEnv);
  }

  return path.resolve(os.homedir());
}

export function resolveHookScriptAbsolutePath(
  scriptPath: string,
  repoRoot: string,
  userHomePath: string,
): string {
  if (scriptPath.startsWith(HOME_SCRIPT_PATH_PREFIX)) {
    return path.join(
      userHomePath,
      scriptPath.slice(HOME_SCRIPT_PATH_PREFIX.length),
    );
  }

  if (path.isAbsolute(scriptPath)) {
    return scriptPath;
  }

  return path.join(repoRoot, scriptPath);
}

export function escapeTomlBasicString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function cloneRule(rule: IgnoredSyncRule): IgnoredSyncRule {
  return {
    ...rule,
    onMissing: {
      ...rule.onMissing,
    },
  };
}

export function cloneIgnoredSyncPreset(
  value: FeatureWorkflowIgnoredSyncConfig,
): FeatureWorkflowIgnoredSyncConfig {
  return {
    enabled: value.enabled,
    mode: value.mode,
    ensureOn: [...value.ensureOn],
    rules: value.rules.map(cloneRule),
    lockfile: {
      ...value.lockfile,
    },
    fallback: {
      ...value.fallback,
    },
    notifications: {
      ...value.notifications,
    },
  };
}

export function mergeEnsureOn(
  existingValue: unknown,
  presetValue: IgnoredSyncEnsureOnCommand[],
): IgnoredSyncEnsureOnCommand[] {
  const deduped: IgnoredSyncEnsureOnCommand[] = [];

  if (Array.isArray(existingValue)) {
    for (const item of existingValue) {
      if (
        (item === "feature-start" || item === "feature-switch") &&
        !deduped.includes(item)
      ) {
        deduped.push(item);
      }
    }
  }

  for (const item of presetValue) {
    if (!deduped.includes(item)) {
      deduped.push(item);
    }
  }

  return deduped.length > 0 ? deduped : [...presetValue];
}
