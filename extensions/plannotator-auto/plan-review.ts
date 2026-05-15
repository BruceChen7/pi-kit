import fs from "node:fs";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  formatArtifactPolicyFailure,
  isStandardMarkdownPlanArtifactPath,
  validateArtifactPolicy,
} from "../plan-mode/artifact-policy.ts";
import {
  createHandledState,
  type PiKitPlannotatorPendingReviewEvent,
  PLANNOTATOR_PENDING_REVIEW_CHANNEL,
} from "../shared/internal-events.ts";
import {
  runPlannotatorAnnotateCli,
  runPlannotatorPlanReviewCli,
} from "./cli.ts";
import { extractBashPathCandidates, resolveToolPath } from "./helpers.ts";
import { isHtmlPath, resolveReviewTargetMatch } from "./paths.ts";
import type { PendingPlanReview, PlanFileConfig } from "./plan-review/types.ts";
import { getSessionState, type SessionRuntimeState } from "./session.ts";

const KEEP_PLAN_HEADING_GUIDANCE =
  "Keep the first # heading unchanged unless the reviewer explicitly asks you " +
  "to rename the plan; Plannotator uses that heading to show version diffs.";
const PLAN_REVIEW_SUBMIT_TOOL = "plannotator_auto_submit_review";
const REVIEW_WIDGET_KEY = "plannotator-auto-review";
const SYNC_PLANNOTATOR_TIMEOUT_MS = 4 * 60 * 60 * 1_000;

type PendingPlanReviewEventHandle = {
  markHandled: () => void;
};

type PlanReviewSubmitToolParams = {
  path?: unknown;
};

type PlanReviewDecisionLike = {
  approved?: boolean;
  feedback?: string;
};

const getPendingPlanReviewTargets = (
  state: SessionRuntimeState,
  cwd: string,
): Map<string, PendingPlanReview> => {
  const existing = state.pendingPlanReviewTargetsByCwd.get(cwd);
  if (existing) {
    return existing;
  }

  const next = new Map<string, PendingPlanReview>();
  state.pendingPlanReviewTargetsByCwd.set(cwd, next);
  return next;
};

const findPendingPlanReviewTargets = (
  state: SessionRuntimeState,
  cwd: string,
): Map<string, PendingPlanReview> | undefined =>
  state.pendingPlanReviewTargetsByCwd.get(cwd);

export const listPendingPlanReviews = (
  state: SessionRuntimeState,
  cwd: string,
): PendingPlanReview[] => {
  const pendingTargets = findPendingPlanReviewTargets(state, cwd);
  return pendingTargets ? Array.from(pendingTargets.values()) : [];
};

const formatPendingPlanArtifactPolicyFailure = (
  pendingPlanReview: PendingPlanReview,
  planContent: string,
): string | null => {
  if (!isStandardMarkdownPlanArtifactPath(pendingPlanReview.planFile)) {
    return null;
  }

  const result = validateArtifactPolicy({
    path: pendingPlanReview.planFile,
    content: planContent,
  });
  if (result.approved) {
    return null;
  }

  return formatArtifactPolicyFailure(pendingPlanReview.planFile, result.issues);
};

const getReviewWidgetMessage = (
  state: SessionRuntimeState,
  cwd: string,
): string | null => {
  const planReviewActive = state.activePlanReviewByCwd.has(cwd);
  const codeReviewActive =
    state.reviewInFlight || state.activeCodeReviewByCwd.has(cwd);

  if (planReviewActive && codeReviewActive) {
    return "Plan/Spec/Code review is active";
  }

  if (planReviewActive) {
    return "Plan/Spec review is active";
  }

  if (codeReviewActive) {
    return "Code review is active";
  }

  return null;
};

export const setReviewWidget = (ctx: ExtensionContext): void => {
  if (!ctx.hasUI) {
    return;
  }

  const ui = ctx.ui as {
    setWidget?: (
      key: string,
      content?: unknown,
      options?: {
        placement?: "belowEditor";
      },
    ) => void;
    theme?: {
      fg?: (tone: string, text: string) => string;
    };
  };

  if (typeof ui.setWidget !== "function") {
    return;
  }

  const state = getSessionState(ctx);
  const message = getReviewWidgetMessage(state, ctx.cwd);
  if (!message) {
    ui.setWidget(REVIEW_WIDGET_KEY, undefined);
    return;
  }

  const line =
    typeof ui.theme?.fg === "function"
      ? ui.theme.fg("warning", message)
      : message;
  ui.setWidget(REVIEW_WIDGET_KEY, [line], { placement: "belowEditor" });
};

