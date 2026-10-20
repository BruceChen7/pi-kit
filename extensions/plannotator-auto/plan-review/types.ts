export type ReviewTargetKind = "plan" | "spec" | "html";

/** Reviewer status a manual review leaves for the auto submit tool to report. */
export type ManualReviewStatus = "approved" | "denied";

/**
 * A manual review verdict waiting to be claimed by the auto submit tool, whose
 * result is where other extensions (plan-mode) observe approval.
 */
export type ManualReviewVerdict = {
  resolvedPlanPath: string;
  status: ManualReviewStatus;
};

export type PendingPlanReview = {
  kind: ReviewTargetKind;
  planFile: string;
  resolvedPlanPath: string;
  updatedAt: number;
};

export type ActivePlanReview = {
  reviewId: string;
  kind: ReviewTargetKind;
  planFile: string;
  resolvedPlanPath: string;
  startedAt: number;
  origin?: "manual-submit";
};

export type SessionKeyContext = {
  cwd: string;
  sessionManager: {
    getSessionFile: () => string | null | undefined;
  };
};
