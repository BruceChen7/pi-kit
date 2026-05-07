import fs from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  createRequestPlannotator,
  type createReviewResultStore,
  type ReviewResultEvent,
  requestReviewStatus,
  startPlanReview,
  waitForReviewResult,
} from "../plannotator-api.ts";
import {
  getPlanReviewRetryDelay,
  shouldDeferPlanReviewWhenBusy,
} from "./policy.ts";
import {
  dropStalePendingPlanReview,
  getPlanReviewStateSnapshot,
  markPlanReviewPending,
} from "./state-store.ts";
import type {
  ActivePlanReview,
  PendingPlanReview,
  PlanReviewCoordinatorReason,
  PlanReviewRuntimeContext,
  PlanReviewSessionState,
  ReviewTargetKind,
  SessionKeyContext,
} from "./types.ts";

type Logger = {
  debug: (message: string, data?: unknown) => void;
  info: (message: string, data?: unknown) => void;
  warn: (message: string, data?: unknown) => void;
  error: (message: string, data?: unknown) => void;
};

type SessionStateEntry = {
  sessionKey: string;
  state: PlanReviewSessionState;
};

type PlanReviewCoordinatorDeps = {
  pi: ExtensionAPI;
  reviewResults: ReturnType<typeof createReviewResultStore>;
  getSessionState: (ctx: PlanReviewRuntimeContext) => PlanReviewSessionState;
  getSessionStateByKey: (
    sessionKey: string,
  ) => PlanReviewSessionState | undefined;
  getSessionContextByKey: (
    sessionKey: string,
  ) => PlanReviewRuntimeContext | undefined;
  getSessionKey: (ctx: SessionKeyContext) => string;
  iterateSessionStates: () => Iterable<SessionStateEntry>;
  onStateChanged?: (
    sessionKey: string,
    cwd: string,
    state: PlanReviewSessionState,
  ) => void;
  log: Logger | null;
};

const readPlanContent = (planPath: string): string | null => {
  try {
    return fs.readFileSync(planPath, "utf-8");
  } catch {
    return null;
  }
};

type RetryReason = Exclude<
  PlanReviewCoordinatorReason,
  "plan-file-write" | "agent_end"
>;

const getReviewDraftReadyMessage = (kind: ReviewTargetKind): string =>
  `Plannotator ${kind} review draft is ready. Submit it manually in Plannotator to continue.`;

export type PlanReviewCoordinator = {
  queuePendingPlanReview: (
    ctx: PlanReviewRuntimeContext,
    planReview: PendingPlanReview,
  ) => Promise<void>;
  runPlanReview: (
    ctx: PlanReviewRuntimeContext,
    reason: PlanReviewCoordinatorReason,
  ) => Promise<void>;
  isPlanReviewSettled: (ctx: PlanReviewRuntimeContext) => boolean;
};

