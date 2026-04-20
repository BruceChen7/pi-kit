import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { createLogger } from "../shared/logger.js";

import { runFeatureListCommand } from "./commands/feature-list.js";
import { runFeatureSetupCommand } from "./commands/feature-setup.js";
import { runFeatureStartCommand } from "./commands/feature-start.js";
import { runFeatureSwitchCommand } from "./commands/feature-switch.js";
import { runFeatureValidateCommand } from "./commands/feature-validate.js";
import { loadFeatureWorkflowConfig } from "./config.js";

const log = createLogger("feature-workflow", {
  minLevel: "debug",
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

  pi.registerCommand("feature-switch", {
    description: "Prepare switching to an existing feature worktree",
    handler: async (args, ctx) =>
      runFeatureSwitchCommand(pi, ctx, parseCommandArgs(args)),
  });

  pi.registerCommand("feature-validate", {
    description: "Run feature preflight checks",
    handler: async (_args, ctx) => runFeatureValidateCommand(pi, ctx),
  });

  pi.on("session_start", (_event, ctx) => {
    const config = loadFeatureWorkflowConfig(ctx.cwd);
    log.debug("feature-workflow session_start", {
      cwd: ctx.cwd,
      enabled: config.enabled,
    });
    if (!config.enabled) return;
    log.info("feature-workflow enabled", { cwd: ctx.cwd });
  });

  pi.on("session_before_switch", (_event, ctx) => {
    const config = loadFeatureWorkflowConfig(ctx.cwd);
    log.debug("feature-workflow session_before_switch", {
      cwd: ctx.cwd,
      enabled: config.enabled,
    });
  });
}
