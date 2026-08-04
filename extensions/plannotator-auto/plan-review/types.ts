export type ReviewTargetKind = "plan" | "spec" | "html";

export type ExtraReviewTarget = {
  dir: string;
  pattern: RegExp;
};

export type PlanFileConfig = {
  planFile: string;
  resolvedPlanPath: string;
  resolvedPlanPaths: string[];
  resolvedSpecPaths: string[];
  resolvedHtmlPaths: string[];
  extraReviewTargets: ExtraReviewTarget[];
};

export type PendingPlanReview = {
  kind: ReviewTargetKind;
  planFile: string;
  resolvedPlanPath: string;
  updatedAt: number;
  /** True once a lavish-axi session was opened for this artifact; retries must not re-open. */
  lavishSessionOpened?: boolean;
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
