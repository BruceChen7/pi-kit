import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";

import {
  type ResolvedFeatureWorkflowCommandContext,
  resolveFeatureWorkflowCommandContext,
} from "./command-context.js";
import { createWtRunner, type WtRunner } from "./worktree-gateway.js";

export type FeatureCommandRuntime = ResolvedFeatureWorkflowCommandContext & {
  runWt: WtRunner;
};

export function resolveFeatureCommandRuntime(input: {
  pi: ExtensionAPI;
  ctx: ExtensionCommandContext;
}): FeatureCommandRuntime | null {
  const baseContext = resolveFeatureWorkflowCommandContext({
    cwd: input.ctx.cwd,
    ui: input.ctx.ui,
  });
  if (!baseContext) {
    return null;
  }

  return {
    ...baseContext,
    runWt: createWtRunner(input.pi, baseContext.repoRoot),
  };
}
