import type {
  ActivePlanReview,
  ManualReviewVerdict,
  PendingPlanReview,
  SessionKeyContext,
} from "./plan-review/types.ts";
import type { ReviewHostMode } from "./terminal-browser.ts";

type PendingPlanReviewEventHandle = {
  markHandled: () => void;
};

export type SessionReviewDocument = {
  absolutePath: string;
  mtimeMs: number;
  updatedAt: number;
};

export type SessionRuntimeState = {
  activePlanReviewByCwd: Map<string, ActivePlanReview>;
  settledPlanReviewPaths: Set<string>;
  pendingPlanReviewEventsByCwd: Map<
    string,
    Map<string, PendingPlanReviewEventHandle>
  >;
  pendingPlanReviewGateKeysByCwd: Map<string, string>;
  pendingPlanReviewTargetsByCwd: Map<string, Map<string, PendingPlanReview>>;
  /** Manual verdicts awaiting collection by the auto submit tool, keyed by cwd then path. */
  manualReviewVerdictsByCwd: Map<string, Map<string, ManualReviewVerdict>>;
  /**
   * Documents reviewed by hand this session, keyed by cwd. A manual review
   * covers the whole `.pi/` tree, so it also makes an unconventional document
   * (e.g. `.pi/research/…`) a review target that later writes re-queue.
   */
  manuallyReviewedPathsByCwd: Map<string, Set<string>>;
  toolArgsByCallId: Map<string, unknown>;
  reviewDocumentsByCwd: Map<string, Map<string, SessionReviewDocument>>;
  /** Markdown review hosting: regular browser (default) or Herdr panel (temporary toggle). */
  reviewHostMode: ReviewHostMode;
};

const sessionRuntimeState = new Map<string, SessionRuntimeState>();
const sessionContextByKey = new Map<string, unknown>();

const createSessionRuntimeState = (): SessionRuntimeState => ({
  pendingPlanReviewEventsByCwd: new Map(),
  pendingPlanReviewGateKeysByCwd: new Map(),
  pendingPlanReviewTargetsByCwd: new Map(),
  manualReviewVerdictsByCwd: new Map(),
  manuallyReviewedPathsByCwd: new Map(),
  toolArgsByCallId: new Map<string, unknown>(),
  reviewDocumentsByCwd: new Map(),
  activePlanReviewByCwd: new Map(),
  settledPlanReviewPaths: new Set(),
  reviewHostMode: "browser",
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
