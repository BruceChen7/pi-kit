import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  deny,
  type GuardStage,
  installGuardPipeline,
  PASS,
  registerGuard,
} from "../shared/guard-pipeline.ts";
import { decideBashGuard, readBashCall, resolveLimits } from "./guard.ts";

type ToolCallHandler = (event: {
  toolName: string;
  input: unknown;
}) => { block: true; reason: string } | undefined;

/**
 * 单护栏的旧入口：判定逻辑原样保留，给只测这一个护栏的用例用。
 * 真正生效的是下面的 stage —— 它和别的护栏一起进流水线，顺序由流水线定。
 */
export const createBashGuardHandler =
  (env: Record<string, string | undefined>): ToolCallHandler =>
  (event) => {
    const decision = decideBashGuardFor(event.toolName, event.input, env);
    if (decision.action === "allow") {
      return undefined;
    }
    return { block: true, reason: decision.reason };
  };

const decideBashGuardFor = (
  toolName: string,
  input: unknown,
  env: Record<string, string | undefined>,
) => {
  const call = readBashCall(toolName, input);
  if (!call) {
    return { action: "allow" as const };
  }
  return decideBashGuard(call, resolveLimits(env));
};

/** 流水线阶段：拦住会让会话静默等待的 bash 调用。 */
export const bashBlockGuardStage: GuardStage = {
  id: "bash-block-guard",
  kind: "deny",
  evaluate: (call, env) => {
    const decision = decideBashGuardFor(call.toolName, call.input, env.env);
    if (decision.action === "allow") {
      return PASS;
    }
    return deny(decision.rule, decision.reason);
  },
};

export default function (pi: ExtensionAPI) {
  registerGuard(bashBlockGuardStage);
  installGuardPipeline(pi);
}