export const clearReviewWidget = (ctx: ExtensionContext): void => {
  if (!ctx.hasUI) {
    return;
  }

  const ui = ctx.ui as {
    setWidget?: (key: string, content?: unknown) => void;
  };
  if (typeof ui.setWidget !== "function") {
    return;
  }

  ui.setWidget(REVIEW_WIDGET_KEY, undefined);
};

const formatPendingPlanReviewGateMessage = (planFiles: string[]): string =>
  `You still have pending Plannotator review drafts:\n- ${planFiles.join("\n- ")}\n\nCall ${PLAN_REVIEW_SUBMIT_TOOL} with one of these paths before continuing.`;

const formatPendingPlanReviewPrompt = (planFiles: string[]): string =>
  `[PLANNOTATOR AUTO - PENDING REVIEW]\nPending review targets:\n- ${planFiles.join("\n- ")}\n\nYour next required action is calling ${PLAN_REVIEW_SUBMIT_TOOL} with one pending path. If a review is denied, revise that same file and call ${PLAN_REVIEW_SUBMIT_TOOL} again. ${KEEP_PLAN_HEADING_GUIDANCE}`;

const getPendingPlanReviewEvents = (
  state: SessionRuntimeState,
  cwd: string,
): Map<string, PendingPlanReviewEventHandle> => {
  const existing = state.pendingPlanReviewEventsByCwd.get(cwd);
  if (existing) {
    return existing;
  }

  const next = new Map<string, PendingPlanReviewEventHandle>();
  state.pendingPlanReviewEventsByCwd.set(cwd, next);
  return next;
};

const markPendingPlanReviewEventsHandled = (
  state: SessionRuntimeState,
  cwd: string,
  resolvedPlanPaths: Iterable<string>,
): void => {
  const eventsByPath = state.pendingPlanReviewEventsByCwd.get(cwd);
  if (!eventsByPath) {
    return;
  }

  for (const resolvedPlanPath of resolvedPlanPaths) {
    eventsByPath.get(resolvedPlanPath)?.markHandled();
    eventsByPath.delete(resolvedPlanPath);
  }

  if (eventsByPath.size === 0) {
    state.pendingPlanReviewEventsByCwd.delete(cwd);
  }
};

const trackPendingPlanReviewEvent = (
  state: SessionRuntimeState,
  cwd: string,
  pendingPlanReviews: PendingPlanReview[],
  handled: PendingPlanReviewEventHandle,
): void => {
  const eventsByPath = getPendingPlanReviewEvents(state, cwd);
  for (const pending of pendingPlanReviews) {
    eventsByPath.get(pending.resolvedPlanPath)?.markHandled();
    eventsByPath.set(pending.resolvedPlanPath, handled);
  }
};

const emitPendingPlanReviewEvent = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: SessionRuntimeState,
  pendingPlanReviews: PendingPlanReview[],
): void => {
  const planFiles = pendingPlanReviews.map((pending) => pending.planFile);
  const body = formatPendingPlanReviewGateMessage(planFiles);
  const handled = createHandledState();
  trackPendingPlanReviewEvent(state, ctx.cwd, pendingPlanReviews, handled);

  pi.events.emit(PLANNOTATOR_PENDING_REVIEW_CHANNEL, {
    type: "plannotator-auto.pending-review",
    requestId: `plannotator_pending_review_${Date.now()}`,
    createdAt: Date.now(),
    title: "Plannotator review pending",
    body,
    planFiles,
    contextPreview: [body],
    fullContextLines: [body],
    continueEnabled: true,
    handled,
    ctx,
  } satisfies PiKitPlannotatorPendingReviewEvent);
};

const getPendingPlanReviewGateKey = (
  pendingPlanReviews: PendingPlanReview[],
): string =>
  pendingPlanReviews
    .map((pending) => pending.resolvedPlanPath)
    .sort((left, right) => left.localeCompare(right))
    .join("\0");

const notifyPendingPlanReviewGate = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: SessionRuntimeState,
  pendingPlanReviews: PendingPlanReview[],
): void => {
  if (pendingPlanReviews.length === 0) {
    return;
  }

  const gateKey = getPendingPlanReviewGateKey(pendingPlanReviews);
  if (state.pendingPlanReviewGateKeysByCwd.get(ctx.cwd) === gateKey) {
    return;
  }

  state.pendingPlanReviewGateKeysByCwd.set(ctx.cwd, gateKey);
  emitPendingPlanReviewEvent(pi, ctx, state, pendingPlanReviews);
};

export const getGateablePendingPlanReviews = (
  state: SessionRuntimeState,
  cwd: string,
): PendingPlanReview[] => {
  if (state.activePlanReviewByCwd.has(cwd)) {
    return [];
  }

  return listPendingPlanReviews(state, cwd);
};

