import fs from "node:fs";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
  checkRepoDirty,
  DEFAULT_GIT_TIMEOUT_MS,
  getGitCommonDir,
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
  PlanReviewSessionState,
  SessionKeyContext,
} from "./plan-review/types.ts";
import {
  createRequestPlannotator,
  createReviewResultStore,
  formatAnnotationMessage,
  formatCodeReviewMessage,
  type ReviewResultEvent,
  requestAnnotation,
  requestCodeReview,
  requestReviewStatus,
} from "./plannotator-api.ts";

type PlannotatorAutoConfig = {
  planFile?: string | null;
  codeReviewAutoTrigger?: boolean;
};

type PlannotatorAutoSettings = {
  planFile?: unknown;
  codeReviewAutoTrigger?: unknown;
};

type ActiveCodeReview = {
  requestKey: string;
  reviewId?: string;
  startedAt: number;
};

type SessionRuntimeState = PlanReviewSessionState & {
  toolArgsByCallId: Map<string, unknown>;
  pendingReviewByCwd: Set<string>;
  activeCodeReviewByCwd: Map<string, ActiveCodeReview>;
  processedCodeReviewIds: Set<string>;
  pendingReviewRetry: ReturnType<typeof setTimeout> | null;
  reviewInFlight: boolean;
};

const DEFAULT_PLAN_SUBDIR = "plan";
const DEFAULT_CODE_REVIEW_PROBE_TIMEOUT_MS = 1_500;
const DEFAULT_CODE_REVIEW_TIMEOUT_MS = 30_000;
const SYNC_CODE_REVIEW_TIMEOUT_MS = 4 * 60 * 60 * 1_000;
const PLAN_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}-.+\.md$/;
const REVIEW_WIDGET_KEY = "plannotator-auto-review";
const ANNOTATE_LATEST_PLAN_SHORTCUT = "ctrl+alt+l";
const sessionRuntimeState = new Map<string, SessionRuntimeState>();
const sessionContextByKey = new Map<string, ExtensionContext>();

const getReviewWidgetMessage = (
  state: SessionRuntimeState,
  cwd: string,
): string | null => {
  const planReviewActive =
    state.planReviewInFlight ||
    state.pendingPlanReviewByCwd.has(cwd) ||
    state.activePlanReviewByCwd.has(cwd);
  const codeReviewActive =
    state.reviewInFlight || state.activeCodeReviewByCwd.has(cwd);

  if (planReviewActive && codeReviewActive) {
    return "Plan/Code review is active";
  }

  if (planReviewActive) {
    return "Plan review is active";
  }

  if (codeReviewActive) {
    return "Code review is active";
  }

  return null;
};

const setReviewWidget = (ctx: ExtensionContext): void => {
  if (!ctx.hasUI) {
    return;
  }

  const ui = ctx.ui as {
    setWidget?: (
      key: string,
      content?: unknown,
      options?: {
        placement?: "belowEditor";
      },
    ) => void;
    theme?: {
      fg?: (tone: string, text: string) => string;
    };
  };

  if (typeof ui.setWidget !== "function") {
    return;
  }

  const state = getSessionState(ctx);
  const message = getReviewWidgetMessage(state, ctx.cwd);
  if (!message) {
    ui.setWidget(REVIEW_WIDGET_KEY, undefined);
    return;
  }

  const line =
    typeof ui.theme?.fg === "function"
      ? ui.theme.fg("warning", message)
      : message;
  ui.setWidget(REVIEW_WIDGET_KEY, [line], { placement: "belowEditor" });
};

const clearReviewWidget = (ctx: ExtensionContext): void => {
  if (!ctx.hasUI) {
    return;
  }

  const ui = ctx.ui as {
    setWidget?: (key: string, content?: unknown) => void;
  };
  if (typeof ui.setWidget !== "function") {
    return;
  }

  ui.setWidget(REVIEW_WIDGET_KEY, undefined);
};

