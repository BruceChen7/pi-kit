export type WorkflowBypassState = {
  active: boolean;
  reason: string | null;
};

export type IntentFeedbackKind =
  | "implementation"
  | "workflow_only"
  | "read_only"
  | "ambiguous";

export type IntentFeedback = {
  kind: IntentFeedbackKind;
  confidence: number;
  reason: string;
  evidence: string[];
  requestedOperations: string[];
};

export const DEFAULT_WORKFLOW_BYPASS_STATE: WorkflowBypassState = {
  active: false,
  reason: null,
};

const MINIMUM_INTENT_CONFIDENCE = 0.7;

// Short confirmation replies should continue an already-started workflow turn.
const WORKFLOW_CONFIRMATION_PATTERN = /^(yes|y|no|n|include it|exclude it)$/iu;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const normalizePrompt = (prompt: string): string =>
  prompt.trim().replace(/\s+/gu, " ");

const isIntentFeedbackKind = (value: unknown): value is IntentFeedbackKind =>
  value === "implementation" ||
  value === "workflow_only" ||
  value === "read_only" ||
  value === "ambiguous";

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

export const parseIntentFeedback = (value: unknown): IntentFeedback | null => {
  if (!isRecord(value)) {
    return null;
  }

  if (
    !isIntentFeedbackKind(value.kind) ||
    typeof value.confidence !== "number" ||
    value.confidence < MINIMUM_INTENT_CONFIDENCE ||
    typeof value.reason !== "string" ||
    !isStringArray(value.evidence) ||
    !isStringArray(value.requestedOperations)
  ) {
    return null;
  }

  return {
    kind: value.kind,
    confidence: value.confidence,
    reason: value.reason,
    evidence: value.evidence,
    requestedOperations: value.requestedOperations,
  };
};

export const requiresPlanReviewForIntentFeedback = (
  feedback: unknown,
): boolean => {
  const parsed = parseIntentFeedback(feedback);
  return (
    !parsed || parsed.kind === "implementation" || parsed.kind === "ambiguous"
  );
};

const isConfirmationForActiveWorkflow = (
  normalizedPrompt: string,
  current: WorkflowBypassState,
  hasUnfinishedTodos: boolean,
): boolean =>
  current.active &&
  hasUnfinishedTodos &&
  WORKFLOW_CONFIRMATION_PATTERN.test(normalizedPrompt);

export const decideWorkflowBypass = (
  intentFeedback: unknown,
  current: WorkflowBypassState,
  hasUnfinishedTodos: boolean,
): WorkflowBypassState => {
  if (typeof intentFeedback === "string") {
    const normalizedPrompt = normalizePrompt(intentFeedback);
    if (
      isConfirmationForActiveWorkflow(
        normalizedPrompt,
        current,
        hasUnfinishedTodos,
      )
    ) {
      return current;
    }
    return DEFAULT_WORKFLOW_BYPASS_STATE;
  }

  const feedback = parseIntentFeedback(intentFeedback);
  if (feedback?.kind !== "workflow_only") {
    return DEFAULT_WORKFLOW_BYPASS_STATE;
  }

  return {
    active: true,
    reason: "workflow-only request",
  };
};

export const workflowBypassFromSnapshot = (
  value: unknown,
): WorkflowBypassState => {
  if (!isRecord(value)) {
    return DEFAULT_WORKFLOW_BYPASS_STATE;
  }
  return {
    active: value.active === true,
    reason: typeof value.reason === "string" ? value.reason : null,
  };
};
