export type WorkflowBypassState = {
  active: boolean;
  reason: string | null;
};

export const DEFAULT_WORKFLOW_BYPASS_STATE: WorkflowBypassState = {
  active: false,
  reason: null,
};

// Implementation verbs mean the user is asking the agent to change behavior/code,
// so plan review should still gate the turn even if the prompt also mentions commit.
const IMPLEMENTATION_INTENT_PATTERN =
  /\b(fix|implement|add|create|build|refactor|optimi[sz]e|modify|edit|debug)\b/iu;

const WORKFLOW_INTENT_PATTERNS = [
  // Git-only workflows are operational tasks, not implementation work.
  /\b(git\s+)?(commit|push|status|diff|log)\b/iu,
  // Verification commands are operational checks when no implementation verb is present.
  /\b(run|execute)?\s*(npm\s+run\s+)?(tests?|lint|format|checks?)\b/iu,
] as const;

// Short confirmation replies should continue an already-started workflow turn.
const WORKFLOW_CONFIRMATION_PATTERN = /^(yes|y|no|n|include it|exclude it)$/iu;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const normalizePrompt = (prompt: string): string =>
  prompt.trim().replace(/\s+/gu, " ");

const isConfirmationForActiveWorkflow = (
  normalizedPrompt: string,
  current: WorkflowBypassState,
  hasUnfinishedTodos: boolean,
): boolean =>
  current.active &&
  hasUnfinishedTodos &&
  WORKFLOW_CONFIRMATION_PATTERN.test(normalizedPrompt);

export const decideWorkflowBypass = (
  prompt: string,
  current: WorkflowBypassState,
  hasUnfinishedTodos: boolean,
): WorkflowBypassState => {
  const normalizedPrompt = normalizePrompt(prompt);
  if (!normalizedPrompt) {
    return DEFAULT_WORKFLOW_BYPASS_STATE;
  }

  if (
    isConfirmationForActiveWorkflow(
      normalizedPrompt,
      current,
      hasUnfinishedTodos,
    )
  ) {
    return current;
  }

  if (IMPLEMENTATION_INTENT_PATTERN.test(normalizedPrompt)) {
    return DEFAULT_WORKFLOW_BYPASS_STATE;
  }

  const matchedWorkflow = WORKFLOW_INTENT_PATTERNS.some((pattern) =>
    pattern.test(normalizedPrompt),
  );
  if (!matchedWorkflow) {
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
