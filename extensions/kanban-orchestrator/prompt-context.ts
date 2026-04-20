import type { KanbanCardContext } from "./context.js";

const DEFAULT_MAX_USER_PROMPT_CHARS = 8_000;

export function buildPromptWithKanbanContext(input: {
  userPrompt: string;
  context: KanbanCardContext;
  maxUserPromptChars?: number;
}): string {
  const maxChars =
    typeof input.maxUserPromptChars === "number" &&
    Number.isFinite(input.maxUserPromptChars) &&
    input.maxUserPromptChars > 0
      ? input.maxUserPromptChars
      : DEFAULT_MAX_USER_PROMPT_CHARS;

  if (input.userPrompt.length > maxChars) {
    throw new Error(
      `Prompt length exceeds limit: ${input.userPrompt.length} > ${maxChars}`,
    );
  }

  const contextLines = [
    `[KANBAN CARD CONTEXT]`,
    `cardId: ${input.context.cardId}`,
    `title: ${input.context.title}`,
    `kind: ${input.context.kind}`,
    `lane: ${input.context.lane}`,
    `parentCardId: ${input.context.parentCardId ?? "<none>"}`,
    `branch: ${input.context.branch ?? "<none>"}`,
    `baseBranch: ${input.context.baseBranch ?? "<none>"}`,
    `mergeTarget: ${input.context.mergeTarget ?? "<none>"}`,
    `worktreePath: ${input.context.worktreePath ?? "<none>"}`,
    `chatJid: ${input.context.session?.chatJid ?? "<none>"}`,
    `sessionWorktreePath: ${input.context.session?.worktreePath ?? "<none>"}`,
    `sessionLastActiveAt: ${input.context.session?.lastActiveAt ?? "<none>"}`,
  ];

  return `${contextLines.join("\n")}\n\n[USER PROMPT]\n${input.userPrompt}`;
}
