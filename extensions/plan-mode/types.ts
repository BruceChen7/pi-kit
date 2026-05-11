import type { ArtifactPolicyConfig } from "./artifact-policy.ts";

export type PlanMode = "plan" | "act" | "auto" | "fast";
export type PlanPhase = "plan" | "act";
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

export type AutoDecisionSummary = {
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
  lastAutoDecision?: AutoDecisionSummary | null;
};

export type PlanModePreset = "strict" | "balanced" | "solo";
export type ApprovalContinuationMode = "confirm" | "auto" | "manual";

export type PlanModeConfig = {
  defaultMode: PlanMode;
  preserveExternalTools: boolean;
  requireReview: boolean;
  approval: {
    continueAfterApproval: ApprovalContinuationMode;
  };
  guards: {
    cwdOnly: boolean;
    allowedPaths: string[];
    readBeforeWrite: boolean;
  };
  artifactPolicy: ArtifactPolicyConfig;
};
