export const NOTIFY_IDLE_CHANNEL = "pi-kit:notify:idle";
export const SAFE_DELETE_APPROVAL_CHANNEL = "pi-kit:safe-delete:approval";
export const PLANNOTATOR_PENDING_REVIEW_CHANNEL =
  "pi-kit:plannotator-auto:pending-review";
export const PLANNOTATOR_REVIEW_VERDICT_CHANNEL =
  "pi-kit:plannotator-auto:review-verdict";
export const PLAN_MODE_BADGE_CHANNEL = "pi-kit:plan-mode:badge";

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
  localDecision?: Promise<boolean>;
  attachRemoteDecision: (decision: Promise<boolean>) => void;
  ctx: unknown;
};

/**
 * A decided manual review (picker / annotate-latest), broadcast so approval
 * state can follow the reviewer's verdict without the agent re-submitting.
 * Only definite verdicts are broadcast: no verdict → no state transition.
 */
export type PiKitPlannotatorReviewVerdictEvent = {
  type: "plannotator-auto.review-verdict";
  requestId: string;
  createdAt: number;
  cwd: string;
  /** Repo-relative path with `/` separators, the shape plan-mode stores. */
  path: string;
  approved: boolean;
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

/**
 * 一串要挂在 plan-mode footer 上的短标签。
 *
 * 生产方只管广播自己的状态，渲染方（plan-mode）负责拼接与清空：
 * `text: null` 表示撤下这个 key。事件总线没有返回值，所以没有 ack；
 * 没装 plan-mode 时广播会丢掉，各扩展自己的读取命令仍是权威读法。
 */
export type PiKitPlanModeBadgeEvent = {
  type: "plan-mode.badge";
  ctx: unknown;
  /** 生产方所在 cwd；渲染方按此过滤，避免跨仓污染。 */
  cwd: string;
  /** 同一个 key 后写覆盖前写。 */
  key: string;
  text: string | null;
};
