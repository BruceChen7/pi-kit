/**
 * bash-hook - Shared entrypoint for bash tool rewrite hooks.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  createBashHookOperations,
  createBashHookTool,
  getBashHookStatus,
} from "../shared/bash-hook.ts";

export default function (pi: ExtensionAPI) {
  pi.registerTool(createBashHookTool(process.cwd()));

  pi.registerCommand("bash-hook-status", {
    description: "Show bash hook status",
    handler: async (_args, ctx) => {
      const status = getBashHookStatus(ctx.cwd);
      const formatList = (items: string[]) =>
        items.length > 0 ? items.join(", ") : "none";
      const lastRun = status.lastRun
        ? `${status.lastRun.source} ${status.lastRun.command} -> ${status.lastRun.resolved} (applied: ${formatList(status.lastRun.applied)})`
        : "none";
      const message = [
        `Bash hooks registered: ${formatList(status.registered)}`,
        `ordered: ${formatList(status.ordered)}`,
        `order setting: ${formatList(status.orderSetting)}`,
        `last run: ${lastRun}`,
      ].join(" | ");
      ctx.ui.notify(message, "info");
    },
  });

  pi.on("user_bash", (_event, ctx) => {
    return { operations: createBashHookOperations(ctx) };
  });
}
