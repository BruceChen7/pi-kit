import fs from "node:fs";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
  checkRepoDirty,
  DEFAULT_GIT_TIMEOUT_MS,
  getRepoRoot,
} from "../shared/git.ts";
import { createLogger } from "../shared/logger.ts";
import { loadSettings } from "../shared/settings.ts";
import {
  createPlanReviewCoordinator,
  type PlanReviewCoordinator,
} from "./plan-review/coordinator.ts";
import type {
  PlanFileConfig,
  PlanFileMode,
  PlanReviewSessionState,
} from "./plan-review/types.ts";
import {
  createRequestPlannotator,
  createReviewResultStore,
  formatCodeReviewMessage,
  requestCodeReview,
} from "./plannotator-api.ts";

type PlannotatorAutoConfig = {
  planFile?: string | null;
};

type PlannotatorAutoSettings = {
  planFile?: unknown;
};

type SessionRuntimeState = PlanReviewSessionState & {
  toolArgsByCallId: Map<string, unknown>;
  pendingReviewByCwd: Set<string>;
  pendingReviewRetry: ReturnType<typeof setTimeout> | null;
  reviewInFlight: boolean;
};

const DEFAULT_PLAN_SUBDIR = "plan";
const PLAN_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}-.+\.md$/;
const sessionRuntimeState = new Map<string, SessionRuntimeState>();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const sanitizeConfig = (value: unknown): PlannotatorAutoConfig => {
  if (!isRecord(value)) {
    return {};
  }

  const raw = value as PlannotatorAutoSettings;
  if (raw.planFile === null) {
    return { planFile: null };
  }

  if (typeof raw.planFile !== "string") {
    return {};
  }

  const trimmed = raw.planFile.trim();
  return trimmed.length > 0 ? { planFile: trimmed } : {};
};

let log: ReturnType<typeof createLogger> | null = null;

const createSessionRuntimeState = (): SessionRuntimeState => ({
  toolArgsByCallId: new Map<string, unknown>(),
  pendingPlanReviewByCwd: new Map(),
  activePlanReviewByCwd: new Map(),
  processedPlanReviewIds: new Set(),
  pendingPlanReviewRetry: null,
  planReviewRetryAttemptsByCwd: new Map(),
  planReviewInFlight: false,
  plannotatorUnavailableNotified: false,
  pendingReviewByCwd: new Set<string>(),
  pendingReviewRetry: null,
  reviewInFlight: false,
});

export const getSessionKey = (ctx: {
  cwd: string;
  sessionManager: { getSessionFile: () => string | null | undefined };
}): string => ctx.sessionManager.getSessionFile() ?? `${ctx.cwd}::ephemeral`;

const getSessionState = (ctx: ExtensionContext): SessionRuntimeState => {
  const key = getSessionKey(ctx);
  const cached = sessionRuntimeState.get(key);
  if (cached) {
    return cached;
  }

  const next = createSessionRuntimeState();
  sessionRuntimeState.set(key, next);
  return next;
};

const clearSessionState = (sessionKey: string): void => {
  const state = sessionRuntimeState.get(sessionKey);
  if (!state) {
    return;
  }

  if (state.pendingPlanReviewRetry) {
    clearTimeout(state.pendingPlanReviewRetry);
  }

  if (state.pendingReviewRetry) {
    clearTimeout(state.pendingReviewRetry);
  }

  sessionRuntimeState.delete(sessionKey);
};

const loadConfig = (
  cwd: string,
  options?: {
    forceReload?: boolean;
  },
): PlannotatorAutoConfig => {
  const { merged } = loadSettings(cwd, options);
  const config = sanitizeConfig(merged.plannotatorAuto);
  log?.debug("plannotator-auto config loaded", {
    cwd,
    planFile: config.planFile,
  });
  return config;
};

const getDefaultPlanDir = (cwd: string): string => {
  const repoSlug = path.basename(cwd);
  return path.join(".pi", "plans", repoSlug, DEFAULT_PLAN_SUBDIR);
};

const statPath = (value: string): fs.Stats | null => {
  try {
    return fs.statSync(value);
  } catch {
    return null;
  }
};

const detectPlanMode = (
  planFile: string,
  resolvedPlanPath: string,
): PlanFileMode => {
  const stats = statPath(resolvedPlanPath);
  if (stats?.isDirectory()) {
    return "directory";
  }

  if (stats?.isFile()) {
    return "file";
  }

  return path.extname(planFile).toLowerCase() === ".md" ? "file" : "directory";
};

