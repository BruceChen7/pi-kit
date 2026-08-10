export type ReviewTargetKind = "plan" | "spec" | "html";

export type PlanFileConfig = {
  planFile: string;
  resolvedPlanPath: string;
  resolvedPlanPaths: string[];
  resolvedSpecPaths: string[];
  resolvedHtmlPaths: string[];
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