export const createPlanReviewCoordinator = (
  deps: PlanReviewCoordinatorDeps,
): PlanReviewCoordinator => {
  const {
    pi,
    reviewResults,
    getSessionState,
    getSessionStateByKey,
    getSessionContextByKey,
    getSessionKey,
    iterateSessionStates,
    onStateChanged,
    log,
  } = deps;

  const emitStateChanged = (
    sessionKey: string,
    cwd: string,
    state: PlanReviewSessionState,
  ): void => {
    onStateChanged?.(sessionKey, cwd, state);
  };

  const dropStalePending = (
    state: PlanReviewSessionState,
    cwd: string,
    startedAt: number,
  ): void => {
    const dropped = dropStalePendingPlanReview(state, cwd, startedAt);
    if (!dropped) {
      return;
    }

    log?.debug("plannotator-auto dropped stale pending plan review", {
      cwd,
      pendingPlanFile: dropped.planFile,
      pendingUpdatedAt: dropped.updatedAt,
      startedAt,
    });
  };

  const resetRetryAttempts = (
    state: PlanReviewSessionState,
    cwd: string,
  ): void => {
    state.planReviewRetryAttemptsByCwd.delete(cwd);
  };

  const hasSupersedingPendingPlanReview = (
    state: PlanReviewSessionState,
    cwd: string,
    startedAt: number,
  ): boolean => {
    const pending = state.pendingPlanReviewByCwd.get(cwd);
    return Boolean(pending && pending.updatedAt > startedAt);
  };

  const isPlanReviewSettled = (ctx: PlanReviewRuntimeContext): boolean => {
    const state = getSessionState(ctx);
    return (
      !state.planReviewInFlight &&
      !state.pendingPlanReviewByCwd.has(ctx.cwd) &&
      !state.activePlanReviewByCwd.has(ctx.cwd)
    );
  };

  const notifyPlannotatorUnavailable = (
    ctx: PlanReviewRuntimeContext,
    state: PlanReviewSessionState,
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

  const handlePlanReviewCompletion = (
    sessionKey: string,
    ctx: Pick<PlanReviewRuntimeContext, "cwd">,
    state: PlanReviewSessionState,
    active: ActivePlanReview,
    result: {
      approved: boolean;
      feedback?: string;
    },
    source: "event" | "status",
    runtimeCtx?: Pick<PlanReviewRuntimeContext, "abort" | "isIdle" | "ui">,
  ): void => {
    if (state.processedPlanReviewIds.has(active.reviewId)) {
      log?.debug("plannotator-auto ignored duplicate plan-review completion", {
        cwd: ctx.cwd,
        source,
        reviewId: active.reviewId,
      });
      return;
    }

    const superseded = hasSupersedingPendingPlanReview(
      state,
      ctx.cwd,
      active.startedAt,
    );

    state.processedPlanReviewIds.add(active.reviewId);
    state.activePlanReviewByCwd.delete(ctx.cwd);
    dropStalePending(state, ctx.cwd, active.startedAt);
    state.plannotatorUnavailableNotified = false;
    resetRetryAttempts(state, ctx.cwd);
    emitStateChanged(sessionKey, ctx.cwd, state);

    if (superseded) {
      log?.info("plannotator-auto suppressed stale plan-review completion", {
        cwd: ctx.cwd,
        source,
        reviewId: active.reviewId,
        kind: active.kind,
        approved: result.approved,
      });
      return;
    }

    if (result.approved) {
      state.settledPlanReviewPaths.add(active.resolvedPlanPath);
    }

    const shouldInterruptAgent = active.origin !== "manual-submit";
    const shouldAbort = Boolean(
      runtimeCtx && shouldInterruptAgent && !runtimeCtx.isIdle(),
    );
    if (shouldInterruptAgent) {
      runtimeCtx?.ui.notify(getReviewDraftReadyMessage(active.kind), "info");
    }
    if (shouldAbort) {
      runtimeCtx.abort();
    }

    log?.info("plannotator-auto completed plan review", {
      cwd: ctx.cwd,
      source,
      reviewId: active.reviewId,
      kind: active.kind,
      approved: result.approved,
      hasFeedback: Boolean(result.feedback?.trim()),
      aborted: shouldAbort,
    });
  };

  const schedulePlanReviewRetry = (
    ctx: PlanReviewRuntimeContext,
    reason: RetryReason,
  ): void => {
    const sessionKey = getSessionKey(ctx);
    const state = getSessionState(ctx);
    if (state.pendingPlanReviewRetry) {
      log?.debug(
        "plannotator-auto skipped scheduling duplicate plan-review retry",
        {
          cwd: ctx.cwd,
          reason,
          sessionKey,
          state: getPlanReviewStateSnapshot(state, ctx.cwd),
        },
      );
      return;
    }

    const attempt = (state.planReviewRetryAttemptsByCwd.get(ctx.cwd) ?? 0) + 1;
    const retry = getPlanReviewRetryDelay(reason, attempt);
    if (retry.exhausted) {
      log?.warn("plannotator-auto exhausted plan-review retries", {
        cwd: ctx.cwd,
        reason,
        attempt,
        sessionKey,
        state: getPlanReviewStateSnapshot(state, ctx.cwd),
      });
      ctx.ui.notify(
        "Plannotator Auto stopped retrying plan review. Please run a manual review check.",
        "warning",
      );
      resetRetryAttempts(state, ctx.cwd);
      return;
    }

    state.planReviewRetryAttemptsByCwd.set(ctx.cwd, attempt);

    log?.debug("plannotator-auto scheduled plan-review retry", {
      cwd: ctx.cwd,
      reason,
      attempt,
      delay: retry.delayMs,
      sessionKey,
      state: getPlanReviewStateSnapshot(state, ctx.cwd),
    });

    state.pendingPlanReviewRetry = setTimeout(() => {
      const currentState = getSessionStateByKey(sessionKey);
      if (!currentState) {
        return;
      }

      currentState.pendingPlanReviewRetry = null;
      log?.debug("plannotator-auto executing plan-review retry", {
        cwd: ctx.cwd,
        reason,
        attempt,
        delay: retry.delayMs,
        sessionKey,
        state: getPlanReviewStateSnapshot(currentState, ctx.cwd),
      });

      const currentCtx = getSessionContextByKey(sessionKey);
      if (!currentCtx) {
        return;
      }

      void runPlanReview(currentCtx, reason);
    }, retry.delayMs);
  };

  const waitForAndHandlePlanReviewResult = async (
    sessionKey: string,
    ctx: PlanReviewRuntimeContext,
    state: PlanReviewSessionState,
    reason: PlanReviewCoordinatorReason,
    active: ActivePlanReview,
    options: {
      waitLogMessage: string;
      planFile?: string;
    },
  ): Promise<void> => {
    const logData = {
      cwd: ctx.cwd,
      reason,
      reviewId: active.reviewId,
      sessionKey,
      ...(options.planFile !== undefined ? { planFile: options.planFile } : {}),
    };

    log?.info(options.waitLogMessage, logData);

    const result = await waitForReviewResult(reviewResults, active.reviewId);

    handlePlanReviewCompletion(
      sessionKey,
      ctx,
      state,
      active,
      {
        approved: result.approved,
        feedback: result.feedback,
      },
      "status",
      ctx,
    );
  };

  const handleActivePlanReviewIfPresent = async (
    sessionKey: string,
    ctx: PlanReviewRuntimeContext,
    state: PlanReviewSessionState,
    reason: PlanReviewCoordinatorReason,
    requestPlannotator: ReturnType<typeof createRequestPlannotator>,
  ): Promise<"continue" | "stop"> => {
    const active = state.activePlanReviewByCwd.get(ctx.cwd);
    if (!active) {
      return "continue";
    }

    log?.debug("plannotator-auto checking active plan-review status", {
      cwd: ctx.cwd,
      reason,
      reviewId: active.reviewId,
      planFile: active.planFile,
      startedAt: active.startedAt,
      sessionKey,
    });

    const statusResponse = await requestReviewStatus(requestPlannotator, {
      reviewId: active.reviewId,
    });

    log?.debug("plannotator-auto received plan-review status response", {
      cwd: ctx.cwd,
      reason,
      reviewId: active.reviewId,
      responseStatus: statusResponse.status,
    });

    if (statusResponse.status === "unavailable") {
      log?.warn("plannotator-auto plan-review status unavailable", {
        cwd: ctx.cwd,
        reason,
        reviewId: active.reviewId,
        error: statusResponse.error ?? null,
      });
      notifyPlannotatorUnavailable(
        ctx,
        state,
        statusResponse.error ??
          "Plannotator is not loaded. Install/enable the Plannotator extension to use shared review flows.",
      );
      schedulePlanReviewRetry(ctx, "plan-review-status-unavailable");
      return "stop";
    }

    if (statusResponse.status === "error") {
      log?.warn("plannotator-auto plan-review status request failed", {
        cwd: ctx.cwd,
        reason,
        reviewId: active.reviewId,
        error: statusResponse.error ?? null,
      });
      ctx.ui.notify(
        statusResponse.error || "Plannotator review-status request failed.",
        "warning",
      );
      schedulePlanReviewRetry(ctx, "plan-review-status-error");
      return "stop";
    }

    const status = statusResponse.result;

    if (status.status === "pending") {
      await waitForAndHandlePlanReviewResult(
        sessionKey,
        ctx,
        state,
        reason,
        active,
        {
          waitLogMessage:
            "plannotator-auto waiting synchronously for active plan-review result",
        },
      );
      return "stop";
    }

    if (status.status === "completed") {
      handlePlanReviewCompletion(
        sessionKey,
        ctx,
        state,
        active,
        {
          approved: status.approved,
          feedback: status.feedback,
        },
        "status",
        ctx,
      );
      return "continue";
    }

    log?.info("plannotator-auto active plan review no longer pending", {
      cwd: ctx.cwd,
      reason,
      reviewId: active.reviewId,
      status: status.status,
    });
    state.activePlanReviewByCwd.delete(ctx.cwd);
    dropStalePending(state, ctx.cwd, active.startedAt);
    resetRetryAttempts(state, ctx.cwd);
    emitStateChanged(sessionKey, ctx.cwd, state);
    return "continue";
  };

  const getPendingPlanReviewPayload = (
    sessionKey: string,
    ctx: PlanReviewRuntimeContext,
    state: PlanReviewSessionState,
    reason: PlanReviewCoordinatorReason,
  ): { pending: PendingPlanReview; planContent: string } | null => {
    const pending = state.pendingPlanReviewByCwd.get(ctx.cwd);
    if (!pending) {
      log?.debug(
        "plannotator-auto no pending plan file after status handling",
        {
          cwd: ctx.cwd,
          reason,
          sessionKey,
          state: getPlanReviewStateSnapshot(state, ctx.cwd),
        },
      );
      return null;
    }

    log?.debug("plannotator-auto preparing pending plan file for review", {
      cwd: ctx.cwd,
      reason,
      planFile: pending.planFile,
      resolvedPlanPath: pending.resolvedPlanPath,
      updatedAt: pending.updatedAt,
      sessionKey,
    });

    const planContent = readPlanContent(pending.resolvedPlanPath);
    if (planContent === null) {
      log?.warn("plannotator-auto failed to read pending plan file", {
        cwd: ctx.cwd,
        reason,
        planFile: pending.planFile,
        resolvedPlanPath: pending.resolvedPlanPath,
      });
      state.pendingPlanReviewByCwd.delete(ctx.cwd);
      emitStateChanged(sessionKey, ctx.cwd, state);
      ctx.ui.notify(
        `Plannotator Auto could not read plan file: ${pending.planFile}`,
        "warning",
      );
      return null;
    }

    if (!planContent.trim()) {
      log?.info("plannotator-auto skipped empty pending plan file", {
        cwd: ctx.cwd,
        reason,
        planFile: pending.planFile,
        resolvedPlanPath: pending.resolvedPlanPath,
      });
      state.pendingPlanReviewByCwd.delete(ctx.cwd);
      emitStateChanged(sessionKey, ctx.cwd, state);
      ctx.ui.notify(
        `Plannotator Auto skipped empty plan file: ${pending.planFile}`,
        "warning",
      );
      return null;
    }

    return { pending, planContent };
  };

  const startPendingPlanReviewAndWait = async (
    sessionKey: string,
    ctx: PlanReviewRuntimeContext,
    state: PlanReviewSessionState,
    reason: PlanReviewCoordinatorReason,
    requestPlannotator: ReturnType<typeof createRequestPlannotator>,
    pending: PendingPlanReview,
    planContent: string,
  ): Promise<void> => {
    log?.info("plannotator-auto starting plan review via event API", {
      cwd: ctx.cwd,
      reason,
      planFile: pending.planFile,
      sessionKey,
      contentLength: planContent.length,
    });

    const response = await startPlanReview(requestPlannotator, reviewResults, {
      planContent,
      planFilePath: pending.planFile,
      origin: "plannotator-auto",
    });

    if (response.status === "unavailable") {
      log?.warn("plannotator-auto plan review request unavailable", {
        cwd: ctx.cwd,
        reason,
        planFile: pending.planFile,
        error: response.error ?? null,
      });
      notifyPlannotatorUnavailable(
        ctx,
        state,
        response.error ??
          "Plannotator is not loaded. Install/enable the Plannotator extension to use shared review flows.",
      );
      return;
    }

    if (response.status === "error") {
      log?.warn("plannotator-auto plan review request failed", {
        cwd: ctx.cwd,
        reason,
        planFile: pending.planFile,
        error: response.error ?? null,
      });
      ctx.ui.notify(
        response.error || "Plannotator plan review request failed.",
        "warning",
      );
      return;
    }

    state.plannotatorUnavailableNotified = false;
    state.pendingPlanReviewByCwd.delete(ctx.cwd);
    state.activePlanReviewByCwd.set(ctx.cwd, {
      reviewId: response.result.reviewId,
      kind: pending.kind,
      planFile: pending.planFile,
      resolvedPlanPath: pending.resolvedPlanPath,
      startedAt: Date.now(),
      origin: "coordinator",
    });
    emitStateChanged(sessionKey, ctx.cwd, state);

    log?.info("plannotator-auto plan review request accepted", {
      cwd: ctx.cwd,
      reason,
      planFile: pending.planFile,
      reviewId: response.result.reviewId,
      sessionKey,
      state: getPlanReviewStateSnapshot(state, ctx.cwd),
    });

    resetRetryAttempts(state, ctx.cwd);

    const activeReview = state.activePlanReviewByCwd.get(ctx.cwd);
    if (!activeReview) {
      return;
    }

    await waitForAndHandlePlanReviewResult(
      sessionKey,
      ctx,
      state,
      reason,
      activeReview,
      {
        waitLogMessage:
          "plannotator-auto waiting synchronously for plan-review result",
        planFile: pending.planFile,
      },
    );
  };

  const runPlanReview = async (
    ctx: PlanReviewRuntimeContext,
    reason: PlanReviewCoordinatorReason,
  ): Promise<void> => {
    const sessionKey = getSessionKey(ctx);
    const state = getSessionState(ctx);
    const hasPending = state.pendingPlanReviewByCwd.has(ctx.cwd);
    const hasActive = state.activePlanReviewByCwd.has(ctx.cwd);
    if (!hasPending && !hasActive) {
      resetRetryAttempts(state, ctx.cwd);
      log?.debug(
        "plannotator-auto skipped plan review (no pending or active review)",
        {
          cwd: ctx.cwd,
          reason,
          sessionKey,
          state: getPlanReviewStateSnapshot(state, ctx.cwd),
        },
      );
      return;
    }

    if (state.planReviewInFlight) {
      log?.debug("plannotator-auto skipped plan review (in flight)", {
        cwd: ctx.cwd,
        reason,
        sessionKey,
        state: getPlanReviewStateSnapshot(state, ctx.cwd),
      });
      return;
    }

    log?.debug("plannotator-auto entering plan-review workflow", {
      cwd: ctx.cwd,
      reason,
      sessionKey,
      state: getPlanReviewStateSnapshot(state, ctx.cwd),
    });

    if (!ctx.hasUI) {
      log?.debug("plannotator-auto skipped plan review (no UI)", {
        cwd: ctx.cwd,
        reason,
        sessionKey,
      });
      state.pendingPlanReviewByCwd.delete(ctx.cwd);
      emitStateChanged(sessionKey, ctx.cwd, state);
      return;
    }

    const isIdle = ctx.isIdle();
    if (shouldDeferPlanReviewWhenBusy(reason, isIdle)) {
      log?.debug("plannotator-auto deferred plan review (agent not idle)", {
        cwd: ctx.cwd,
        reason,
        sessionKey,
        state: getPlanReviewStateSnapshot(state, ctx.cwd),
      });
      schedulePlanReviewRetry(ctx, "busy-plan-review");
      return;
    }

    if (!isIdle) {
      log?.info(
        "plannotator-auto continuing plan review while agent is busy due to plan-file-write trigger",
        {
          cwd: ctx.cwd,
          reason,
          sessionKey,
          state: getPlanReviewStateSnapshot(state, ctx.cwd),
        },
      );
    }

    const requestPlannotator = createRequestPlannotator(pi.events);
    state.planReviewInFlight = true;
    emitStateChanged(sessionKey, ctx.cwd, state);

    try {
      const activeOutcome = await handleActivePlanReviewIfPresent(
        sessionKey,
        ctx,
        state,
        reason,
        requestPlannotator,
      );
      if (activeOutcome === "stop") {
        return;
      }

      const pendingPayload = getPendingPlanReviewPayload(
        sessionKey,
        ctx,
        state,
        reason,
      );
      if (!pendingPayload) {
        return;
      }

      await startPendingPlanReviewAndWait(
        sessionKey,
        ctx,
        state,
        reason,
        requestPlannotator,
        pendingPayload.pending,
        pendingPayload.planContent,
      );
    } catch (error) {
      log?.error("plannotator-auto plan-review workflow threw", {
        cwd: ctx.cwd,
        reason,
        sessionKey,
        error: error instanceof Error ? error.message : String(error),
        state: getPlanReviewStateSnapshot(state, ctx.cwd),
      });
      ctx.ui.notify(
        error instanceof Error
          ? error.message
          : "Plannotator plan review request failed.",
        "warning",
      );
    } finally {
      state.planReviewInFlight = false;
      emitStateChanged(sessionKey, ctx.cwd, state);
    }
  };

  const findActiveReviewSession = (
    reviewId: string,
  ): {
    sessionKey: string;
    cwd: string;
    state: PlanReviewSessionState;
  } | null => {
    for (const entry of iterateSessionStates()) {
      for (const [cwd, active] of entry.state.activePlanReviewByCwd.entries()) {
        if (active.reviewId === reviewId) {
          return {
            sessionKey: entry.sessionKey,
            cwd,
            state: entry.state,
          };
        }
      }
    }

    return null;
  };

  const handleIncomingReviewResult = (result: ReviewResultEvent): void => {
    const matched = findActiveReviewSession(result.reviewId);
    if (!matched) {
      log?.debug(
        "plannotator-auto observed unmatched plan review result",
        result,
      );
      return;
    }

    const active = matched.state.activePlanReviewByCwd.get(matched.cwd);
    if (!active) {
      return;
    }

    if (active.origin === "manual-submit") {
      log?.debug(
        "plannotator-auto ignored manual-submit plan review result in coordinator",
        {
          cwd: matched.cwd,
          reviewId: result.reviewId,
        },
      );
      return;
    }

    handlePlanReviewCompletion(
      matched.sessionKey,
      { cwd: matched.cwd },
      matched.state,
      active,
      {
        approved: result.approved,
        feedback: result.feedback,
      },
      "event",
      getSessionContextByKey(matched.sessionKey),
    );
  };

  reviewResults.onResult((result) => {
    handleIncomingReviewResult(result);
  });

  const queuePendingPlanReview = async (
    ctx: PlanReviewRuntimeContext,
    planReview: PendingPlanReview,
  ): Promise<void> => {
    const sessionKey = getSessionKey(ctx);
    const state = getSessionState(ctx);
    resetRetryAttempts(state, ctx.cwd);
    const replaced = markPlanReviewPending(state, ctx.cwd, planReview);
    emitStateChanged(sessionKey, ctx.cwd, state);

    log?.info("plannotator-auto queued plan review request", {
      cwd: ctx.cwd,
      planFile: planReview.planFile,
      replacedPlanFile: replaced?.planFile ?? null,
      sessionKey,
    });
  };

  return {
    queuePendingPlanReview,
    runPlanReview,
    isPlanReviewSettled,
  };
};
