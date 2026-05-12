import type { ArtifactPolicyConfig } from "./artifact-policy.ts";

export type PlanMode = "plan" | "act";
export type PlanPhase = "plan" | "act";
export type PlanArtifactFormat = "markdown" | "html";
export type PlanArtifactFormatSource = "session" | "config" | "default";
export type InputSource = "interactive" | "rpc" | "extension" | "unknown";
export type TodoStatus = "todo" | "in_progress" | "done" | "blocked";
export type TodoStatusInput = TodoStatus | "pending";

export type TodoInput = {
  text: string;
  status?: TodoStatusInput;
  notes?: string;
};

export type TodoPatch = {
  text?: string;
  status?: TodoStatusInput;
  notes?: string;
};

export type TodoItem = {
  id: number;
  text: string;
  status: TodoStatus;
  notes?: string;
};

export type PlanRunStatus =
  | "draft"
  | "approved"
  | "executing"
  | "completed"
  | "archived";

export type PlanRun = {
  id: string;
  status: PlanRunStatus;
  planPath: string | null;
  todos: TodoItem[];
  nextTodoId: number;
  createdAt: string;
  approvedAt?: string;
  completedAt?: string;
  archivedAt?: string;
};

export type PlanDecisionSummary = {
  outcome: "plan_required";
  reason: string;
};

export type PlanModeSnapshot = {
  mode: PlanMode;
  phase: PlanPhase;
  todos: TodoItem[];
  nextTodoId: number;
  activeRun: PlanRun | null;
  recentRuns: PlanRun[];
  readFiles: string[];
  activePlanPath: string | null;
  latestReviewArtifactPath: string | null;
  reviewApprovedPlanPaths: string[];
  pendingApprovedPlanContinuationPath: string | null;
  confirmedApprovedContinuationPath: string | null;
  resumableApprovedPlanPath: string | null;
  endConversationRequested: boolean;
  planArtifactFormatOverride?: PlanArtifactFormat | null;
  lastAutoDecision?: PlanDecisionSummary | null;
};

export type PlanModeConfig = {
  defaultMode: PlanMode;
  planArtifactFormat: PlanArtifactFormat;
  planArtifactFormatSource: Exclude<PlanArtifactFormatSource, "session">;
  preserveExternalTools: boolean;
  requireReview: boolean;
  guards: {
    cwdOnly: boolean;
    allowedPaths: string[];
    readBeforeWrite: boolean;
  };
  artifactPolicy: ArtifactPolicyConfig;
};
