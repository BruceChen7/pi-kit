import { createLogger } from "../shared/logger.ts";
import { loadSettings } from "../shared/settings.ts";

export type PlannotatorAutoConfig = {
  planFile?: string | null;
  htmlDirs?: string[] | null;
  callflowContext?: {
    enabled: boolean;
    from?: string;
  } | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const sanitizeHtmlDirs = (value: unknown): string[] | null | undefined => {
  if (value === null) {
    return null;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }

  const next = value.flatMap((entry) => {
    if (typeof entry !== "string") {
      return [];
    }
    const trimmed = entry.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  });

  return next;
};

const sanitizeCallflowContext = (
  value: unknown,
): PlannotatorAutoConfig["callflowContext"] => {
  if (value === null) {
    return null;
  }
  if (typeof value === "boolean") {
    return { enabled: value };
  }
  if (isRecord(value)) {
    return {
      enabled: value.enabled === true,
      ...(typeof value.from === "string" && value.from.trim().length > 0
        ? { from: value.from.trim() }
        : {}),
    };
  }
  return undefined;
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

  const htmlDirs = sanitizeHtmlDirs(value.htmlDirs);
  if (htmlDirs !== undefined) {
    next.htmlDirs = htmlDirs;
  }

  const callflowContext = sanitizeCallflowContext(value.callflowContext);
  if (callflowContext !== undefined) {
    next.callflowContext = callflowContext;
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
    htmlDirs: config.htmlDirs,
    callflowContext: config.callflowContext?.enabled ?? false,
  });
  return config;
};