const setReviewWidgetBySessionKey = (sessionKey: string): void => {
  const ctx = sessionContextByKey.get(sessionKey);
  if (!ctx) {
    return;
  }

  setReviewWidget(ctx);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const sanitizeConfig = (value: unknown): PlannotatorAutoConfig => {
  if (!isRecord(value)) {
    return {};
  }

  const raw = value as PlannotatorAutoSettings;
  const next: PlannotatorAutoConfig = {};

  if (raw.planFile === null) {
    next.planFile = null;
  } else if (typeof raw.planFile === "string") {
    const trimmed = raw.planFile.trim();
    if (trimmed.length > 0) {
      next.planFile = trimmed;
    }
  }

  if (typeof raw.codeReviewAutoTrigger === "boolean") {
    next.codeReviewAutoTrigger = raw.codeReviewAutoTrigger;
  }

  return next;
};

let log: ReturnType<typeof createLogger> | null = null;

const createSessionRuntimeState = (): SessionRuntimeState => ({
  toolArgsByCallId: new Map<string, unknown>(),
  pendingPlanReviewByCwd: new Map(),
  activePlanReviewByCwd: new Map(),
  processedPlanReviewIds: new Set(),
  settledPlanReviewPaths: new Set(),
  pendingPlanReviewRetry: null,
  planReviewRetryAttemptsByCwd: new Map(),
  planReviewInFlight: false,
  plannotatorUnavailableNotified: false,
  pendingReviewByCwd: new Set<string>(),
  activeCodeReviewByCwd: new Map<string, ActiveCodeReview>(),
  processedCodeReviewIds: new Set<string>(),
  pendingReviewRetry: null,
  reviewInFlight: false,
});

export const getSessionKey = (ctx: {
  cwd: string;
  sessionManager: { getSessionFile: () => string | null | undefined };
}): string => ctx.sessionManager.getSessionFile() ?? `${ctx.cwd}::ephemeral`;

const getSessionState = (ctx: SessionKeyContext): SessionRuntimeState => {
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
    codeReviewAutoTrigger: config.codeReviewAutoTrigger ?? false,
  });
  return config;
};

const isCodeReviewAutoTriggerEnabled = (
  ctx: Pick<ExtensionContext, "cwd">,
): boolean => loadConfig(ctx.cwd).codeReviewAutoTrigger ?? false;

const resolveRepoSlugFromGitCommonDir = (cwd: string): string | null => {
  const commonDir = getGitCommonDir(cwd, DEFAULT_GIT_TIMEOUT_MS);
  if (!commonDir) {
    return null;
  }

  const candidate = path.basename(path.dirname(commonDir)).trim();
  return candidate.length > 0 ? candidate : null;
};

const getDefaultPlanDirs = (cwd: string): string[] => {
  const candidates = [
    resolveRepoSlugFromGitCommonDir(cwd),
    path.basename(cwd).trim(),
  ].filter((candidate): candidate is string => Boolean(candidate));

  return Array.from(
    new Set(
      candidates.map((candidate) =>
        path.join(".pi", "plans", candidate, DEFAULT_PLAN_SUBDIR),
      ),
    ),
  );
};

