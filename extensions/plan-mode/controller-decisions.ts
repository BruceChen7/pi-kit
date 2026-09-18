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

export type TodoReconciliationInput = {
  activeRunPlanPath: string | null;
  approvedPlanPath: string;
  hasUnfinishedTodos: boolean;
};

/**
 * Whether an approved plan needs a todo-reconciliation reminder: the active
 * run carries unfinished todos that are not bound to the approved plan
 * (created before this plan was approved, or bound to an earlier plan). A
 * run with no unfinished todos (already completed) or one already bound to
 * the approved plan needs no reminder.
 */
export const shouldRemindTodoReconciliation = ({
  activeRunPlanPath,
  approvedPlanPath,
  hasUnfinishedTodos,
}: TodoReconciliationInput): boolean =>
  hasUnfinishedTodos && activeRunPlanPath !== approvedPlanPath;

/**
 * Reminder queued at approval time. Carries the TODO-list signature taken
 * when the reminder was decided, so delivery can re-check the premise
 * ("the list still predates the approved plan") against the current list.
 */
export type PendingTodoReconcileReminder = {
  planPath: string;
  todoSignature: string;
};

export type TodoReconcileDeliveryInput = {
  pending: PendingTodoReconcileReminder | null;
  currentTodoSignature: string;
  approvedPlanStillApproved: boolean;
  hasUnfinishedTodos: boolean;
};

/**
 * Whether a queued todo-reconcile reminder may still be delivered at the
 * next turn boundary. The approval-time decision only established that the
 * list *predated* the plan; between approval and delivery the world can
 * change, so the premise is re-checked here and the reminder is dropped
 * when it no longer holds: the run completed (or cleared its todos), the
 * approval was withdrawn (e.g. ESC abort) — the message claims the plan is
 * approved — or the list was rewritten after approval, i.e. the agent
 * already reconciled it and its "not created for this plan" claim is false.
 */
export const decideTodoReconcileDelivery = ({
  pending,
  currentTodoSignature,
  approvedPlanStillApproved,
  hasUnfinishedTodos,
}: TodoReconcileDeliveryInput): boolean =>
  pending !== null &&
  hasUnfinishedTodos &&
  approvedPlanStillApproved &&
  pending.todoSignature === currentTodoSignature;