export const isPlanReviewSettled = (
  state: SessionRuntimeState,
  cwd: string,
): boolean =>
  !state.activePlanReviewByCwd.has(cwd) &&
  (findPendingPlanReviewTargets(state, cwd)?.size ?? 0) === 0;

const queuePlanReviewForToolPath = (
  ctx: ExtensionContext,
  planConfig: PlanFileConfig,
  toolPath: string,
): boolean => {
  const state = getSessionState(ctx);
  const targetPath = path.resolve(ctx.cwd, toolPath);
  if (state.settledPlanReviewPaths.has(targetPath)) {
    return false;
  }

  const reviewTarget = resolveReviewTargetMatch(ctx, planConfig, targetPath);
  if (!reviewTarget) {
    return false;
  }

  const pendingPlanReview = {
    kind: reviewTarget.kind,
    planFile: reviewTarget.reviewFile,
    resolvedPlanPath: targetPath,
    updatedAt: Date.now(),
  };
  getPendingPlanReviewTargets(state, ctx.cwd).set(
    pendingPlanReview.resolvedPlanPath,
    pendingPlanReview,
  );
  return true;
};

export const handlePlanFileWrite = (
  ctx: ExtensionContext,
  args: unknown,
  planConfig: PlanFileConfig | null,
): boolean => {
  if (!planConfig) {
    return false;
  }

  const toolPath = resolveToolPath(args);
  if (!toolPath) {
    return false;
  }

  return queuePlanReviewForToolPath(ctx, planConfig, toolPath);
};

export const handleBashPlanFileWrites = (
  ctx: ExtensionContext,
  args: unknown,
  planConfig: PlanFileConfig | null,
): boolean => {
  if (!planConfig) {
    return false;
  }

  let queued = false;
  for (const toolPath of extractBashPathCandidates(args)) {
    if (queuePlanReviewForToolPath(ctx, planConfig, toolPath)) {
      queued = true;
    }
  }

  return queued;
};

const clearPendingPlanReviewTarget = (
  state: SessionRuntimeState,
  cwd: string,
  pendingPlanReviews: Map<string, PendingPlanReview>,
  resolvedPlanPath: string,
): void => {
  pendingPlanReviews.delete(resolvedPlanPath);
  if (pendingPlanReviews.size > 0) {
    return;
  }

  state.pendingPlanReviewGateKeysByCwd.delete(cwd);
  state.pendingPlanReviewTargetsByCwd.delete(cwd);
};

const approvePendingPlanReview = (
  state: SessionRuntimeState,
  cwd: string,
  pendingPlanReviews: Map<string, PendingPlanReview>,
  pendingPlanReview: PendingPlanReview,
) => {
  state.settledPlanReviewPaths.add(pendingPlanReview.resolvedPlanPath);
  clearPendingPlanReviewTarget(
    state,
    cwd,
    pendingPlanReviews,
    pendingPlanReview.resolvedPlanPath,
  );
  markPendingPlanReviewEventsHandled(state, cwd, [
    pendingPlanReview.resolvedPlanPath,
  ]);

  return {
    content: [
      {
        type: "text" as const,
        text: `Review approved for ${pendingPlanReview.planFile}.`,
      },
    ],
    details: { status: "approved" },
  };
};

const denyPendingPlanReview = (
  pendingPlanReview: PendingPlanReview,
  feedback?: string,
) => ({
  content: [
    {
      type: "text" as const,
      text: `YOUR REVIEW WAS NOT APPROVED. Revise ${pendingPlanReview.planFile} and call ${PLAN_REVIEW_SUBMIT_TOOL} again after addressing this feedback. ${KEEP_PLAN_HEADING_GUIDANCE}\n\n${feedback || "Review changes requested."}`,
    },
  ],
  details: { status: "denied" },
});

const completePendingPlanReview = (
  ctx: ExtensionContext,
  state: SessionRuntimeState,
  pendingPlanReviews: Map<string, PendingPlanReview>,
  pendingPlanReview: PendingPlanReview,
  result: PlanReviewDecisionLike,
) => {
  setReviewWidget(ctx);
  if (result.approved) {
    return approvePendingPlanReview(
      state,
      ctx.cwd,
      pendingPlanReviews,
      pendingPlanReview,
    );
  }

  return denyPendingPlanReview(pendingPlanReview, result.feedback);
};

export const notifyPendingReviewGateIfNeeded = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: SessionRuntimeState,
  queuedPlanReview: boolean,
): void => {
  const pendingPlanReviews = getGateablePendingPlanReviews(state, ctx.cwd);
  if (queuedPlanReview && pendingPlanReviews.length > 0) {
    notifyPendingPlanReviewGate(pi, ctx, state, pendingPlanReviews);
  }
};