const isConfiguredPlanDirectory = (
  planFile: string,
  resolvedPlanPath: string,
): boolean => {
  if (path.extname(planFile).toLowerCase() === ".md") {
    return false;
  }

  try {
    const stats = fs.statSync(resolvedPlanPath);
    return stats.isDirectory();
  } catch {
    return true;
  }
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

const isPlanFileMatchAny = (planDirs: string[], targetPath: string): boolean =>
  planDirs.some((planDir) => isPlanFileMatch(planDir, targetPath));

const resolvePlanPath = (cwd: string, planFile: string): string =>
  path.resolve(cwd, planFile);

const resolvePlanPaths = (cwd: string, planFiles: string[]): string[] =>
  planFiles.map((planFile) => resolvePlanPath(cwd, planFile));

const getPlanFileConfig = (ctx: ExtensionContext): PlanFileConfig | null => {
  const config = loadConfig(ctx.cwd);
  if (config.planFile === null) {
    return null;
  }

  const planFiles = config.planFile
    ? [config.planFile]
    : getDefaultPlanDirs(ctx.cwd);
  const planFile = planFiles[0];
  const resolvedPlanPath = resolvePlanPath(ctx.cwd, planFile);
  const resolvedPlanPaths = resolvePlanPaths(ctx.cwd, planFiles);

  if (!isConfiguredPlanDirectory(planFile, resolvedPlanPath)) {
    log?.debug(
      "plannotator-auto ignored legacy single-file plan configuration",
      {
        planFile,
        resolvedPlanPath,
        sessionKey: getSessionKey(ctx),
      },
    );
    return null;
  }

  log?.debug("plannotator-auto resolved plan directory", {
    planFile,
    resolvedPlanPath,
    resolvedPlanPaths,
  });

  return {
    planFile,
    resolvedPlanPath,
    resolvedPlanPaths,
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
  if (!isPlanFileMatchAny(planConfig.resolvedPlanPaths, targetPath)) {
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

  return !isPlanFileMatchAny(planConfig.resolvedPlanPaths, targetPath);
};

export const findLatestPlanFileForAnnotation = (
  ctx: Pick<ExtensionContext, "cwd">,
  planConfig: PlanFileConfig,
): {
  absolutePath: string;
  repoRelativePath: string;
} | null => {
  let latestPath: string | null = null;
  let latestMtimeMs = Number.NEGATIVE_INFINITY;

  for (const planDir of planConfig.resolvedPlanPaths) {
    let entries: string[];
    try {
      entries = fs.readdirSync(planDir).sort();
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!PLAN_FILE_PATTERN.test(entry)) {
        continue;
      }

      const candidatePath = path.join(planDir, entry);
      let stats: fs.Stats;
      try {
        stats = fs.statSync(candidatePath);
      } catch {
        continue;
      }

      if (!stats.isFile()) {
        continue;
      }

      if (stats.mtimeMs >= latestMtimeMs) {
        latestPath = candidatePath;
        latestMtimeMs = stats.mtimeMs;
      }
    }
  }

  if (!latestPath) {
    return null;
  }

  return {
    absolutePath: latestPath,
    repoRelativePath: toRepoRelativePath(ctx, latestPath),
  };
};

const annotateLatestPlanFile = async (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> => {
  if (!ctx.hasUI) {
    ctx.ui.notify("Latest plan annotation requires UI mode.", "warning");
    return;
  }

  const planConfig = getPlanFileConfig(ctx);
  if (!planConfig) {
    ctx.ui.notify(
      "Plan annotation is disabled because plannotatorAuto.planFile is not set to a plan directory.",
      "warning",
    );
    return;
  }

  const latestPlan = findLatestPlanFileForAnnotation(ctx, planConfig);
  if (!latestPlan) {
    ctx.ui.notify(
      `No plan files found in ${planConfig.resolvedPlanPaths
        .map((planDir) => toRepoRelativePath(ctx, planDir))
        .join(", ")}.`,
      "warning",
    );
    return;
  }

  const requestPlannotator = createRequestPlannotator(pi.events);

  log?.info("plannotator-auto annotating latest plan file", {
    cwd: ctx.cwd,
    planFile: latestPlan.repoRelativePath,
    sessionKey: getSessionKey(ctx),
    shortcut: ANNOTATE_LATEST_PLAN_SHORTCUT,
  });

  try {
    const response = await requestAnnotation(requestPlannotator, {
      filePath: latestPlan.absolutePath,
      mode: "annotate",
    });

    if (response.status === "handled") {
      const message = formatAnnotationMessage({
        filePath: latestPlan.repoRelativePath,
        feedback: response.result.feedback,
      });

      if (message) {
        pi.sendUserMessage(message, { deliverAs: "followUp" });
      } else {
        ctx.ui.notify("Plan annotation closed (no feedback).", "info");
      }
      return;
    }

    if (response.status === "unavailable") {
      ctx.ui.notify(
        response.error ??
          "Plannotator is not loaded. Install/enable the Plannotator extension to annotate plans.",
        "warning",
      );
      return;
    }

    ctx.ui.notify(
      response.error || "Plannotator annotation request failed.",
      "warning",
    );
  } catch (error) {
    ctx.ui.notify(
      error instanceof Error
        ? error.message
        : "Plannotator annotation request failed.",
      "warning",
    );
  }
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

const getCodeReviewCompletionKey = (active: ActiveCodeReview): string =>
  active.reviewId ?? active.requestKey;

const createCodeReviewRequestKey = (): string =>
  `sync:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

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
  reviewResults: ReturnType<typeof createReviewResultStore>,
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
    void maybeStartCodeReview(
      pi,
      reviewResults,
      planReviewCoordinator,
      ctx,
      reason,
    );
  }, delay);
};

const handleCodeReviewCompletion = (
  pi: ExtensionAPI,
  ctx: Pick<ExtensionContext, "cwd"> & {
    ui?: Pick<ExtensionContext["ui"], "notify">;
  },
  state: SessionRuntimeState,
  active: ActiveCodeReview,
  result: {
    approved: boolean;
    feedback?: string;
    annotations?: unknown[];
  },
  source: "event" | "status" | "direct",
  onStateChanged?: () => void,
): void => {
  const completionKey = getCodeReviewCompletionKey(active);
  if (state.processedCodeReviewIds.has(completionKey)) {
    return;
  }

  const superseded = state.pendingReviewByCwd.has(ctx.cwd);

  state.processedCodeReviewIds.add(completionKey);
  state.activeCodeReviewByCwd.delete(ctx.cwd);
  state.plannotatorUnavailableNotified = false;
  onStateChanged?.();

  if (superseded) {
    log?.info("plannotator-auto suppressed stale code-review completion", {
      cwd: ctx.cwd,
      source,
      reviewId: active.reviewId ?? null,
      requestKey: active.requestKey,
      approved: result.approved,
    });
    return;
  }

  const message = formatCodeReviewMessage(result);
  if (message) {
    pi.sendUserMessage(message, { deliverAs: "followUp" });
    return;
  }

  ctx.ui?.notify("Code review closed (no feedback).", "info");
};

const clearActiveCodeReview = (
  ctx: Pick<ExtensionContext, "cwd">,
  state: SessionRuntimeState,
  onStateChanged?: () => void,
): void => {
  if (state.activeCodeReviewByCwd.delete(ctx.cwd)) {
    onStateChanged?.();
  }
};

const findActiveCodeReviewSession = (
  reviewId: string,
): {
  sessionKey: string;
  cwd: string;
  state: SessionRuntimeState;
} | null => {
  for (const [sessionKey, state] of sessionRuntimeState.entries()) {
    for (const [cwd, active] of state.activeCodeReviewByCwd.entries()) {
      if (active.reviewId === reviewId) {
        return {
          sessionKey,
          cwd,
          state: sessionRuntimeState.get(sessionKey) ?? state,
        };
      }
    }
  }

  return null;
};

const probeCodeReviewAvailability = async (
  requestPlannotator: ReturnType<typeof createRequestPlannotator>,
): Promise<Awaited<ReturnType<typeof requestReviewStatus>>> =>
  requestReviewStatus(requestPlannotator, {
    reviewId: `probe:${Date.now()}`,
  });

const maybeStartCodeReview = async (
  pi: ExtensionAPI,
  reviewResults: ReturnType<typeof createReviewResultStore>,
  planReviewCoordinator: PlanReviewCoordinator,
  ctx: ExtensionContext,
  reason: string,
): Promise<void> => {
  const state = getSessionState(ctx);
  const hasPending = state.pendingReviewByCwd.has(ctx.cwd);
  const active = state.activeCodeReviewByCwd.get(ctx.cwd);
  const codeReviewAutoTriggerEnabled = isCodeReviewAutoTriggerEnabled(ctx);

  if (!codeReviewAutoTriggerEnabled && !active) {
    if (hasPending) {
      log?.debug(
        "plannotator-auto skipped review (code-review auto trigger disabled)",
        {
          cwd: ctx.cwd,
          reason,
          sessionKey: getSessionKey(ctx),
        },
      );
      clearReviewPending(ctx);
    }
    return;
  }

  if ((!hasPending && !active) || state.reviewInFlight) {
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
    scheduleReviewRetry(
      pi,
      reviewResults,
      planReviewCoordinator,
      ctx,
      "busy-review",
    );
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
      reviewResults,
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

  const requestPlannotator = createRequestPlannotator(pi.events, {
    timeoutMs: DEFAULT_CODE_REVIEW_TIMEOUT_MS,
  });
  state.reviewInFlight = true;
  setReviewWidget(ctx);

  try {
    if (active) {
      const statusResponse = await requestReviewStatus(requestPlannotator, {
        reviewId: active.reviewId,
      });

      if (statusResponse.status === "handled") {
        const status = statusResponse.result;
        if (status.status === "pending") {
          scheduleReviewRetry(
            pi,
            reviewResults,
            planReviewCoordinator,
            ctx,
            "pending-code-review-status",
            1_200,
          );
          return;
        }

        if (status.status === "completed") {
          handleCodeReviewCompletion(
            pi,
            ctx,
            state,
            active,
            {
              approved: status.approved,
              feedback: status.feedback,
              annotations: status.annotations,
            },
            "status",
            () => setReviewWidget(ctx),
          );
        } else {
          clearActiveCodeReview(ctx, state, () => setReviewWidget(ctx));
        }
      } else if (statusResponse.status === "unavailable") {
        notifyCodeReviewUnavailable(
          ctx,
          state,
          statusResponse.error ??
            "Plannotator is not loaded. Install/enable the Plannotator extension to use shared review flows.",
        );
        scheduleReviewRetry(
          pi,
          reviewResults,
          planReviewCoordinator,
          ctx,
          "code-review-status-unavailable",
          1_200,
        );
        return;
      } else {
        ctx.ui.notify(
          statusResponse.error || "Plannotator review-status request failed.",
          "warning",
        );
        scheduleReviewRetry(
          pi,
          reviewResults,
          planReviewCoordinator,
          ctx,
          "code-review-status-error",
          1_200,
        );
        return;
      }
    }

    if (!state.pendingReviewByCwd.has(ctx.cwd)) {
      return;
    }

    const probeRequest = createRequestPlannotator(pi.events, {
      timeoutMs: DEFAULT_CODE_REVIEW_PROBE_TIMEOUT_MS,
    });
    const probeResponse = await probeCodeReviewAvailability(probeRequest);
    if (probeResponse.status === "unavailable") {
      notifyCodeReviewUnavailable(
        ctx,
        state,
        probeResponse.error ??
          "Plannotator is not loaded. Install/enable the Plannotator extension to use shared review flows.",
      );
      return;
    }

    if (probeResponse.status === "error") {
      ctx.ui.notify(
        probeResponse.error ||
          "Plannotator review-status probe failed before code review.",
        "warning",
      );
      return;
    }

    log?.info("plannotator-auto starting code review via event API", {
      cwd: ctx.cwd,
      repoRoot,
      reason,
      sessionKey: getSessionKey(ctx),
    });

    const syncActive: ActiveCodeReview = {
      requestKey: createCodeReviewRequestKey(),
      startedAt: Date.now(),
    };
    state.activeCodeReviewByCwd.set(ctx.cwd, syncActive);
    setReviewWidget(ctx);

    const syncRequestPlannotator = createRequestPlannotator(pi.events, {
      timeoutMs: SYNC_CODE_REVIEW_TIMEOUT_MS,
    });
    const response = await requestCodeReview(syncRequestPlannotator, {
      cwd: ctx.cwd,
    });
    const currentState = sessionRuntimeState.get(getSessionKey(ctx));
    if (!currentState) {
      return;
    }

    const currentActive = currentState.activeCodeReviewByCwd.get(ctx.cwd);
    if (!currentActive || currentActive.requestKey !== syncActive.requestKey) {
      return;
    }

    if (response.status === "handled") {
      currentState.plannotatorUnavailableNotified = false;
      clearReviewPending(ctx);

      if ("status" in response.result && response.result.status === "pending") {
        reviewResults.markPending(response.result.reviewId);
        currentState.activeCodeReviewByCwd.set(ctx.cwd, {
          requestKey: syncActive.requestKey,
          reviewId: response.result.reviewId,
          startedAt: Date.now(),
        });
        setReviewWidget(ctx);
        scheduleReviewRetry(
          pi,
          reviewResults,
          planReviewCoordinator,
          ctx,
          "await-code-review-result",
          1_200,
        );
        return;
      }

      handleCodeReviewCompletion(
        pi,
        ctx,
        currentState,
        syncActive,
        response.result,
        "direct",
        () => setReviewWidget(ctx),
      );
      if (currentState.pendingReviewByCwd.has(ctx.cwd)) {
        scheduleReviewRetry(
          pi,
          reviewResults,
          planReviewCoordinator,
          ctx,
          "review-after-sync-code-review",
        );
      }
      return;
    }

    clearActiveCodeReview(ctx, currentState, () => setReviewWidget(ctx));

    if (response.status === "unavailable") {
      notifyCodeReviewUnavailable(
        ctx,
        currentState,
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
    setReviewWidget(ctx);
  }
};

const handlePlanFileWrite = async (
  planReviewCoordinator: PlanReviewCoordinator,
  ctx: ExtensionContext,
  args: unknown,
  planConfig: PlanFileConfig | null,
): Promise<void> => {
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

  const state = getSessionState(ctx);
  const targetPath = path.resolve(ctx.cwd, toolPath);
  if (state.settledPlanReviewPaths.has(targetPath)) {
    log?.info("plannotator-auto skipped plan review for settled plan", {
      cwd: ctx.cwd,
      toolPath,
      targetPath,
      sessionKey: getSessionKey(ctx),
    });
    return;
  }

  const planFile = resolvePlanFileForReview(ctx, planConfig, targetPath);
  if (!planFile) {
    log?.debug("plannotator-auto tool write/edit did not match plan file", {
      cwd: ctx.cwd,
      toolPath,
      targetPath,
      configuredPlanPath: planConfig.resolvedPlanPath,
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

  await planReviewCoordinator.queuePendingPlanReview(ctx, {
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
    onStateChanged: (sessionKey) => {
      setReviewWidgetBySessionKey(sessionKey);
    },
    log,
  });

  pi.registerShortcut(ANNOTATE_LATEST_PLAN_SHORTCUT, {
    description: "Annotate latest plan file (Ctrl+Alt+L)",
    handler: async (ctx) => {
      await annotateLatestPlanFile(pi, ctx);
    },
  });

  reviewResults.onResult((result: ReviewResultEvent) => {
    const matched = findActiveCodeReviewSession(result.reviewId);
    if (!matched) {
      return;
    }

    const active = matched.state.activeCodeReviewByCwd.get(matched.cwd);
    if (!active) {
      return;
    }

    handleCodeReviewCompletion(
      pi,
      { cwd: matched.cwd },
      matched.state,
      active,
      {
        approved: result.approved,
        feedback: result.feedback,
        annotations: result.annotations,
      },
      "event",
      () => setReviewWidgetBySessionKey(matched.sessionKey),
    );
  });

  pi.on("session_start", (_event, ctx) => {
    const sessionKey = getSessionKey(ctx);
    sessionContextByKey.set(sessionKey, ctx);
    getSessionState(ctx);
    setReviewWidget(ctx);

    log?.debug("plannotator-auto session started", {
      cwd: ctx.cwd,
      sessionKey,
    });
  });

  pi.on("session_shutdown", (_event, ctx) => {
    const sessionKey = getSessionKey(ctx);
    log?.debug("plannotator-auto session shutdown", {
      cwd: ctx.cwd,
      sessionKey,
    });

    clearReviewWidget(ctx);
    sessionContextByKey.delete(sessionKey);
    clearSessionState(sessionKey);
  });

  pi.on("tool_execution_start", (event, ctx) => {
    sessionContextByKey.set(getSessionKey(ctx), ctx);

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

  pi.on("tool_execution_end", async (event, ctx) => {
    sessionContextByKey.set(getSessionKey(ctx), ctx);

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
        configuredPlanPath: planConfig?.resolvedPlanPath ?? null,
        sessionKey: getSessionKey(ctx),
      });

      if (shouldQueueCodeReview) {
        if (isCodeReviewAutoTriggerEnabled(ctx)) {
          markReviewPending(ctx);
        } else {
          log?.debug(
            "plannotator-auto skipped review queue (code-review auto trigger disabled)",
            {
              cwd: ctx.cwd,
              toolName: event.toolName,
              toolPath,
              targetPath,
              sessionKey: getSessionKey(ctx),
            },
          );
        }
      }
    } else {
      log?.debug("plannotator-auto tool args missing path for review queue", {
        cwd: ctx.cwd,
        toolName: event.toolName,
        ...summarizeToolArgs(args),
        sessionKey: getSessionKey(ctx),
      });
    }

    await handlePlanFileWrite(planReviewCoordinator, ctx, args, planConfig);
    setReviewWidget(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    sessionContextByKey.set(getSessionKey(ctx), ctx);

    log?.debug("plannotator-auto handling agent_end", {
      cwd: ctx.cwd,
      sessionKey: getSessionKey(ctx),
    });
    await planReviewCoordinator.runPlanReview(ctx, "agent_end");
    await maybeStartCodeReview(
      pi,
      reviewResults,
      planReviewCoordinator,
      ctx,
      "agent_end",
    );
    setReviewWidget(ctx);
  });
}
