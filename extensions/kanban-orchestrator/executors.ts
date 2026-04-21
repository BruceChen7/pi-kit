import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";

import { createKanbanDaemonActionExecutors } from "../../kanban-daemon/action-executors.js";
import type { AgentRuntimeAdapter } from "./agent-runtime-adapter.js";
import {
  type ResolveKanbanCardContextResult,
  resolveKanbanCardContext,
} from "./context.js";
import { importFeatureWorkflowModule } from "./feature-workflow-runtime.js";
import { createPiRuntimeAdapterWithDeps } from "./pi-runtime-adapter.js";
import type { PiRuntimeEventBridge } from "./pi-runtime-event-bridge.js";
import { buildPromptWithKanbanContext } from "./prompt-context.js";
import type { KanbanActionExecutors } from "./service.js";

type ExecutorDeps = {
  runBoardApply: (cardId: string) => Promise<void>;
  runBoardReconcile: () => Promise<void>;
  runFeatureValidate: () => Promise<void>;
  runPruneMerged: () => Promise<void>;
  resolveContext: (cardId: string) => ResolveKanbanCardContextResult;
  buildPromptWithContext: typeof buildPromptWithKanbanContext;
  runtimeAdapter: AgentRuntimeAdapter;
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
  return createKanbanDaemonActionExecutors({
    runBoardApply: deps.runBoardApply,
    runBoardReconcile: deps.runBoardReconcile,
    runFeatureValidate: deps.runFeatureValidate,
    runPruneMerged: deps.runPruneMerged,
    resolveContext: deps.resolveContext,
    buildPromptWithContext: deps.buildPromptWithContext,
    selectRuntimeAdapter: () => deps.runtimeAdapter,
  });
}

export function createKanbanActionExecutors(input: {
  pi: ExtensionAPI;
  ctx: ExtensionCommandContext;
  repoRoot: string;
  sessionRegistryPath: string;
  eventBridge: PiRuntimeEventBridge;
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
    resolveContext: (cardId: string) =>
      resolveKanbanCardContext({
        repoRoot: input.repoRoot,
        cardQuery: cardId,
        sessionRegistryPath: input.sessionRegistryPath,
      }),
    buildPromptWithContext: buildPromptWithKanbanContext,
    runtimeAdapter: createPiRuntimeAdapterWithDeps({
      runFeatureSwitch: async (branch: string) =>
        (await loadSwitchModule()).runFeatureSwitchCommand(
          input.pi,
          input.ctx,
          [branch],
        ),
      sendUserMessage: (text, options) => {
        sendUserMessage(text, options);
      },
      eventBridge: input.eventBridge,
    }),
  });
}