export const createPendingReviewGateMessage = (
  ctx: ExtensionContext,
):
  | { message: { customType: string; content: string; display: boolean } }
  | undefined => {
  const pendingPlanReviews = getGateablePendingPlanReviews(
    getSessionState(ctx),
    ctx.cwd,
  );
  if (pendingPlanReviews.length === 0) {
    return undefined;
  }

  return {
    message: {
      customType: "plannotator-auto-pending-review",
      content: formatPendingPlanReviewPrompt(
        pendingPlanReviews.map((pending) => pending.planFile),
      ),
      display: false,
    },
  };
};

export const registerPlanReviewSubmitTool = (
  pi: ExtensionAPI,
  planReviewSubmitToolParameters: Record<string, unknown>,
): void => {
  pi.registerTool({
    name: PLAN_REVIEW_SUBMIT_TOOL,
    label: "Submit Plannotator Auto Review",
    description:
      "Submit a pending plan/spec/extra review target to Plannotator and wait for approval or feedback.",
    parameters: planReviewSubmitToolParameters,
    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      const params = rawParams as PlanReviewSubmitToolParams;
      const state = getSessionState(ctx);
      const pendingPlanReviews = findPendingPlanReviewTargets(state, ctx.cwd);
      if (!pendingPlanReviews || pendingPlanReviews.size === 0) {
        return {
          content: [
            {
              type: "text",
              text: "Error: there is no pending Plannotator review draft in this session.",
            },
          ],
          details: { status: "error" },
        };
      }

      const requestedPathValue = params.path;
      const requestedPath =
        typeof requestedPathValue === "string"
          ? path.resolve(ctx.cwd, requestedPathValue)
          : null;
      const pendingPlanReview = requestedPath
        ? pendingPlanReviews.get(requestedPath)
        : undefined;
      if (!pendingPlanReview) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${String(requestedPathValue ?? "") || "<missing path>"} is not a pending Plannotator review target. Pending paths:\n- ${Array.from(
                pendingPlanReviews.values(),
              )
                .map((pending) => pending.planFile)
                .join("\n- ")}`,
            },
          ],
          details: { status: "error" },
        };
      }

      if (state.activePlanReviewByCwd.has(ctx.cwd)) {
        return {
          content: [
            {
              type: "text",
              text: `Error: a Plannotator review is already active for ${pendingPlanReview.planFile}.`,
            },
          ],
          details: { status: "error" },
        };
      }

      let planContent = "";
      try {
        planContent = fs.readFileSync(
          pendingPlanReview.resolvedPlanPath,
          "utf-8",
        );
      } catch {
        return {
          content: [
            {
              type: "text",
              text: `Error: could not read ${pendingPlanReview.planFile} before submitting review.`,
            },
          ],
          details: { status: "error" },
        };
      }

      const policyFailure = formatPendingPlanArtifactPolicyFailure(
        pendingPlanReview,
        planContent,
      );
      if (policyFailure) {
        return {
          content: [
            {
              type: "text",
              text: policyFailure,
            },
          ],
          details: { status: "error", reason: "artifact-policy" },
        };
      }

      const renderHtml = isHtmlPath(pendingPlanReview.resolvedPlanPath);
      state.activePlanReviewByCwd.set(ctx.cwd, {
        reviewId: `cli:${Date.now()}`,
        kind: pendingPlanReview.kind,
        planFile: pendingPlanReview.planFile,
        resolvedPlanPath: pendingPlanReview.resolvedPlanPath,
        startedAt: Date.now(),
        origin: "manual-submit",
      });
      setReviewWidget(ctx);

      try {
        const cliResult = renderHtml
          ? await runPlannotatorAnnotateCli(
              ctx,
              pendingPlanReview.resolvedPlanPath,
              {
                gate: true,
                renderHtml,
                signal,
                timeoutMs: SYNC_PLANNOTATOR_TIMEOUT_MS,
              },
            )
          : await runPlannotatorPlanReviewCli(ctx, planContent, {
              signal,
              timeoutMs: SYNC_PLANNOTATOR_TIMEOUT_MS,
            });

        if (cliResult.status === "error") {
          return {
            content: [
              {
                type: "text",
                text: cliResult.error,
              },
            ],
            details: { status: "error" },
          };
        }
        if (cliResult.status === "aborted") {
          return {
            content: [
              {
                type: "text",
                text: "Plannotator review interrupted.",
              },
            ],
            details: { status: "aborted" },
          };
        }

        return completePendingPlanReview(
          ctx,
          state,
          pendingPlanReviews,
          pendingPlanReview,
          cliResult.result,
        );
      } finally {
        state.activePlanReviewByCwd.delete(ctx.cwd);
        setReviewWidget(ctx);
      }
    },
  });
};
