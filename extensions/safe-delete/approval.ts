/**
 * safe-delete 的人机确认（Imperative Shell）。
 *
 * 本地对话框与远程审批事件在同一个请求里竞争：谁先有结论谁生效，远程赢了就
 * 取消本地对话框，避免留下一个没人关的确认框。
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  type PiKitSafeDeleteApprovalEvent,
  SAFE_DELETE_APPROVAL_CHANNEL,
} from "../shared/internal-events.ts";

export type ApprovalRaceInput = {
  localDecision: Promise<boolean>;
  remoteDecisions: Array<Promise<boolean>>;
  localAbortController: AbortController;
};

export async function waitForApprovalDecision({
  localDecision,
  remoteDecisions,
  localAbortController,
}: ApprovalRaceInput): Promise<boolean> {
  if (remoteDecisions.length === 0) {
    return await localDecision;
  }

  const result = await Promise.race([
    localDecision.then((decision) => ({ decision, source: "local" as const })),
    Promise.race(remoteDecisions).then((decision) => ({
      decision,
      source: "remote" as const,
    })),
  ]);

  if (result.source === "remote") {
    localAbortController.abort();
  }

  return result.decision;
}

export type ApprovalRequest = {
  title: string;
  body: string;
  /** Legacy field name of the approval event; a one-line handle for the request. */
  command: string;
};

/**
 * 一次审批的副作用：本地对话框 + 其他 pi-kit 宿主上的远程审批事件。
 */
export async function requestApproval(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  request: ApprovalRequest,
): Promise<boolean> {
  const localAbortController = new AbortController();
  const localDecision = ctx.ui.confirm(request.title, request.body, {
    signal: localAbortController.signal,
  });
  const remoteDecisions: Array<Promise<boolean>> = [];
  pi.events.emit(SAFE_DELETE_APPROVAL_CHANNEL, {
    type: "safe-delete.approval",
    requestId: `safe_delete_${Date.now()}`,
    createdAt: Date.now(),
    command: request.command,
    title: request.title,
    body: request.body,
    contextPreview: [],
    fullContextLines: [],
    localDecision,
    attachRemoteDecision: (decision: Promise<boolean>) => {
      remoteDecisions.push(decision);
    },
    ctx,
  } satisfies PiKitSafeDeleteApprovalEvent);

  return await waitForApprovalDecision({
    localDecision,
    remoteDecisions,
    localAbortController,
  });
}
