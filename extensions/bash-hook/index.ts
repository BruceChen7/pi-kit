/**
 * bash-hook - Shared entrypoint for bash tool rewrite hooks.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  createBashHookOperations,
  createBashHookTool,
} from "../shared/bash-hook.ts";

export default function (pi: ExtensionAPI) {
  pi.registerTool(createBashHookTool(process.cwd()));

  pi.on("user_bash", (_event, ctx) => {
    return { operations: createBashHookOperations(ctx) };
  });
}
