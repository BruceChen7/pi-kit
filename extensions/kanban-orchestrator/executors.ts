import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";

import {
  type ResolveKanbanCardContextResult,
  resolveKanbanCardContext,
} from "./context.js";
import { importFeatureWorkflowModule } from "./feature-workflow-runtime.js";
import { buildPromptWithKanbanContext } from "./prompt-context.js";
import type { KanbanActionExecutors } from "./service.js";

function trimToNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
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

type ExecutorDeps = {
  runBoardApply: (cardId: string) => Promise<void>;
  runBoardReconcile: () => Promise<void>;
  runFeatureValidate: () => Promise<void>;
  runPruneMerged: () => Promise<void>;
  runFeatureSwitch: (branch: string) => Promise<void>;
  resolveContext: (cardId: string) => ResolveKanbanCardContextResult;
  buildPromptWithContext: typeof buildPromptWithKanbanContext;
  sendUserMessage: (
    text: string,
    options: {
      deliverAs: "followUp";
    },
  ) => void;
};

type FeatureBoardCommandsModule =
  typeof import("../feature-workflow/commands/feature-board.js");
type FeaturePruneMergedModule =
  typeof import("../feature-workflow/commands/feature-prune-merged.js");
type FeatureSwitchModule =
  typeof import("../feature-workflow/commands/feature-switch.js");
type FeatureValidateModule =
  typeof import("../feature-workflow/commands/feature-validate.js");

export function createKanbanActionExecutorsWithDeps(
  deps: ExecutorDeps,
): KanbanActionExecutors {
  return {
    reconcile: async () => {
      await deps.runBoardReconcile();
      return { summary: "board reconciled" };
    },
    apply: async ({ cardId }) => {
      await deps.runBoardApply(cardId);
      const context = expectContext(deps.resolveContext(cardId)).context;
      return {
        summary: "board card applied",
        chatJid: context.session?.chatJid,
        worktreePath: context.worktreePath ?? undefined,
      };
    },
    "open-session": async ({ cardId }) => {
      const current = expectContext(deps.resolveContext(cardId)).context;
      if (!current.branch) {
        await deps.runBoardApply(cardId);
      }

      const refreshed = expectContext(deps.resolveContext(cardId)).context;
      if (!refreshed.branch) {
        throw new Error(
          `Board card '${cardId}' has no branch after apply. Reconcile board/sidecar first.`,
        );
      }

      await deps.runFeatureSwitch(refreshed.branch);
      return {
        summary: `session opened for ${refreshed.branch}`,
        chatJid: refreshed.session?.chatJid,
        worktreePath: refreshed.worktreePath ?? undefined,
      };
    },
    "custom-prompt": async ({ cardId, payload }) => {
      const context = expectContext(deps.resolveContext(cardId)).context;
      const userPrompt = trimToNull(payload?.prompt);
      if (!userPrompt) {
        throw new Error("custom-prompt requires payload.prompt");
      }

      const prompt = deps.buildPromptWithContext({
        userPrompt,
        context,
      });
      deps.sendUserMessage(prompt, {
        deliverAs: "followUp",
      });

      return {
        summary: "custom prompt dispatched",
        chatJid: context.session?.chatJid,
        worktreePath: context.worktreePath ?? undefined,
      };
    },
    validate: async () => {
      await deps.runFeatureValidate();
      return {
        summary: "feature preflight complete",
      };
    },
    "prune-merged": async () => {
      await deps.runPruneMerged();
      return {
        summary: "prune merged finished",
      };
    },
  };
}

export function createKanbanActionExecutors(input: {
  pi: ExtensionAPI;
  ctx: ExtensionCommandContext;
  repoRoot: string;
  sessionRegistryPath: string;
}): KanbanActionExecutors {
  const sendUserMessage =
    typeof input.pi.sendUserMessage === "function"
      ? input.pi.sendUserMessage.bind(input.pi)
      : null;
  if (!sendUserMessage) {
    throw new Error("sendUserMessage is not available on ExtensionAPI");
  }

  const loadBoardCommands = async (): Promise<FeatureBoardCommandsModule> =>
    importFeatureWorkflowModule<FeatureBoardCommandsModule>(
      "commands/feature-board.js",
    );
  const loadPruneMergedModule = async (): Promise<FeaturePruneMergedModule> =>
    importFeatureWorkflowModule<FeaturePruneMergedModule>(
      "commands/feature-prune-merged.js",
    );
  const loadSwitchModule = async (): Promise<FeatureSwitchModule> =>
    importFeatureWorkflowModule<FeatureSwitchModule>(
      "commands/feature-switch.js",
    );
  const loadValidateModule = async (): Promise<FeatureValidateModule> =>
    importFeatureWorkflowModule<FeatureValidateModule>(
      "commands/feature-validate.js",
    );

  return createKanbanActionExecutorsWithDeps({
    runBoardApply: async (cardId: string) =>
      (await loadBoardCommands()).runFeatureBoardApplyCommand(
        input.pi,
        input.ctx,
        [cardId],
      ),
    runBoardReconcile: async () =>
      (await loadBoardCommands()).runFeatureBoardReconcileCommand(
        input.pi,
        input.ctx,
      ),
    runFeatureValidate: async () =>
      (await loadValidateModule()).runFeatureValidateCommand(
        input.pi,
        input.ctx,
      ),
    runPruneMerged: async () =>
      (await loadPruneMergedModule()).runFeaturePruneMergedCommand(
        input.pi,
        input.ctx,
        ["--yes"],
      ),
    runFeatureSwitch: async (branch: string) =>
      (await loadSwitchModule()).runFeatureSwitchCommand(input.pi, input.ctx, [
        branch,
      ]),
    resolveContext: (cardId: string) =>
      resolveKanbanCardContext({
        repoRoot: input.repoRoot,
        cardQuery: cardId,
        sessionRegistryPath: input.sessionRegistryPath,
      }),
    buildPromptWithContext: buildPromptWithKanbanContext,
    sendUserMessage: (text, options) => {
      sendUserMessage(text, options);
    },
  });
}
