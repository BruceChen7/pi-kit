import type { PlanReviewCoordinatorReason } from "./types.ts";

const MAX_PLAN_REVIEW_RETRY_ATTEMPTS = 12;
const MAX_PLAN_REVIEW_RETRY_DELAY_MS = 15_000;

const BASE_RETRY_DELAY_MS: Record<
  Exclude<PlanReviewCoordinatorReason, "plan-file-write" | "agent_end">,
  number
> = {
  "busy-plan-review": 180,
  "pending-plan-review-status": 1_200,
  "plan-review-status-unavailable": 1_200,
  "plan-review-status-error": 1_200,
};

export const shouldDeferPlanReviewWhenBusy = (
  reason: PlanReviewCoordinatorReason,
  isIdle: boolean,
): boolean => !isIdle && reason !== "plan-file-write";

export const getPlanReviewRetryDelay = (
  reason: Exclude<PlanReviewCoordinatorReason, "plan-file-write" | "agent_end">,
  attempt: number,
): {
  delayMs: number;
  exhausted: boolean;
} => {
  if (attempt > MAX_PLAN_REVIEW_RETRY_ATTEMPTS) {
    return {
      delayMs: MAX_PLAN_REVIEW_RETRY_DELAY_MS,
      exhausted: true,
    };
  }

  const base = BASE_RETRY_DELAY_MS[reason];
  const exponential = Math.min(
    MAX_PLAN_REVIEW_RETRY_DELAY_MS,
    base * 2 ** Math.max(0, attempt - 1),
  );
  const jitter = Math.floor(exponential * 0.15 * Math.random());

  return {
    delayMs: exponential + jitter,
    exhausted: false,
  };
};
