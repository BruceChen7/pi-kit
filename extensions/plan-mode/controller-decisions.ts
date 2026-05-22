import { promptRequestsPlanMode } from "./state.ts";
import type { InputSource, PlanMode, PlanPhase } from "./types.ts";

export type AgentStartPreDecisionInput = {
  inputSourceForTurn: InputSource;
  prompt: string;
  hasCompletedNonApprovedRun: boolean;
};

export type AgentStartPreDecision = {
  internalExtensionBypass: boolean;
  shouldDismissCompletedNonApprovedRun: boolean;
  shouldEnterPlanMode: boolean;
};

export const decideAgentStartPreActions = ({
  inputSourceForTurn,
  prompt,
  hasCompletedNonApprovedRun,
}: AgentStartPreDecisionInput): AgentStartPreDecision => {
  const internalExtensionBypass = inputSourceForTurn === "extension";
  return {
    internalExtensionBypass,
    shouldDismissCompletedNonApprovedRun:
      !internalExtensionBypass && hasCompletedNonApprovedRun,
    shouldEnterPlanMode:
      !internalExtensionBypass && promptRequestsPlanMode(prompt),
  };
};

export type AgentStartPostDecisionInput = {
  internalExtensionBypass: boolean;
  continuesApprovedPlan: boolean;
  isPlanPhase: boolean;
  isApprovedCompletedPlanActRun: boolean;
  canReturnPlanActToPlan: boolean;
};

export type AgentStartPostDecision = {
  reviewRequiredForTurn: boolean;
  shouldCompleteApprovedRun: boolean;
  shouldReturnPlanActToPlan: boolean;
};

export const decideAgentStartPostActions = ({
  internalExtensionBypass,
  continuesApprovedPlan,
  isPlanPhase,
  isApprovedCompletedPlanActRun,
  canReturnPlanActToPlan,
}: AgentStartPostDecisionInput): AgentStartPostDecision => ({
  reviewRequiredForTurn: isPlanPhase && !internalExtensionBypass,
  shouldCompleteApprovedRun:
    !internalExtensionBypass &&
    isApprovedCompletedPlanActRun &&
    !continuesApprovedPlan,
  shouldReturnPlanActToPlan:
    !internalExtensionBypass &&
    canReturnPlanActToPlan &&
    !continuesApprovedPlan,
});

export type PlanReviewObligationInput = {
  internalExtensionBypass: boolean;
  phase: PlanPhase;
  mode: PlanMode;
  reviewRequiredForTurn: boolean;
  todoCount: number;
  latestReviewArtifactPath: string | null;
};

export const decidePlanReviewObligation = ({
  internalExtensionBypass,
  phase,
  mode,
  reviewRequiredForTurn,
  todoCount,
  latestReviewArtifactPath,
}: PlanReviewObligationInput): boolean => {
  if (internalExtensionBypass || phase !== "plan") {
    return false;
  }
  if (mode === "plan") {
    return true;
  }
  return (
    reviewRequiredForTurn || todoCount > 0 || latestReviewArtifactPath !== null
  );
};

export type ApprovedReviewQueueInput = {
  reviewArtifactPath: string | null;
  latestReviewArtifactPath: string | null;
  alreadyApproved: boolean;
  pendingApprovedPlanContinuationPath: string | null;
  confirmedApprovedContinuationPath: string | null;
  phase: PlanPhase;
  activePlanPath: string | null;
};

export const getApprovedReviewPathToQueue = ({
  reviewArtifactPath,
  latestReviewArtifactPath,
  alreadyApproved,
  pendingApprovedPlanContinuationPath,
  confirmedApprovedContinuationPath,
  phase,
  activePlanPath,
}: ApprovedReviewQueueInput): string | null => {
  if (!reviewArtifactPath) {
    return null;
  }

  if (
    latestReviewArtifactPath &&
    reviewArtifactPath !== latestReviewArtifactPath
  ) {
    return null;
  }

  const approvalAlreadyQueued =
    alreadyApproved &&
    (pendingApprovedPlanContinuationPath === reviewArtifactPath ||
      confirmedApprovedContinuationPath === reviewArtifactPath ||
      (phase === "act" && activePlanPath === reviewArtifactPath));

  return approvalAlreadyQueued ? null : reviewArtifactPath;
};
