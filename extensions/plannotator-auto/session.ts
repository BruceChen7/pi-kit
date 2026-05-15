import type {
  ActivePlanReview,
  PendingPlanReview,
  SessionKeyContext,
} from "./plan-review/types.ts";

type PendingPlanReviewEventHandle = {
  markHandled: () => void;
};

type ActiveCodeReview = {
  requestKey: string;
  startedAt: number;
};

export type SessionReviewDocument = {
  absolutePath: string;
  mtimeMs: number;
  updatedAt: number;
};

export type SessionRuntimeState = {
  activePlanReviewByCwd: Map<string, ActivePlanReview>;
  settledPlanReviewPaths: Set<string>;
  plannotatorUnavailableNotified: boolean;
  pendingPlanReviewEventsByCwd: Map<
    string,
    Map<string, PendingPlanReviewEventHandle>
  >;
  pendingPlanReviewGateKeysByCwd: Map<string, string>;
  pendingPlanReviewTargetsByCwd: Map<string, Map<string, PendingPlanReview>>;
  toolArgsByCallId: Map<string, unknown>;
  reviewDocumentsByCwd: Map<string, Map<string, SessionReviewDocument>>;
  pendingReviewByCwd: Set<string>;
  activeCodeReviewByCwd: Map<string, ActiveCodeReview>;
  pendingReviewRetry: ReturnType<typeof setTimeout> | null;
  reviewInFlight: boolean;
};

const sessionRuntimeState = new Map<string, SessionRuntimeState>();
const sessionContextByKey = new Map<string, unknown>();

const createSessionRuntimeState = (): SessionRuntimeState => ({
  pendingPlanReviewEventsByCwd: new Map(),
  pendingPlanReviewGateKeysByCwd: new Map(),
  pendingPlanReviewTargetsByCwd: new Map(),
  toolArgsByCallId: new Map<string, unknown>(),
  reviewDocumentsByCwd: new Map(),
  activePlanReviewByCwd: new Map(),
  settledPlanReviewPaths: new Set(),
  plannotatorUnavailableNotified: false,
  pendingReviewByCwd: new Set<string>(),
  activeCodeReviewByCwd: new Map<string, ActiveCodeReview>(),
  pendingReviewRetry: null,
  reviewInFlight: false,
});

export const getSessionKey = (ctx: {
  cwd: string;
  sessionManager: { getSessionFile: () => string | null | undefined };
}): string => ctx.sessionManager.getSessionFile() ?? `${ctx.cwd}::ephemeral`;

export const getSessionState = (
  ctx: SessionKeyContext,
): SessionRuntimeState => {
  const key = getSessionKey(ctx);
  const cached = sessionRuntimeState.get(key);
  if (cached) {
    return cached;
  }

  const next = createSessionRuntimeState();
  sessionRuntimeState.set(key, next);
  return next;
};

export const clearSessionState = (sessionKey: string): void => {
  const state = sessionRuntimeState.get(sessionKey);
  if (!state) {
    return;
  }

  if (state.pendingReviewRetry) {
    clearTimeout(state.pendingReviewRetry);
  }

  sessionRuntimeState.delete(sessionKey);
};

export const getSessionContextByKey = <T>(): Map<string, T> =>
  sessionContextByKey as Map<string, T>;

export const setSessionContext = (sessionKey: string, ctx: unknown): void => {
  sessionContextByKey.set(sessionKey, ctx);
};

export const clearSessionContext = (sessionKey: string): void => {
  sessionContextByKey.delete(sessionKey);
};
