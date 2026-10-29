import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { decideBashGuard, readBashCall, resolveLimits } from "./guard.ts";

type ToolCallHandler = (event: {
  toolName: string;
  input: unknown;
}) => { block: true; reason: string } | undefined;

/**
 * The shell: read the call, resolve limits, hand the decision back to pi.
 * Limits are read per call so a long-running session picks up an env change
 * without a restart.
 */
export const createBashGuardHandler =
  (env: Record<string, string | undefined>): ToolCallHandler =>
  (event) => {
    const call = readBashCall(event.toolName, event.input);
    if (!call) {
      return undefined;
    }
    const decision = decideBashGuard(call, resolveLimits(env));
    if (decision.action === "allow") {
      return undefined;
    }
    return { block: true, reason: decision.reason };
  };

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", createBashGuardHandler(process.env));
}
