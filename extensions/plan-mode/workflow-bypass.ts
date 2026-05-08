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
const WORKFLOW_IMPLEMENTATION_INTENT_WORDS = [
  "fix",
  "implement",
  "add",
  "create",
  "build",
  "refactor",
  "optimi[sz]e",
  "modify",
  "edit",
  "debug",
  "update",
  "change",
  "remove",
  "delete",
  "rename",
  "improve",
  "clean\\s+up",
] as const;
const PLAN_REVIEW_IMPLEMENTATION_INTENT_WORDS = [
  ...WORKFLOW_IMPLEMENTATION_INTENT_WORDS,
  "impl",
] as const;
const CHINESE_IMPLEMENTATION_INTENT_SOURCE =
  "修复|实现|添加|新增|创建|修改|重构|优化|调试|删除|调整|变更|完善|开发|改进";

const createImplementationIntentPattern = (
  englishWords: readonly string[],
): RegExp =>
  new RegExp(
    `\\b(${englishWords.join("|")})\\b|${CHINESE_IMPLEMENTATION_INTENT_SOURCE}`,
    "iu",
  );

const WORKFLOW_IMPLEMENTATION_INTENT_PATTERN =
  createImplementationIntentPattern(WORKFLOW_IMPLEMENTATION_INTENT_WORDS);
const PLAN_REVIEW_IMPLEMENTATION_INTENT_PATTERN =
  createImplementationIntentPattern(PLAN_REVIEW_IMPLEMENTATION_INTENT_WORDS);

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

const normalizedPromptHasWorkflowImplementationIntent = (
  normalizedPrompt: string,
): boolean => WORKFLOW_IMPLEMENTATION_INTENT_PATTERN.test(normalizedPrompt);

export const hasPlanReviewImplementationIntent = (prompt: string): boolean =>
  PLAN_REVIEW_IMPLEMENTATION_INTENT_PATTERN.test(normalizePrompt(prompt));

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

  if (normalizedPromptHasWorkflowImplementationIntent(normalizedPrompt)) {
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
