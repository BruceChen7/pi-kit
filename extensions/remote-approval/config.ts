import { getRepoRoot } from "../shared/git.ts";
import { loadSettings } from "../shared/settings.ts";

export type RemoteApprovalConfig = {
  enabled: boolean;
  channelType: "telegram";
  botToken: string | null;
  chatId: string | null;
  strictRemote: boolean;
  interceptTools: string[];
  extraInterceptTools: string[];
  idleEnabled: boolean;
  continueEnabled: boolean;
  contextTurns: number;
  contextMaxChars: number;
  approvalTimeoutMs: number;
  requestTtlSeconds: number;
};

type RemoteApprovalSettings = Partial<RemoteApprovalConfig> & {
  channelType?: unknown;
  botToken?: unknown;
  chatId?: unknown;
  interceptTools?: unknown;
  extraInterceptTools?: unknown;
};

export const DEFAULT_CONFIG: RemoteApprovalConfig = {
  enabled: true,
  channelType: "telegram",
  botToken: null,
  chatId: null,
  strictRemote: true,
  interceptTools: [],
  extraInterceptTools: [],
  idleEnabled: true,
  continueEnabled: true,
  contextTurns: 3,
  contextMaxChars: 200,
  approvalTimeoutMs: 0,
  requestTtlSeconds: 600,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const normalizeBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

const normalizeStringOrNull = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizePositiveInteger = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.floor(value);
};

const normalizeStringList = (value: unknown, fallback: string[]): string[] => {
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized.length > 0 ? normalized : [...fallback];
};

export const normalizeRemoteApprovalConfig = (
  value: unknown,
): RemoteApprovalConfig => {
  const settings = isRecord(value) ? (value as RemoteApprovalSettings) : {};

  return {
    enabled: normalizeBoolean(settings.enabled, DEFAULT_CONFIG.enabled),
    channelType: "telegram",
    botToken: normalizeStringOrNull(settings.botToken),
    chatId: normalizeStringOrNull(settings.chatId),
    strictRemote: normalizeBoolean(
      settings.strictRemote,
      DEFAULT_CONFIG.strictRemote,
    ),
    interceptTools: normalizeStringList(
      settings.interceptTools,
      DEFAULT_CONFIG.interceptTools,
    ),
    extraInterceptTools: normalizeStringList(settings.extraInterceptTools, []),
    idleEnabled: normalizeBoolean(
      settings.idleEnabled,
      DEFAULT_CONFIG.idleEnabled,
    ),
    continueEnabled: normalizeBoolean(
      settings.continueEnabled,
      DEFAULT_CONFIG.continueEnabled,
    ),
    contextTurns: normalizePositiveInteger(
      settings.contextTurns,
      DEFAULT_CONFIG.contextTurns,
    ),
    contextMaxChars: normalizePositiveInteger(
      settings.contextMaxChars,
      DEFAULT_CONFIG.contextMaxChars,
    ),
    approvalTimeoutMs: normalizePositiveInteger(
      settings.approvalTimeoutMs,
      DEFAULT_CONFIG.approvalTimeoutMs,
    ),
    requestTtlSeconds: normalizePositiveInteger(
      settings.requestTtlSeconds,
      DEFAULT_CONFIG.requestTtlSeconds,
    ),
  };
};

export const getRemoteApprovalSettings = (
  settings: Record<string, unknown>,
): Record<string, unknown> => {
  const remoteApproval = settings.remoteApproval;
  return isRecord(remoteApproval) ? remoteApproval : {};
};

export const mergeRemoteApprovalSettings = (
  globalSettings: Record<string, unknown>,
  projectSettings: Record<string, unknown>,
): RemoteApprovalConfig => {
  const globalRecord = isRecord(globalSettings) ? globalSettings : {};
  const projectRecord = isRecord(projectSettings) ? projectSettings : {};

  const merged = {
    ...globalRecord,
    ...projectRecord,
    botToken: globalRecord.botToken,
    chatId: globalRecord.chatId,
    channelType: globalRecord.channelType,
  };

  return normalizeRemoteApprovalConfig(merged);
};

export const loadRemoteApprovalConfig = (cwd: string): RemoteApprovalConfig => {
  const repoRoot = getRepoRoot(cwd) ?? cwd;
  const { global, project } = loadSettings(repoRoot);
  const globalSettings = getRemoteApprovalSettings(global);
  const projectSettings = getRemoteApprovalSettings(project);
  return mergeRemoteApprovalSettings(globalSettings, projectSettings);
};
