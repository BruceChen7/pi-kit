import type {
  PendingPlanReview,
  PlanReviewSessionState,
  PlanReviewStateSnapshot,
} from "./types.ts";

export const getPlanReviewStateSnapshot = (
  state: PlanReviewSessionState,
  cwd: string,
): PlanReviewStateSnapshot => {
  const pending = state.pendingPlanReviewByCwd.get(cwd);
  const active = state.activePlanReviewByCwd.get(cwd);

  return {
    hasPending: Boolean(pending),
    hasActive: Boolean(active),
    inFlight: state.planReviewInFlight,
    pendingPlanFile: pending?.planFile ?? null,
    activeReviewId: active?.reviewId ?? null,
  };
};

export const markPlanReviewPending = (
  state: PlanReviewSessionState,
  cwd: string,
  planReview: PendingPlanReview,
): PendingPlanReview | undefined => {
  const replaced = state.pendingPlanReviewByCwd.get(cwd);
  state.pendingPlanReviewByCwd.set(cwd, planReview);
  return replaced;
};

export const dropStalePendingPlanReview = (
  state: PlanReviewSessionState,
  cwd: string,
  startedAt: number,
): PendingPlanReview | null => {
  const pending = state.pendingPlanReviewByCwd.get(cwd);
  if (!pending) {
    return null;
  }

  if (pending.updatedAt <= startedAt) {
    state.pendingPlanReviewByCwd.delete(cwd);
    return pending;
  }

  return null;
};
