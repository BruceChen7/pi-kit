import { DEFAULT_GIT_TIMEOUT_MS } from "../shared/git.js";
import { loadSettings } from "../shared/settings.js";

export type FeatureWorkflowGuards = {
  requireCleanWorkspace: boolean;
  requireFreshBase: boolean;
  enforceBranchNaming: boolean;
};

export type FeatureWorkflowDefaults = {
  gitTimeoutMs: number;
  autoSwitchToWorktreeSession: boolean;
};

export type IgnoredSyncMode = "quick" | "strict";
export type IgnoredSyncEnsureOnCommand = "feature-start" | "feature-switch";
export type IgnoredSyncRuleStrategy = "symlink" | "copy";
export type IgnoredSyncOnMissingAction = "run-hook" | "copy-ignored";
export type IgnoredSyncLockfileOnDrift = "warn" | "ignore";
export type IgnoredSyncFallbackOnFailure = "warn" | "block";

export type IgnoredSyncRuleOnMissing = {
  action: IgnoredSyncOnMissingAction;
  hook: string | null;
};

export type IgnoredSyncRule = {
  path: string;
  strategy: IgnoredSyncRuleStrategy;
  required: boolean;
  onMissing: IgnoredSyncRuleOnMissing;
};

export type IgnoredSyncLockfileConfig = {
  enabled: boolean;
  path: string;
  compareWithPrimary: boolean;
  onDrift: IgnoredSyncLockfileOnDrift;
};

export type IgnoredSyncFallbackConfig = {
  copyIgnoredTimeoutMs: number;
  onFailure: IgnoredSyncFallbackOnFailure;
};

export type IgnoredSyncNotificationsConfig = {
  enabled: boolean;
  verbose: boolean;
};

export type FeatureWorkflowIgnoredSyncConfig = {
  enabled: boolean;
  mode: IgnoredSyncMode;
  ensureOn: IgnoredSyncEnsureOnCommand[];
  rules: IgnoredSyncRule[];
  lockfile: IgnoredSyncLockfileConfig;
  fallback: IgnoredSyncFallbackConfig;
  notifications: IgnoredSyncNotificationsConfig;
};

export type FeatureWorkflowConfig = {
  enabled: boolean;
  guards: FeatureWorkflowGuards;
  defaults: FeatureWorkflowDefaults;
  ignoredSync: FeatureWorkflowIgnoredSyncConfig;
};

type FeatureWorkflowSettings = {
  enabled?: unknown;
  guards?: unknown;
  defaults?: unknown;
  ignoredSync?: unknown;
};

const IGNORED_SYNC_COMMANDS = [
  "feature-start",
  "feature-switch",
] as const satisfies readonly IgnoredSyncEnsureOnCommand[];

const IGNORED_SYNC_MODES = [
  "quick",
  "strict",
] as const satisfies readonly IgnoredSyncMode[];

const IGNORED_SYNC_RULE_STRATEGIES = [
  "symlink",
  "copy",
] as const satisfies readonly IgnoredSyncRuleStrategy[];

const IGNORED_SYNC_ON_MISSING_ACTIONS = [
  "run-hook",
  "copy-ignored",
] as const satisfies readonly IgnoredSyncOnMissingAction[];

const IGNORED_SYNC_LOCKFILE_ON_DRIFT_VALUES = [
  "warn",
  "ignore",
] as const satisfies readonly IgnoredSyncLockfileOnDrift[];

const IGNORED_SYNC_FALLBACK_ON_FAILURE_VALUES = [
  "warn",
  "block",
] as const satisfies readonly IgnoredSyncFallbackOnFailure[];

export const DEFAULT_IGNORED_SYNC_HOOK = "project-deps-link";

const LEGACY_IGNORED_SYNC_HOOK_ALIASES = new Set(["project:deps-link"]);

export const DEFAULT_IGNORED_SYNC_RULES: IgnoredSyncRule[] = [
  {
    path: "node_modules",
    strategy: "symlink",
    required: false,
    onMissing: {
      action: "run-hook",
      hook: DEFAULT_IGNORED_SYNC_HOOK,
    },
  },
  {
    path: ".pi",
    strategy: "symlink",
    required: false,
    onMissing: {
      action: "run-hook",
      hook: DEFAULT_IGNORED_SYNC_HOOK,
    },
  },
  {
    path: "AGENTS.md",
    strategy: "copy",
    required: false,
    onMissing: {
      action: "run-hook",
      hook: DEFAULT_IGNORED_SYNC_HOOK,
    },
  },
  {
    path: "CLAUDE.md",
    strategy: "copy",
    required: false,
    onMissing: {
      action: "run-hook",
      hook: DEFAULT_IGNORED_SYNC_HOOK,
    },
  },
];

