/**
 * plan-mode 的护栏阶段。控制器是有状态的（当前阶段、评审闸门、内部调用豁免），
 * 所以这里只做一层适配：把流水线的一次调用翻成控制器认识的 ToolCallEvent，
 * 判决本身仍由控制器的 maybeBlockTool 决定。
 */

import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { deny, type GuardStage, PASS } from "../shared/guard-pipeline.ts";
import type { PlanModeController } from "./controller.ts";

export const createPlanModeGuardStage = (
  controller: PlanModeController,
): GuardStage => ({
  id: "plan-mode",
  kind: "deny",
  evaluate: (call, env) => {
    // 控制器只读 toolName 与 input；其余字段由 pi 在真实事件里给。
    const event = {
      toolName: call.toolName,
      input: call.input,
    } as ToolCallEvent;
    const blocked = controller.maybeBlockTool(event, env.ctx);
    return blocked ? deny("plan-mode", blocked.reason) : PASS;
  },
});
