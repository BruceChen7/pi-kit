import type { AgentRuntimeAdapter } from "../extensions/kanban-orchestrator/agent-runtime-adapter.js";
import type { ResolveKanbanCardContextResult } from "../extensions/kanban-orchestrator/context.js";
import { buildPromptWithKanbanContext } from "../extensions/kanban-orchestrator/prompt-context.js";
import type { KanbanActionExecutors } from "../extensions/kanban-orchestrator/service.js";

function trimToNull(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function expectContext(
  result: ResolveKanbanCardContextResult,
): Extract<ResolveKanbanCardContextResult, { ok: true }> {
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result;
}

export function createKanbanDaemonActionExecutors(input: {
  runBoardApply: (cardId: string) => Promise<void>;
  runBoardReconcile: () => Promise<void>;
  runFeatureValidate: () => Promise<void>;
  runPruneMerged: () => Promise<void>;
  resolveContext: (cardId: string) => ResolveKanbanCardContextResult;
  buildPromptWithContext?: typeof buildPromptWithKanbanContext;
  selectRuntimeAdapter: (
    context: Extract<ResolveKanbanCardContextResult, { ok: true }>["context"],
  ) => AgentRuntimeAdapter;
}): KanbanActionExecutors {
  const buildPromptWithContext =
    input.buildPromptWithContext ?? buildPromptWithKanbanContext;

  return {
    reconcile: async () => {
      await input.runBoardReconcile();
      return { summary: "board reconciled" };
    },
    apply: async ({ cardId }) => {
      await input.runBoardApply(cardId);
      const context = expectContext(input.resolveContext(cardId)).context;
      const adapter = input.selectRuntimeAdapter(context);
      return {
        summary: "board card applied",
        chatJid: context.session?.chatJid,
        worktreePath: context.worktreePath ?? undefined,
        adapterType: context.session?.chatJid ? adapter.kind : undefined,
      };
    },
    "open-session": async ({ requestId, cardId, reportRuntimeStatus }) => {
      const current = expectContext(input.resolveContext(cardId)).context;
      if (!current.branch) {
        reportRuntimeStatus?.({
          status: "preparing",
          summary: `preparing session context for ${cardId}`,
        });
        await input.runBoardApply(cardId);
      }

      const refreshed = expectContext(input.resolveContext(cardId)).context;
      if (!refreshed.branch) {
        throw new Error(
          `Board card '${cardId}' has no branch after apply. Reconcile board/sidecar first.`,
        );
      }

      const adapter = input.selectRuntimeAdapter(refreshed);
      reportRuntimeStatus?.({
        status: "opening-session",
        summary: `opening session for ${refreshed.branch}`,
      });
      const opened = await adapter.openSession({
        repoPath: refreshed.worktreePath ?? refreshed.branch,
        worktreePath: refreshed.worktreePath,
        taskId: requestId,
        metadata: {
          branch: refreshed.branch,
          sessionRef: refreshed.session?.chatJid ?? null,
        },
      });
      return {
        summary: `session opened for ${refreshed.branch}`,
        chatJid: opened.sessionRef,
        worktreePath: refreshed.worktreePath ?? undefined,
        adapterType: adapter.kind,
      };
    },
    "custom-prompt": async ({
      requestId,
      cardId,
      payload,
      reportRuntimeStatus,
    }) => {
      const context = expectContext(input.resolveContext(cardId)).context;
      const userPrompt = trimToNull(payload?.prompt);
      if (!userPrompt) {
        throw new Error("custom-prompt requires payload.prompt");
      }

      const adapter = input.selectRuntimeAdapter(context);
      const prompt = buildPromptWithContext({
        userPrompt,
        context,
      });
      let sessionRef = context.session?.chatJid ?? null;
      if (!sessionRef) {
        reportRuntimeStatus?.({
          status: "opening-session",
          summary: "opening session for custom prompt",
        });
        sessionRef = (
          await adapter.openSession({
            repoPath: context.worktreePath ?? context.branch ?? cardId,
            worktreePath: context.worktreePath,
            taskId: requestId,
            metadata: {
              branch: context.branch,
              sessionRef: null,
            },
          })
        ).sessionRef;
      }
      await adapter.sendPrompt({
        sessionRef,
        prompt,
      });

      return {
        summary: "custom prompt dispatched",
        chatJid: sessionRef,
        worktreePath: context.worktreePath ?? undefined,
        adapterType: adapter.kind,
      };
    },
    validate: async () => {
      await input.runFeatureValidate();
      return {
        summary: "feature preflight complete",
      };
    },
    "prune-merged": async () => {
      await input.runPruneMerged();
      return {
        summary: "prune merged finished",
      };
    },
  };
}