export const DEFAULT_IGNORED_SYNC: FeatureWorkflowIgnoredSyncConfig = {
  enabled: true,
  mode: "quick",
  ensureOn: ["feature-start", "feature-switch"],
  rules: DEFAULT_IGNORED_SYNC_RULES,
  lockfile: {
    enabled: false,
    path: "package-lock.json",
    compareWithPrimary: true,
    onDrift: "warn",
  },
  fallback: {
    copyIgnoredTimeoutMs: 15000,
    onFailure: "warn",
  },
  notifications: {
    enabled: true,
    verbose: false,
  },
};

const DEFAULT_CONFIG: FeatureWorkflowConfig = {
  enabled: true,
  guards: {
    requireCleanWorkspace: true,
    requireFreshBase: true,
    enforceBranchNaming: true,
  },
  defaults: {
    gitTimeoutMs: DEFAULT_GIT_TIMEOUT_MS,
    autoSwitchToWorktreeSession: true,
  },
  ignoredSync: DEFAULT_IGNORED_SYNC,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const trimToNull = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

const normalizeNumber = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const normalizePositiveNumber = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return value;
};

const normalizeString = (value: unknown, fallback: string): string =>
  trimToNull(value) ?? fallback;

const normalizeIgnoredSyncHookName = (value: string): string => {
  return LEGACY_IGNORED_SYNC_HOOK_ALIASES.has(value)
    ? DEFAULT_IGNORED_SYNC_HOOK
    : value;
};

function normalizeEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim() as T;
  return allowed.includes(normalized) ? normalized : fallback;
}

const isIgnoredSyncEnsureOnCommand = (
  value: unknown,
): value is IgnoredSyncEnsureOnCommand =>
  typeof value === "string" &&
  (IGNORED_SYNC_COMMANDS as readonly string[]).includes(value);

const normalizeEnsureOn = (
  value: unknown,
  fallback: IgnoredSyncEnsureOnCommand[],
): IgnoredSyncEnsureOnCommand[] => {
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  const deduped: IgnoredSyncEnsureOnCommand[] = [];
  for (const item of value) {
    if (isIgnoredSyncEnsureOnCommand(item) && !deduped.includes(item)) {
      deduped.push(item);
    }
  }

  return deduped.length > 0 ? deduped : [...fallback];
};

const defaultOnMissingForStrategy = (
  strategy: IgnoredSyncRuleStrategy,
): IgnoredSyncRuleOnMissing => {
  if (strategy === "symlink") {
    return {
      action: "run-hook",
      hook: DEFAULT_IGNORED_SYNC_HOOK,
    };
  }

  return {
    action: "copy-ignored",
    hook: null,
  };
};
const normalizeRuleOnMissing = (
  value: unknown,
  strategy: IgnoredSyncRuleStrategy,
): IgnoredSyncRuleOnMissing => {
  const fallback = defaultOnMissingForStrategy(strategy);
  const source = isRecord(value) ? value : {};

  const action = normalizeEnum(
    source.action,
    IGNORED_SYNC_ON_MISSING_ACTIONS,
    fallback.action,
  );

  if (action === "run-hook") {
    return {
      action,
      hook: normalizeIgnoredSyncHookName(
        normalizeString(
          source.hook,
          fallback.hook ?? DEFAULT_IGNORED_SYNC_HOOK,
        ),
      ),
    };
  }

  return {
    action,
    hook: null,
  };
};

const normalizeIgnoredSyncRules = (value: unknown): IgnoredSyncRule[] => {
  if (!Array.isArray(value)) {
    return [...DEFAULT_IGNORED_SYNC.rules];
  }

  const rules: IgnoredSyncRule[] = [];

  for (const item of value) {
    if (!isRecord(item)) continue;

    const rulePath = trimToNull(item.path);
    if (!rulePath) continue;

    const strategy = normalizeEnum(
      item.strategy,
      IGNORED_SYNC_RULE_STRATEGIES,
      "copy",
    );

    rules.push({
      path: rulePath,
      strategy,
      required: normalizeBoolean(item.required, false),
      onMissing: normalizeRuleOnMissing(item.onMissing, strategy),
    });
  }

  return rules;
};

