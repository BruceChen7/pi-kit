import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createLogger } from "../shared/logger.js";
import { loadFeatureWorkflowConfig } from "./config.js";

const commandLog = createLogger("feature-workflow", {
  stderr: null,
});

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
    handler: async (args, ctx) => {
      const { runFeatureSetupCommand } = await import(
        "./commands/feature-setup.js"
      );
      return runFeatureSetupCommand(ctx, parseCommandArgs(args));
    },
  });

  pi.registerCommand("feature-start", {
    description: "Create a feature branch + worktree via Worktrunk",
    handler: async (_args, ctx) => {
      const { runFeatureStartCommand } = await import(
        "./commands/feature-start.js"
      );
      return runFeatureStartCommand(pi, ctx);
    },
  });

  pi.registerCommand("feature-list", {
    description: "List feature records for this repo",
    handler: async (_args, ctx) => {
      const { runFeatureListCommand } = await import(
        "./commands/feature-list.js"
      );
      return runFeatureListCommand(pi, ctx);
    },
  });

  pi.registerCommand("feature-switch", {
    description: "Prepare switching to an existing feature worktree",
    handler: async (args, ctx) => {
      const { runFeatureSwitchCommand } = await import(
        "./commands/feature-switch.js"
      );
      return runFeatureSwitchCommand(pi, ctx, parseCommandArgs(args));
    },
  });

  pi.registerCommand("feature-prune-merged", {
    description: "Delete worktrees that are already merged upstream",
    handler: async (args, ctx) => {
      const { runFeaturePruneMergedCommand } = await import(
        "./commands/feature-prune-merged.js"
      );
      return runFeaturePruneMergedCommand(pi, ctx, parseCommandArgs(args));
    },
  });

  pi.registerCommand("feature-validate", {
    description: "Run feature preflight checks",
    handler: async (_args, ctx) => {
      const { runFeatureValidateCommand } = await import(
        "./commands/feature-validate.js"
      );
      return runFeatureValidateCommand(pi, ctx);
    },
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
