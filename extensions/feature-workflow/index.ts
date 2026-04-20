import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import {
  runFeatureBoardApplyCommand,
  runFeatureBoardReconcileCommand,
  runFeatureBoardStatusCommand,
} from "./commands/feature-board.js";
import { runFeatureListCommand } from "./commands/feature-list.js";
import { runFeaturePruneMergedCommand } from "./commands/feature-prune-merged.js";
import { runFeatureSetupCommand } from "./commands/feature-setup.js";
import { runFeatureStartCommand } from "./commands/feature-start.js";
import { runFeatureSwitchCommand } from "./commands/feature-switch.js";
import { runFeatureValidateCommand } from "./commands/feature-validate.js";
import { commandLog } from "./commands/shared.js";
import { loadFeatureWorkflowConfig } from "./config.js";

function parseCommandArgs(rawArgs: string): string[] {
  const trimmed = rawArgs.trim();
  if (!trimmed) return [];

  const tokens = trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return tokens.map((token) => token.replace(/^["']|["']$/g, ""));
}

export default function featureWorkflowExtension(pi: ExtensionAPI): void {
  pi.registerCommand("feature-setup", {
    description:
      "Bootstrap ignored sync defaults + Worktrunk hook/script for this repo",
    handler: async (args, ctx) =>
      runFeatureSetupCommand(ctx, parseCommandArgs(args)),
  });

  pi.registerCommand("feature-start", {
    description: "Create a feature branch + worktree via Worktrunk",
    handler: async (_args, ctx) => runFeatureStartCommand(pi, ctx),
  });

  pi.registerCommand("feature-list", {
    description: "List feature records for this repo",
    handler: async (_args, ctx) => runFeatureListCommand(pi, ctx),
  });

  pi.registerCommand("feature-board-status", {
    description: "Read feature board status and parser issues",
    handler: async (_args, ctx) => runFeatureBoardStatusCommand(pi, ctx),
  });

  pi.registerCommand("feature-board-reconcile", {
    description: "Reconcile feature board intent against git/worktree state",
    handler: async (_args, ctx) => runFeatureBoardReconcileCommand(pi, ctx),
  });

  pi.registerCommand("feature-board-apply", {
    description: "Apply the next branch/worktree step for a board card",
    handler: async (args, ctx) =>
      runFeatureBoardApplyCommand(pi, ctx, parseCommandArgs(args)),
  });

  pi.registerCommand("feature-switch", {
    description: "Prepare switching to an existing feature worktree",
    handler: async (args, ctx) =>
      runFeatureSwitchCommand(pi, ctx, parseCommandArgs(args)),
  });

  pi.registerCommand("feature-prune-merged", {
    description: "Delete worktrees that are already merged upstream",
    handler: async (args, ctx) =>
      runFeaturePruneMergedCommand(pi, ctx, parseCommandArgs(args)),
  });

  pi.registerCommand("feature-validate", {
    description: "Run feature preflight checks",
    handler: async (_args, ctx) => runFeatureValidateCommand(pi, ctx),
  });

  pi.on("session_start", (_event, ctx) => {
    const config = loadFeatureWorkflowConfig(ctx.cwd);
    commandLog.debug("feature-workflow session_start", {
      cwd: ctx.cwd,
      enabled: config.enabled,
    });
    if (!config.enabled) return;
    commandLog.info("feature-workflow enabled", { cwd: ctx.cwd });
  });

  pi.on("session_before_switch", (_event, ctx) => {
    const config = loadFeatureWorkflowConfig(ctx.cwd);
    commandLog.debug("feature-workflow session_before_switch", {
      cwd: ctx.cwd,
      enabled: config.enabled,
    });
  });
}
