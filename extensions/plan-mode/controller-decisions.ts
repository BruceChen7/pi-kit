import { promptRequestsPlanMode } from "./state.ts";
import type { InputSource, PlanMode, PlanPhase, PlanRun } from "./types.ts";

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

// ── TODO discipline (②③) ─────────────────────────────────────

export type TodoDoneFlip = {
  id: number;
  /** Whether the item was ever in_progress during its run lifetime. */
  everInProgress: boolean;
};

export type TodoDisciplineReason = "no-in-progress" | "batch-done";

export const TODO_DISCIPLINE_REMINDER_LIMIT = 3;

export type TodoDisciplineInput = {
  run: Pick<PlanRun, "id" | "status" | "todos"> | null;
  turnDoneFlips: TodoDoneFlip[];
  reminderMarkers: Set<string>;
  reminderCounts: Record<string, number>;
};

export type TodoDisciplineDecision = {
  /** All triggered offenses this turn (suppressed or not) — used by the
   *  controller to decide whether the turn was compliant (re-arm). */
  offenses: TodoDisciplineReason[];
  /** Offenses that should produce a reminder now (not suppressed by a
   *  marker, and under the per-run cap). */
  reasons: TodoDisciplineReason[];
  nextMarkers: Set<string>;
  nextCounts: Record<string, number>;
};

const runReasonKey = (runId: string, reason: TodoDisciplineReason): string =>
  `${runId}:${reason}`;

/**
 * Decide which TODO-discipline reminders (if any) should fire at agent_end.
 * Pure value-in / value-out: no side effects, no persistence.
 *
 * - "no-in-progress" (②, defensive): run is executing with unfinished items
 *   but nothing in_progress and nothing blocked (restore/remove anomalies —
 *   the ① normalization makes this unreachable on the normal path).
 * - "batch-done" (③): >=2 items flipped to done in this turn whose items
 *   were never in_progress during the run — the "mark everything done at the
 *   end" pattern.
 *
 * Frequency control: a marker per (run, reason) suppresses repeats until it is
 * cleared (re-armed by any todo update); a per-run per-reason cap prevents
 * follow-up self-continuation loops.
 */
export const decideTodoDisciplineReminders = ({
  run,
  turnDoneFlips,
  reminderMarkers,
  reminderCounts,
}: TodoDisciplineInput): TodoDisciplineDecision => {
  const offenses: TodoDisciplineReason[] = [];
  const reasons: TodoDisciplineReason[] = [];
  const nextMarkers = new Set(reminderMarkers);
  const nextCounts = { ...reminderCounts };

  const consider = (reason: TodoDisciplineReason, triggered: boolean): void => {
    if (!triggered || !run) {
      return;
    }
    offenses.push(reason);
    const key = runReasonKey(run.id, reason);
    if (nextMarkers.has(key)) {
      return;
    }
    if ((nextCounts[key] ?? 0) >= TODO_DISCIPLINE_REMINDER_LIMIT) {
      return;
    }
    reasons.push(reason);
    nextMarkers.add(key);
    nextCounts[key] = (nextCounts[key] ?? 0) + 1;
  };

  if (!run) {
    return { offenses, reasons, nextMarkers, nextCounts };
  }

  const hasUnfinished = run.todos.some((todo) => todo.status !== "done");
  const hasInProgress = run.todos.some((todo) => todo.status === "in_progress");
  const hasBlocked = run.todos.some((todo) => todo.status === "blocked");
  consider(
    "no-in-progress",
    run.status === "executing" &&
      hasUnfinished &&
      !hasInProgress &&
      !hasBlocked,
  );

  const neverInProgressFlips = turnDoneFlips.filter(
    (flip) => !flip.everInProgress,
  );
  consider("batch-done", neverInProgressFlips.length >= 2);

  return { offenses, reasons, nextMarkers, nextCounts };
};

/** Clear the discipline markers for one run (compliance or re-arm). */
export const clearTodoDisciplineMarkersForRun = (
  markers: Set<string>,
  runId: string,
): Set<string> => {
  const prefix = `${runId}:`;
  const next = new Set(markers);
  for (const key of next) {
    if (key.startsWith(prefix)) {
      next.delete(key);
    }
  }
  return next;
};

export const buildTodoDisciplineReminder = (
  reasons: TodoDisciplineReason[],
  todoToolName: string,
): string => {
  const lines: string[] = [];
  if (reasons.includes("no-in-progress")) {
    lines.push(
      `Plan Mode: the executing TODO list has unfinished items but nothing ` +
        `in_progress. Call ${todoToolName} to mark the current step ` +
        `in_progress so the widget shows where execution is.`,
    );
  }
  if (reasons.includes("batch-done")) {
    lines.push(
      `Plan Mode: multiple TODO items were flipped to done in one turn ` +
        `without ever being in_progress. Execute steps one at a time: mark a ` +
        `step done as soon as it finishes and move in_progress to the next; ` +
        `do not bulk-mark everything done at the end.`,
    );
  }
  return lines.join("\n");
};
