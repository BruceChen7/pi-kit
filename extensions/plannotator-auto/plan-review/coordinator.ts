import fs from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  createRequestPlannotator,
  type createReviewResultStore,
  formatPlanReviewMessage,
  type ReviewResultEvent,
  requestReviewStatus,
  startPlanReview,
} from "../plannotator-api.ts";
import {
  getPlanReviewRetryDelay,
  shouldAbortAfterPlanReviewStart,
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
  getSessionKey: (ctx: SessionKeyContext) => string;
  iterateSessionStates: () => Iterable<SessionStateEntry>;
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

export type PlanReviewCoordinator = {
  queuePendingPlanReview: (
    ctx: PlanReviewRuntimeContext,
    planReview: PendingPlanReview,
  ) => void;
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
    getSessionKey,
    iterateSessionStates,
    log,
  } = deps;

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
    ctx: Pick<PlanReviewRuntimeContext, "cwd">,
    state: PlanReviewSessionState,
    active: ActivePlanReview,
    result: {
      approved: boolean;
      feedback?: string;
    },
    source: "event" | "status",
  ): void => {
    if (state.processedPlanReviewIds.has(active.reviewId)) {
      log?.debug("plannotator-auto ignored duplicate plan-review completion", {
        cwd: ctx.cwd,
        source,
        reviewId: active.reviewId,
      });
      return;
    }

    state.processedPlanReviewIds.add(active.reviewId);
    state.activePlanReviewByCwd.delete(ctx.cwd);
    dropStalePending(state, ctx.cwd, active.startedAt);
    state.plannotatorUnavailableNotified = false;
    resetRetryAttempts(state, ctx.cwd);

    pi.sendUserMessage(formatPlanReviewMessage(result));

    log?.info("plannotator-auto completed plan review", {
      cwd: ctx.cwd,
      source,
      reviewId: active.reviewId,
      approved: result.approved,
      hasFeedback: Boolean(result.feedback?.trim()),
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
      void runPlanReview(ctx, reason);
    }, retry.delayMs);
  };

  const runPlanReview = async (
    ctx: PlanReviewRuntimeContext,
    reason: PlanReviewCoordinatorReason,
  ): Promise<void> => {
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
          sessionKey: getSessionKey(ctx),
          state: getPlanReviewStateSnapshot(state, ctx.cwd),
        },
      );
      return;
    }

    if (state.planReviewInFlight) {
      log?.debug("plannotator-auto skipped plan review (in flight)", {
        cwd: ctx.cwd,
        reason,
        sessionKey: getSessionKey(ctx),
        state: getPlanReviewStateSnapshot(state, ctx.cwd),
      });
      return;
    }

    log?.debug("plannotator-auto entering plan-review workflow", {
      cwd: ctx.cwd,
      reason,
      sessionKey: getSessionKey(ctx),
      state: getPlanReviewStateSnapshot(state, ctx.cwd),
    });

    if (!ctx.hasUI) {
      log?.debug("plannotator-auto skipped plan review (no UI)", {
        cwd: ctx.cwd,
        reason,
        sessionKey: getSessionKey(ctx),
      });
      state.pendingPlanReviewByCwd.delete(ctx.cwd);
      return;
    }

    const isIdle = ctx.isIdle();
    if (shouldDeferPlanReviewWhenBusy(reason, isIdle)) {
      log?.debug("plannotator-auto deferred plan review (agent not idle)", {
        cwd: ctx.cwd,
        reason,
        sessionKey: getSessionKey(ctx),
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
          sessionKey: getSessionKey(ctx),
          state: getPlanReviewStateSnapshot(state, ctx.cwd),
        },
      );
    }

    const requestPlannotator = createRequestPlannotator(pi.events);
    state.planReviewInFlight = true;

    try {
      const active = state.activePlanReviewByCwd.get(ctx.cwd);
      if (active) {
        log?.debug("plannotator-auto checking active plan-review status", {
          cwd: ctx.cwd,
          reason,
          reviewId: active.reviewId,
          planFile: active.planFile,
          startedAt: active.startedAt,
          sessionKey: getSessionKey(ctx),
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

        if (statusResponse.status === "handled") {
          const status = statusResponse.result;
          if (status.status === "pending") {
            log?.debug("plannotator-auto plan review still pending", {
              cwd: ctx.cwd,
              reason,
              reviewId: active.reviewId,
            });
            schedulePlanReviewRetry(ctx, "pending-plan-review-status");
            return;
          }

          if (status.status === "completed") {
            handlePlanReviewCompletion(
              ctx,
              state,
              active,
              {
                approved: status.approved,
                feedback: status.feedback,
              },
              "status",
            );
          } else {
            log?.info("plannotator-auto active plan review no longer pending", {
              cwd: ctx.cwd,
              reason,
              reviewId: active.reviewId,
              status: status.status,
            });
            state.activePlanReviewByCwd.delete(ctx.cwd);
            dropStalePending(state, ctx.cwd, active.startedAt);
            resetRetryAttempts(state, ctx.cwd);
          }
        } else if (statusResponse.status === "unavailable") {
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
          return;
        } else {
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
          return;
        }
      }

      const pending = state.pendingPlanReviewByCwd.get(ctx.cwd);
      if (!pending) {
        log?.debug(
          "plannotator-auto no pending plan file after status handling",
          {
            cwd: ctx.cwd,
            reason,
            sessionKey: getSessionKey(ctx),
            state: getPlanReviewStateSnapshot(state, ctx.cwd),
          },
        );
        return;
      }

      log?.debug("plannotator-auto preparing pending plan file for review", {
        cwd: ctx.cwd,
        reason,
        planFile: pending.planFile,
        resolvedPlanPath: pending.resolvedPlanPath,
        updatedAt: pending.updatedAt,
        sessionKey: getSessionKey(ctx),
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
        ctx.ui.notify(
          `Plannotator Auto could not read plan file: ${pending.planFile}`,
          "warning",
        );
        return;
      }

      if (!planContent.trim()) {
        log?.info("plannotator-auto skipped empty pending plan file", {
          cwd: ctx.cwd,
          reason,
          planFile: pending.planFile,
          resolvedPlanPath: pending.resolvedPlanPath,
        });
        state.pendingPlanReviewByCwd.delete(ctx.cwd);
        ctx.ui.notify(
          `Plannotator Auto skipped empty plan file: ${pending.planFile}`,
          "warning",
        );
        return;
      }

      log?.info("plannotator-auto starting plan review via event API", {
        cwd: ctx.cwd,
        reason,
        planFile: pending.planFile,
        sessionKey: getSessionKey(ctx),
        contentLength: planContent.length,
      });

      const response = await startPlanReview(
        requestPlannotator,
        reviewResults,
        {
          planContent,
          planFilePath: pending.planFile,
          origin: "plannotator-auto",
        },
      );

      if (response.status === "handled") {
        state.plannotatorUnavailableNotified = false;
        state.pendingPlanReviewByCwd.delete(ctx.cwd);
        state.activePlanReviewByCwd.set(ctx.cwd, {
          reviewId: response.result.reviewId,
          planFile: pending.planFile,
          startedAt: Date.now(),
        });

        log?.info("plannotator-auto plan review request accepted", {
          cwd: ctx.cwd,
          reason,
          planFile: pending.planFile,
          reviewId: response.result.reviewId,
          sessionKey: getSessionKey(ctx),
          state: getPlanReviewStateSnapshot(state, ctx.cwd),
        });

        if (shouldAbortAfterPlanReviewStart(reason, ctx.isIdle())) {
          log?.info(
            "plannotator-auto aborting in-flight agent run after plan-review start",
            {
              cwd: ctx.cwd,
              reason,
              planFile: pending.planFile,
              reviewId: response.result.reviewId,
              sessionKey: getSessionKey(ctx),
            },
          );
          ctx.abort();
        }

        resetRetryAttempts(state, ctx.cwd);
        schedulePlanReviewRetry(ctx, "await-plan-review-result");
        return;
      }

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
    } catch (error) {
      log?.error("plannotator-auto plan-review workflow threw", {
        cwd: ctx.cwd,
        reason,
        sessionKey: getSessionKey(ctx),
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
    }
  };

  const findActiveReviewSession = (
    reviewId: string,
  ): {
    cwd: string;
    state: PlanReviewSessionState;
  } | null => {
    for (const entry of iterateSessionStates()) {
      for (const [cwd, active] of entry.state.activePlanReviewByCwd.entries()) {
        if (active.reviewId === reviewId) {
          return {
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

    handlePlanReviewCompletion(
      { cwd: matched.cwd },
      matched.state,
      active,
      {
        approved: result.approved,
        feedback: result.feedback,
      },
      "event",
    );
  };

  reviewResults.onResult((result) => {
    handleIncomingReviewResult(result);
  });

  const queuePendingPlanReview = (
    ctx: PlanReviewRuntimeContext,
    planReview: PendingPlanReview,
  ): void => {
    const state = getSessionState(ctx);
    resetRetryAttempts(state, ctx.cwd);
    const replaced = markPlanReviewPending(state, ctx.cwd, planReview);

    log?.info("plannotator-auto queued plan review request", {
      cwd: ctx.cwd,
      planFile: planReview.planFile,
      replacedPlanFile: replaced?.planFile ?? null,
      sessionKey: getSessionKey(ctx),
    });

    void runPlanReview(ctx, "plan-file-write");
  };

  return {
    queuePendingPlanReview,
    runPlanReview,
    isPlanReviewSettled,
  };
};
