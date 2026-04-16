import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export type PlanFileMode = "file" | "directory";

export type PlanFileConfig = {
  planFile: string;
  resolvedPlanPath: string;
  mode: PlanFileMode;
};

export type PendingPlanReview = {
  planFile: string;
  resolvedPlanPath: string;
  updatedAt: number;
};

export type ActivePlanReview = {
  reviewId: string;
  planFile: string;
  startedAt: number;
};

export type PlanReviewSessionState = {
  pendingPlanReviewByCwd: Map<string, PendingPlanReview>;
  activePlanReviewByCwd: Map<string, ActivePlanReview>;
  processedPlanReviewIds: Set<string>;
  pendingPlanReviewRetry: ReturnType<typeof setTimeout> | null;
  planReviewRetryAttemptsByCwd: Map<string, number>;
  planReviewInFlight: boolean;
  plannotatorUnavailableNotified: boolean;
};

export type SessionKeyContext = {
  cwd: string;
  sessionManager: {
    getSessionFile: () => string | null | undefined;
  };
};

export type PlanReviewStateSnapshot = {
  hasPending: boolean;
  hasActive: boolean;
  inFlight: boolean;
  pendingPlanFile: string | null;
  activeReviewId: string | null;
};

export type PlanReviewCoordinatorReason =
  | "plan-file-write"
  | "agent_end"
  | "busy-plan-review"
  | "pending-plan-review-status"
  | "plan-review-status-unavailable"
  | "plan-review-status-error"
  | "await-plan-review-result";

export type PlanReviewRuntimeContext = Pick<
  ExtensionContext,
  "cwd" | "hasUI" | "isIdle" | "ui" | "abort"
> &
  SessionKeyContext;