const toRepoRelativePath = (
  ctx: Pick<ExtensionContext, "cwd">,
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

const isPlanFileMatch = (planDir: string, targetPath: string): boolean => {
  if (path.dirname(targetPath) !== planDir) {
    return false;
  }

  return PLAN_FILE_PATTERN.test(path.basename(targetPath));
};

const resolvePlanPath = (cwd: string, planFile: string): string =>
  path.resolve(cwd, planFile);

const getPlanFileConfig = (ctx: ExtensionContext): PlanFileConfig | null => {
  const config = loadConfig(ctx.cwd);
  if (config.planFile === null) {
    return null;
  }

  const planFile = config.planFile ?? getDefaultPlanDir(ctx.cwd);
  const resolvedPlanPath = resolvePlanPath(ctx.cwd, planFile);
  const mode = detectPlanMode(planFile, resolvedPlanPath);

  log?.debug("plannotator-auto resolved plan path", {
    planFile,
    resolvedPlanPath,
    mode,
  });

  return {
    planFile,
    resolvedPlanPath,
    mode,
  };
};

const resolveToolPath = (args: unknown): string | null => {
  if (!isRecord(args)) {
    return null;
  }

  const value = args.path;
  return typeof value === "string" ? value : null;
};

const summarizeToolArgs = (
  args: unknown,
): {
  argsType: string;
  argKeys: string[] | null;
} => {
  if (isRecord(args)) {
    return {
      argsType: "object",
      argKeys: Object.keys(args),
    };
  }

  if (Array.isArray(args)) {
    return {
      argsType: "array",
      argKeys: null,
    };
  }

  return {
    argsType: typeof args,
    argKeys: null,
  };
};

export const resolvePlanFileForReview = (
  ctx: Pick<ExtensionContext, "cwd">,
  planConfig: PlanFileConfig,
  targetPath: string,
): string | null => {
  if (planConfig.mode === "file") {
    return targetPath === planConfig.resolvedPlanPath
      ? planConfig.planFile
      : null;
  }

  if (!isPlanFileMatch(planConfig.resolvedPlanPath, targetPath)) {
    return null;
  }

  return toRepoRelativePath(ctx, targetPath);
};

export const shouldQueueReviewForToolPath = (
  planConfig: PlanFileConfig | null,
  targetPath: string,
): boolean => {
  if (!planConfig) {
    return true;
  }

  if (planConfig.mode === "file") {
    return targetPath !== planConfig.resolvedPlanPath;
  }

  return !isPlanFileMatch(planConfig.resolvedPlanPath, targetPath);
};

const markReviewPending = (ctx: ExtensionContext): void => {
  const state = getSessionState(ctx);
  state.pendingReviewByCwd.add(ctx.cwd);

  log?.debug("plannotator-auto queued code review candidate", {
    cwd: ctx.cwd,
    sessionKey: getSessionKey(ctx),
    pendingReviewCount: state.pendingReviewByCwd.size,
  });
};

const clearReviewPending = (ctx: ExtensionContext): void => {
  getSessionState(ctx).pendingReviewByCwd.delete(ctx.cwd);
};

const notifyCodeReviewUnavailable = (
  ctx: ExtensionContext,
  state: SessionRuntimeState,
  message: string,
): void => {
  if (state.plannotatorUnavailableNotified) {
    log?.debug(
      "plannotator-auto suppressed duplicate unavailable notification",
      {
        cwd: ctx.cwd,
        sessionKey: getSessionKey(ctx),
        message,
      },
    );
    return;
  }

  state.plannotatorUnavailableNotified = true;
  log?.warn("plannotator-auto notified plannotator unavailable", {
    cwd: ctx.cwd,
    sessionKey: getSessionKey(ctx),
    message,
  });
  ctx.ui.notify(message, "warning");
};

const scheduleReviewRetry = (
  pi: ExtensionAPI,
  planReviewCoordinator: PlanReviewCoordinator,
  ctx: ExtensionContext,
  reason: string,
  delay = 180,
): void => {
  const sessionKey = getSessionKey(ctx);
  const state = getSessionState(ctx);
  if (state.pendingReviewRetry) {
    return;
  }

  state.pendingReviewRetry = setTimeout(() => {
    const currentState = sessionRuntimeState.get(sessionKey);
    if (!currentState) {
      return;
    }

    currentState.pendingReviewRetry = null;
    void maybeStartCodeReview(pi, planReviewCoordinator, ctx, reason);
  }, delay);
};

const maybeStartCodeReview = async (
  pi: ExtensionAPI,
  planReviewCoordinator: PlanReviewCoordinator,
  ctx: ExtensionContext,
  reason: string,
): Promise<void> => {
  const state = getSessionState(ctx);
  if (!state.pendingReviewByCwd.has(ctx.cwd) || state.reviewInFlight) {
    return;
  }

  if (!ctx.hasUI) {
    log?.debug("plannotator-auto skipped review (no UI)", {
      cwd: ctx.cwd,
      reason,
      sessionKey: getSessionKey(ctx),
    });
    clearReviewPending(ctx);
    return;
  }

  if (!ctx.isIdle()) {
    scheduleReviewRetry(pi, planReviewCoordinator, ctx, "busy-review");
    return;
  }

  if (!planReviewCoordinator.isPlanReviewSettled(ctx)) {
    log?.debug(
      "plannotator-auto deferring code review until plan review settles",
      {
        cwd: ctx.cwd,
        reason,
        sessionKey: getSessionKey(ctx),
      },
    );
    scheduleReviewRetry(
      pi,
      planReviewCoordinator,
      ctx,
      "review-after-plan-review",
    );
    return;
  }

  const repoRoot = getRepoRoot(ctx.cwd, DEFAULT_GIT_TIMEOUT_MS);
  if (!repoRoot) {
    log?.debug("plannotator-auto skipped review (not a git repo)", {
      cwd: ctx.cwd,
      reason,
      sessionKey: getSessionKey(ctx),
    });
    clearReviewPending(ctx);
    return;
  }

  const dirty = checkRepoDirty(repoRoot, DEFAULT_GIT_TIMEOUT_MS);
  if (!dirty) {
    log?.warn("plannotator-auto failed to check git status", {
      cwd: ctx.cwd,
      repoRoot,
      reason,
      sessionKey: getSessionKey(ctx),
    });
    clearReviewPending(ctx);
    return;
  }

  if (!dirty.summary.dirty) {
    log?.debug("plannotator-auto skipped review (repo clean)", {
      cwd: ctx.cwd,
      repoRoot,
      summary: dirty.summary,
      reason,
      sessionKey: getSessionKey(ctx),
    });
    clearReviewPending(ctx);
    return;
  }

  const requestPlannotator = createRequestPlannotator(pi.events);
  state.reviewInFlight = true;
  clearReviewPending(ctx);

  log?.info("plannotator-auto starting code review via event API", {
    cwd: ctx.cwd,
    repoRoot,
    reason,
    sessionKey: getSessionKey(ctx),
  });

  try {
    const response = await requestCodeReview(requestPlannotator, {
      cwd: ctx.cwd,
    });

    if (response.status === "handled") {
      state.plannotatorUnavailableNotified = false;
      const message = formatCodeReviewMessage(response.result);
      if (message) {
        pi.sendUserMessage(message);
      } else {
        ctx.ui.notify("Code review closed (no feedback).", "info");
      }
      return;
    }

    if (response.status === "unavailable") {
      notifyCodeReviewUnavailable(
        ctx,
        state,
        response.error ??
          "Plannotator is not loaded. Install/enable the Plannotator extension to use shared review flows.",
      );
      return;
    }

    ctx.ui.notify(
      response.error || "Plannotator code review request failed.",
      "warning",
    );
  } catch (error) {
    ctx.ui.notify(
      error instanceof Error
        ? error.message
        : "Plannotator code review request failed.",
      "warning",
    );
  } finally {
    state.reviewInFlight = false;
  }
};

const handlePlanFileWrite = (
  planReviewCoordinator: PlanReviewCoordinator,
  ctx: ExtensionContext,
  args: unknown,
  planConfig: PlanFileConfig | null,
): void => {
  if (!planConfig) {
    log?.debug(
      "plannotator-auto skipped plan-file write handling (plan review disabled)",
      {
        cwd: ctx.cwd,
        sessionKey: getSessionKey(ctx),
      },
    );
    return;
  }

  const toolPath = resolveToolPath(args);
  if (!toolPath) {
    log?.debug(
      "plannotator-auto skipped plan-file write handling (missing path arg)",
      {
        cwd: ctx.cwd,
        ...summarizeToolArgs(args),
        sessionKey: getSessionKey(ctx),
      },
    );
    return;
  }

  const targetPath = path.resolve(ctx.cwd, toolPath);
  const planFile = resolvePlanFileForReview(ctx, planConfig, targetPath);
  if (!planFile) {
    log?.debug("plannotator-auto tool write/edit did not match plan file", {
      cwd: ctx.cwd,
      toolPath,
      targetPath,
      configuredPlanPath: planConfig.resolvedPlanPath,
      mode: planConfig.mode,
      sessionKey: getSessionKey(ctx),
    });
    return;
  }

  log?.info("plannotator-auto detected plan-file update", {
    cwd: ctx.cwd,
    toolPath,
    targetPath,
    planFile,
    sessionKey: getSessionKey(ctx),
  });

  planReviewCoordinator.queuePendingPlanReview(ctx, {
    planFile,
    resolvedPlanPath: targetPath,
    updatedAt: Date.now(),
  });
};

export default function plannotatorAuto(pi: ExtensionAPI) {
  log = createLogger("plannotator-auto", { stderr: null });
  const reviewResults = createReviewResultStore(pi.events);
  const planReviewCoordinator = createPlanReviewCoordinator({
    pi,
    reviewResults,
    getSessionState: (ctx) => getSessionState(ctx),
    getSessionStateByKey: (sessionKey) => sessionRuntimeState.get(sessionKey),
    getSessionKey,
    iterateSessionStates: () =>
      Array.from(sessionRuntimeState.entries()).map(([sessionKey, state]) => ({
        sessionKey,
        state,
      })),
    log,
  });

  pi.on("session_start", (_event, ctx) => {
    getSessionState(ctx);
    log?.debug("plannotator-auto session started", {
      cwd: ctx.cwd,
      sessionKey: getSessionKey(ctx),
    });
  });

  pi.on("session_shutdown", (_event, ctx) => {
    log?.debug("plannotator-auto session shutdown", {
      cwd: ctx.cwd,
      sessionKey: getSessionKey(ctx),
    });
    clearSessionState(getSessionKey(ctx));
  });

  pi.on("tool_execution_start", (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") {
      return;
    }

    log?.debug("plannotator-auto captured tool args", {
      cwd: ctx.cwd,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      sessionKey: getSessionKey(ctx),
    });

    getSessionState(ctx).toolArgsByCallId.set(event.toolCallId, event.args);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") {
      return;
    }

    const state = getSessionState(ctx);
    const args = state.toolArgsByCallId.get(event.toolCallId);
    state.toolArgsByCallId.delete(event.toolCallId);
    if (!args) {
      log?.debug(
        "plannotator-auto missing stored tool args on tool_execution_end",
        {
          cwd: ctx.cwd,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          sessionKey: getSessionKey(ctx),
        },
      );
      return;
    }

    if (event.isError) {
      log?.debug(
        "plannotator-auto skipping review queue after failed tool execution",
        {
          cwd: ctx.cwd,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          sessionKey: getSessionKey(ctx),
        },
      );
      return;
    }

    const toolPath = resolveToolPath(args);
    const planConfig = getPlanFileConfig(ctx);
    if (toolPath) {
      const targetPath = path.resolve(ctx.cwd, toolPath);
      const shouldQueueCodeReview = shouldQueueReviewForToolPath(
        planConfig,
        targetPath,
      );

      log?.debug("plannotator-auto evaluated tool path for review queue", {
        cwd: ctx.cwd,
        toolName: event.toolName,
        toolPath,
        targetPath,
        shouldQueueCodeReview,
        planMode: planConfig?.mode ?? null,
        configuredPlanPath: planConfig?.resolvedPlanPath ?? null,
        sessionKey: getSessionKey(ctx),
      });

      if (shouldQueueCodeReview) {
        markReviewPending(ctx);
      }
    } else {
      log?.debug("plannotator-auto tool args missing path for review queue", {
        cwd: ctx.cwd,
        toolName: event.toolName,
        ...summarizeToolArgs(args),
        sessionKey: getSessionKey(ctx),
      });
    }

    handlePlanFileWrite(planReviewCoordinator, ctx, args, planConfig);
  });

  pi.on("agent_end", async (_event, ctx) => {
    log?.debug("plannotator-auto handling agent_end", {
      cwd: ctx.cwd,
      sessionKey: getSessionKey(ctx),
    });
    await planReviewCoordinator.runPlanReview(ctx, "agent_end");
    await maybeStartCodeReview(pi, planReviewCoordinator, ctx, "agent_end");
  });
}
