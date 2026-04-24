export const NOTIFY_IDLE_CHANNEL = "pi-kit:notify:idle";
export const SAFE_DELETE_APPROVAL_CHANNEL = "pi-kit:safe-delete:approval";

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
