import { DEFAULT_GIT_TIMEOUT_MS } from "../shared/git.js";
import { loadSettings } from "../shared/settings.js";

export type FeatureWorkflowGuards = {
  requireCleanWorkspace: boolean;
  requireFreshBase: boolean;
  enforceBranchNaming: boolean;
};

export type FeatureWorkflowDefaults = {
  gitTimeoutMs: number;
};

export type FeatureWorkflowConfig = {
  enabled: boolean;
  guards: FeatureWorkflowGuards;
  defaults: FeatureWorkflowDefaults;
};

type FeatureWorkflowSettings = {
  enabled?: unknown;
  guards?: unknown;
  defaults?: unknown;
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
  },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const normalizeBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

const normalizeNumber = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

export function loadFeatureWorkflowConfig(cwd: string): FeatureWorkflowConfig {
  const { merged } = loadSettings(cwd);
  const settings = isRecord(merged.featureWorkflow)
    ? (merged.featureWorkflow as FeatureWorkflowSettings)
    : ({} as FeatureWorkflowSettings);

  const guards = isRecord(settings.guards) ? settings.guards : {};
  const defaults = isRecord(settings.defaults) ? settings.defaults : {};

  return {
    enabled: normalizeBoolean(settings.enabled, DEFAULT_CONFIG.enabled),
    guards: {
      requireCleanWorkspace: normalizeBoolean(
        (guards as Record<string, unknown>).requireCleanWorkspace,
        DEFAULT_CONFIG.guards.requireCleanWorkspace,
      ),
      requireFreshBase: normalizeBoolean(
        (guards as Record<string, unknown>).requireFreshBase,
        DEFAULT_CONFIG.guards.requireFreshBase,
      ),
      enforceBranchNaming: normalizeBoolean(
        (guards as Record<string, unknown>).enforceBranchNaming,
        DEFAULT_CONFIG.guards.enforceBranchNaming,
      ),
    },
    defaults: {
      gitTimeoutMs: normalizeNumber(
        (defaults as Record<string, unknown>).gitTimeoutMs,
        DEFAULT_CONFIG.defaults.gitTimeoutMs,
      ),
    },
  };
}
