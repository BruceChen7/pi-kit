import { createLogger } from "../shared/logger.ts";
import { loadSettings } from "../shared/settings.ts";

export type ExtraReviewTargetConfig = {
  dir: string;
  filePattern: string;
};

export type PlannotatorAutoConfig = {
  planFile?: string | null;
  extraReviewTargets?: ExtraReviewTargetConfig[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const sanitizeExtraReviewTargets = (
  value: unknown,
): ExtraReviewTargetConfig[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const next = value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }

    const dir = typeof entry.dir === "string" ? entry.dir.trim() : "";
    const filePattern =
      typeof entry.filePattern === "string" ? entry.filePattern.trim() : "";
    if (dir.length === 0 || filePattern.length === 0) {
      return [];
    }

    return [{ dir, filePattern }];
  });

  return next.length > 0 ? next : undefined;
};

const sanitizeConfig = (value: unknown): PlannotatorAutoConfig => {
  if (!isRecord(value)) {
    return {};
  }

  const next: PlannotatorAutoConfig = {};

  if (value.planFile === null) {
    next.planFile = null;
  } else if (typeof value.planFile === "string") {
    const trimmed = value.planFile.trim();
    if (trimmed.length > 0) {
      next.planFile = trimmed;
    }
  }

  const extraReviewTargets = sanitizeExtraReviewTargets(
    value.extraReviewTargets,
  );
  if (extraReviewTargets) {
    next.extraReviewTargets = extraReviewTargets;
  }

  return next;
};

let log: ReturnType<typeof createLogger> | null = null;

const getLogger = (): ReturnType<typeof createLogger> => {
  if (!log) {
    log = createLogger("plannotator-auto", { stderr: null });
  }
  return log;
};

export const loadConfig = (
  cwd: string,
  options?: {
    forceReload?: boolean;
  },
): PlannotatorAutoConfig => {
  const { merged } = loadSettings(cwd, options);
  const config = sanitizeConfig(merged.plannotatorAuto);
  getLogger().debug("plannotator-auto config loaded", {
    cwd,
    planFile: config.planFile,
    extraReviewTargetCount: config.extraReviewTargets?.length ?? 0,
  });
  return config;
};