export function loadFeatureWorkflowConfig(cwd: string): FeatureWorkflowConfig {
  const { merged } = loadSettings(cwd);
  const settings = isRecord(merged.featureWorkflow)
    ? (merged.featureWorkflow as FeatureWorkflowSettings)
    : ({} as FeatureWorkflowSettings);

  const guards = isRecord(settings.guards)
    ? (settings.guards as Record<string, unknown>)
    : {};
  const defaults = isRecord(settings.defaults)
    ? (settings.defaults as Record<string, unknown>)
    : {};
  const ignoredSync = isRecord(settings.ignoredSync)
    ? (settings.ignoredSync as Record<string, unknown>)
    : {};

  const lockfile = isRecord(ignoredSync.lockfile)
    ? (ignoredSync.lockfile as Record<string, unknown>)
    : {};
  const fallback = isRecord(ignoredSync.fallback)
    ? (ignoredSync.fallback as Record<string, unknown>)
    : {};
  const notifications = isRecord(ignoredSync.notifications)
    ? (ignoredSync.notifications as Record<string, unknown>)
    : {};

  return {
    enabled: normalizeBoolean(settings.enabled, DEFAULT_CONFIG.enabled),
    guards: {
      requireCleanWorkspace: normalizeBoolean(
        guards.requireCleanWorkspace,
        DEFAULT_CONFIG.guards.requireCleanWorkspace,
      ),
      requireFreshBase: normalizeBoolean(
        guards.requireFreshBase,
        DEFAULT_CONFIG.guards.requireFreshBase,
      ),
      enforceBranchNaming: normalizeBoolean(
        guards.enforceBranchNaming,
        DEFAULT_CONFIG.guards.enforceBranchNaming,
      ),
    },
    defaults: {
      gitTimeoutMs: normalizeNumber(
        defaults.gitTimeoutMs,
        DEFAULT_CONFIG.defaults.gitTimeoutMs,
      ),
      autoSwitchToWorktreeSession: normalizeBoolean(
        defaults.autoSwitchToWorktreeSession,
        DEFAULT_CONFIG.defaults.autoSwitchToWorktreeSession,
      ),
    },
    ignoredSync: {
      enabled: normalizeBoolean(
        ignoredSync.enabled,
        DEFAULT_CONFIG.ignoredSync.enabled,
      ),
      mode: normalizeEnum(
        ignoredSync.mode,
        IGNORED_SYNC_MODES,
        DEFAULT_CONFIG.ignoredSync.mode,
      ),
      ensureOn: normalizeEnsureOn(
        ignoredSync.ensureOn,
        DEFAULT_CONFIG.ignoredSync.ensureOn,
      ),
      rules: normalizeIgnoredSyncRules(ignoredSync.rules),
      lockfile: {
        enabled: normalizeBoolean(
          lockfile.enabled,
          DEFAULT_CONFIG.ignoredSync.lockfile.enabled,
        ),
        path: normalizeString(
          lockfile.path,
          DEFAULT_CONFIG.ignoredSync.lockfile.path,
        ),
        compareWithPrimary: normalizeBoolean(
          lockfile.compareWithPrimary,
          DEFAULT_CONFIG.ignoredSync.lockfile.compareWithPrimary,
        ),
        onDrift: normalizeEnum(
          lockfile.onDrift,
          IGNORED_SYNC_LOCKFILE_ON_DRIFT_VALUES,
          DEFAULT_CONFIG.ignoredSync.lockfile.onDrift,
        ),
      },
      fallback: {
        copyIgnoredTimeoutMs: normalizePositiveNumber(
          fallback.copyIgnoredTimeoutMs,
          DEFAULT_CONFIG.ignoredSync.fallback.copyIgnoredTimeoutMs,
        ),
        onFailure: normalizeEnum(
          fallback.onFailure,
          IGNORED_SYNC_FALLBACK_ON_FAILURE_VALUES,
          DEFAULT_CONFIG.ignoredSync.fallback.onFailure,
        ),
      },
      notifications: {
        enabled: normalizeBoolean(
          notifications.enabled,
          DEFAULT_CONFIG.ignoredSync.notifications.enabled,
        ),
        verbose: normalizeBoolean(
          notifications.verbose,
          DEFAULT_CONFIG.ignoredSync.notifications.verbose,
        ),
      },
    },
  };
}
