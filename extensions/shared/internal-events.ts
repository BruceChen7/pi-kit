export const NOTIFY_IDLE_CHANNEL = "pi-kit:notify:idle";
export const SAFE_DELETE_APPROVAL_CHANNEL = "pi-kit:safe-delete:approval";
export const AGENT_END_CODE_SIMPLIFIER_APPROVAL_CHANNEL =
  "pi-kit:agent-end-code-simplifier:approval";
export const PLANNOTATOR_PENDING_REVIEW_CHANNEL =
  "pi-kit:plannotator-auto:pending-review";

export type HandledState = {
  isHandled: () => boolean;
  markHandled: () => void;
};

export const createHandledState = (): HandledState => {
  let handled = false;
  return {
    isHandled: () => handled,
    markHandled: () => {
      handled = true;
    },
  };
};

export type PiKitNotifyIdleEvent = {
  type: "notify.idle";
  requestId: string;
  createdAt: number;
  title: string;
  body: string;
  contextPreview: string[];
  fullContextLines: string[];
  continueEnabled: boolean;
  handled: HandledState;
  ctx: unknown;
};

export type PiKitSafeDeleteApprovalEvent = {
  type: "safe-delete.approval";
  requestId: string;
  createdAt: number;
  command: string;
  title: string;
  body: string;
  contextPreview: string[];
  fullContextLines: string[];
  localDecision: Promise<boolean>;
  attachRemoteDecision: (decision: Promise<boolean>) => void;
  ctx: unknown;
};

export type PiKitAgentEndCodeSimplifierApprovalEvent = {
  type: "agent-end-code-simplifier.approval";
  requestId: string;
  createdAt: number;
  title: string;
  body: string;
  filePaths: string[];
  contextPreview: string[];
  fullContextLines: string[];
  localDecision: Promise<boolean>;
  attachRemoteDecision: (decision: Promise<boolean>) => void;
  ctx: unknown;
};

export type PiKitPlannotatorPendingReviewEvent = {
  type: "plannotator-auto.pending-review";
  requestId: string;
  createdAt: number;
  title: string;
  body: string;
  planFiles: string[];
  contextPreview: string[];
  fullContextLines: string[];
  continueEnabled: boolean;
  handled: HandledState;
  ctx: unknown;
};
