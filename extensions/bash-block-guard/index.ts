import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  deny,
  type GuardStage,
  installGuardPipeline,
  PASS,
  registerGuard,
} from "../shared/guard-pipeline.ts";
import { decideBashGuard, readBashCall, resolveLimits } from "./guard.ts";

/** 流水线阶段：拦住会让会话静默等待的 bash 调用。 */
export const bashBlockGuardStage: GuardStage = {
  id: "bash-block-guard",
  kind: "deny",
  evaluate: (call, env) => {
    const bash = readBashCall(call.toolName, call.input);
    if (!bash) return PASS;
    const decision = decideBashGuard(bash, resolveLimits(env.env));
    return decision.action === "allow"
      ? PASS
      : deny(decision.rule, decision.reason);
  },
};

export default function (pi: ExtensionAPI) {
  registerGuard(bashBlockGuardStage);
  installGuardPipeline(pi);
}
