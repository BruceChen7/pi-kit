import fs from "node:fs";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import {
  formatArtifactPolicyFailure,
  isStandardMarkdownPlanArtifactPath,
  validateArtifactPolicy,
} from "../plan-mode/artifact-policy.ts";
import { PLAN_SUBMIT_CHECKLIST } from "../plan-mode/guidance.ts";
import {
  createHandledState,
  type PiKitPlannotatorPendingReviewEvent,
  PLANNOTATOR_PENDING_REVIEW_CHANNEL,
} from "../shared/internal-events.ts";
import { createLogger } from "../shared/logger.ts";
import { resolveHtmlReviewDirs } from "../shared/review-targets.ts";
import { pathsFromToolArgs } from "../shared/tool-targets.ts";
import {
  type CliReviewDecision,
  runPlannotatorAnnotateCli,
  runPlannotatorPlanReviewCli,
} from "./cli.ts";
import { extractBashPathCandidates } from "./helpers.ts";
import {
  formatPlanMermaidErrors,
  runPlanMermaidValidation,
} from "./mermaid-validator.ts";
import {
  isAutoReviewTarget,
  isHtmlPath,
  resolveReviewTargetMatch,
  toRepoRelativePath,
} from "./paths.ts";
import type {
  ManualReviewStatus,
  ManualReviewVerdict,
  PendingPlanReview,
} from "./plan-review/types.ts";
import { getSessionState, type SessionRuntimeState } from "./session.ts";

const KEEP_PLAN_HEADING_GUIDANCE =
  "Keep the first # heading unchanged unless the reviewer explicitly asks you " +
  "to rename the plan; Plannotator uses that heading to show version diffs.";
const MERMAID_RENDERING_GUIDANCE =
  "If the document contains Mermaid, use only ```mermaid fenced blocks (never ~~~), keep fences paired and non-empty, use language tag 'mermaid' only (not mmd/mermaidjs), prefer simple graph/flowchart syntax, and if correctness is uncertain, replace the diagram with plain Markdown bullets before submitting.";
const PLAN_REVIEW_SUBMIT_TOOL = "plannotator_auto_submit_review";
const REVIEW_WIDGET_KEY = "plannotator-auto-review";
const SYNC_PLANNOTATOR_TIMEOUT_MS = 4 * 60 * 60 * 1_000;

/**
 * Markdown-only guidance appended to pending-review gate messages. HTML
 * artifacts skip it: they have no `# heading` and no ```mermaid fenced
 * blocks, so the guidance would actively mislead agents.
 */
const formatMarkdownReviewGuidance = (): string =>
  [
    ` ${KEEP_PLAN_HEADING_GUIDANCE} ${MERMAID_RENDERING_GUIDANCE}`,
    ...PLAN_SUBMIT_CHECKLIST,
  ].join("\n");

const log = createLogger("plannotator-auto", { stderr: null });

type PendingPlanReviewEventHandle = {
  markHandled: () => void;
};

type PlanReviewSubmitToolParams = {
  path?: unknown;
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

export const preprocessPlanMarkdown = (markdown: string): string =>
  markdown.replace(
    /(^|\n)~~~\s*mermaid([^\n]*)\n([\s\S]*?)\n~~~(?=\n|$)/gi,
    (_m, prefix: string, suffix: string, body: string) =>
      `${prefix}\n\`\`\`mermaid${suffix}\n${body}\n\`\`\``,
  );

const getReviewWidgetMessage = (
  state: SessionRuntimeState,
  cwd: string,
): string | null => {
  const planReviewActive = state.activePlanReviewByCwd.get(cwd);
  if (!planReviewActive) {
    return null;
  }

  return isHtmlPath(planReviewActive.resolvedPlanPath)
    ? "HTML review is active"
    : `Plan/Spec review is active · host: ${
        state.reviewHostMode === "herdr-panel" ? "herdr-panel" : "browser"
      }`;
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

const formatPlanFileBulletList = (planFiles: string[]): string =>
  `- ${planFiles.join("\n- ")}`;

export type ReviewGuidance = {
  heading: string;
  guidance: string;
  deniedAction: string;
};

/**
 * Pure decision: which gate-message pieces apply to a set of pending review
 * targets. Markdown plans and HTML artifacts get different headings and
 * guidance; a mixed set must keep the markdown guidance (the pre-submit
 * checklist) instead of dropping it whenever any HTML target is present.
 */
export const selectReviewGuidance = (
  targets: readonly string[],
): ReviewGuidance => {
  const hasHtml = targets.some((file) => isHtmlPath(file));
  const hasMarkdown = targets.some((file) => !isHtmlPath(file));
  return {
    heading: hasHtml
      ? "[PLANNOTATOR REVIEW - PENDING]"
      : "[PLANNOTATOR AUTO - PENDING REVIEW]",
    guidance: hasMarkdown ? formatMarkdownReviewGuidance() : "",
    deniedAction: hasMarkdown
      ? `If a review is denied, revise that same file and call ${PLAN_REVIEW_SUBMIT_TOOL} again.`
      : `If the user sends feedback, revise the artifact and call ${PLAN_REVIEW_SUBMIT_TOOL} again.`,
  };
};

const formatPendingPlanReviewGateMessage = (planFiles: string[]): string => {
  const targets = formatPlanFileBulletList(planFiles);
  const { heading, guidance } = selectReviewGuidance(planFiles);
  return [
    heading,
    "You still have pending review drafts:",
    targets,
    `Call ${PLAN_REVIEW_SUBMIT_TOOL} with one of these paths before continuing.${guidance}`,
  ].join("\n\n");
};

const formatPendingPlanReviewPrompt = (planFiles: string[]): string => {
  const targets = formatPlanFileBulletList(planFiles);
  const {
    heading,
    guidance: markdownGuidance,
    deniedAction,
  } = selectReviewGuidance(planFiles);
  const nextAction =
    `Your next required action is calling ${PLAN_REVIEW_SUBMIT_TOOL} ` +
    "with one pending path.";

  return [
    heading,
    "Pending review targets:",
    targets,
    `${nextAction} ${deniedAction}${markdownGuidance}`,
  ].join("\n\n");
};

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
  htmlDirs: readonly string[],
  toolPath: string,
): boolean => {
  const state = getSessionState(ctx);
  const targetPath = path.resolve(ctx.cwd, toolPath);
  if (state.settledPlanReviewPaths.has(targetPath)) {
    return false;
  }

  const reviewTarget = resolveReviewTargetMatch(ctx, htmlDirs, targetPath);
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

const queuePlanReviewsForToolPaths = (
  ctx: ExtensionContext,
  htmlDirs: readonly string[],
  toolPaths: Iterable<string>,
): boolean => {
  let queued = false;
  for (const toolPath of toolPaths) {
    if (queuePlanReviewForToolPath(ctx, htmlDirs, toolPath)) {
      queued = true;
    }
  }

  return queued;
};

export const handlePlanFileWrite = (
  ctx: ExtensionContext,
  args: unknown,
  htmlDirs: readonly string[],
): boolean =>
  queuePlanReviewsForToolPaths(
    ctx,
    htmlDirs,
    pathsFromToolArgs(args).map(({ rawPath }) => rawPath),
  );

export const handleBashPlanFileWrites = (
  ctx: ExtensionContext,
  args: unknown,
  htmlDirs: readonly string[],
): boolean =>
  queuePlanReviewsForToolPaths(ctx, htmlDirs, extractBashPathCandidates(args));

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

// --- Review state machine (pending gate + settled set) ---

/** Which entry asked for the review. Both flows share one decision table. */
export type ReviewFlow = "auto" | "manual";

/** What the reviewer decided, independent of how the CLI encoded it. */
export type ReviewOutcome =
  | "approved"
  | "rejected"
  | "dismissed"
  | "no-verdict";

/** Where the reviewed path lands in the session's settled set. */
export type ReviewSettledState = "settled" | "armed" | "unchanged";

export type ReviewStateTransition = {
  outcome: ReviewOutcome;
  /** The revision the reviewer just saw leaves the pending queue. */
  clearPendingTarget: boolean;
  /** `settled` = silent afterwards, `armed` = future writes re-queue, `unchanged` = keep. */
  nextSettledState: ReviewSettledState;
};

type ReviewToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
};

const SETTLED_STATE_BY_OUTCOME: Record<ReviewOutcome, ReviewSettledState> = {
  approved: "settled",
  rejected: "armed",
  dismissed: "armed",
  "no-verdict": "unchanged",
};

/**
 * Read the reviewer's verdict out of the CLI decision. `exit` marks a run that
 * ended without a verdict (empty CLI output), which is neither an approval nor
 * a request for changes.
 */
const decideReviewOutcome = (decision: CliReviewDecision): ReviewOutcome => {
  if (decision.approved) {
    return "approved";
  }
  if (decision.dismissed) {
    return "dismissed";
  }
  if (decision.exit) {
    return "no-verdict";
  }

  return "rejected";
};

/**
 * Map a reviewer decision onto the pending gate and settled set.
 *
 * The two flows differ in one place: the manual entry releases the revision it
 * just showed the reviewer (the follow-up message drives the rewrite), while
 * the auto flow keeps the pending target on rejection so the agent has to
 * resubmit that revision.
 */
export const decideReviewStateTransition = (
  decision: CliReviewDecision,
  flow: ReviewFlow,
): ReviewStateTransition => {
  const outcome = decideReviewOutcome(decision);
  const clearPendingTarget =
    flow === "manual"
      ? outcome !== "no-verdict"
      : outcome === "approved" || outcome === "dismissed";

  return {
    outcome,
    clearPendingTarget,
    nextSettledState: SETTLED_STATE_BY_OUTCOME[outcome],
  };
};

/**
 * The single write point for review state, shared by the auto submit tool and
 * both manual entries. The pending-review event handle is only resolved when
 * the revision actually leaves the queue — a kept pending target stays gated.
 */
const applyReviewStateTransition = (
  state: SessionRuntimeState,
  cwd: string,
  resolvedPlanPath: string,
  transition: ReviewStateTransition,
): void => {
  if (transition.clearPendingTarget) {
    const pendingTargets = findPendingPlanReviewTargets(state, cwd);
    if (pendingTargets?.has(resolvedPlanPath)) {
      clearPendingPlanReviewTarget(
        state,
        cwd,
        pendingTargets,
        resolvedPlanPath,
      );
    }
    markPendingPlanReviewEventsHandled(state, cwd, [resolvedPlanPath]);
  }

  if (transition.nextSettledState === "settled") {
    state.settledPlanReviewPaths.add(resolvedPlanPath);
  } else if (transition.nextSettledState === "armed") {
    state.settledPlanReviewPaths.delete(resolvedPlanPath);
  }
};

const formatApprovedReviewResult = (
  pendingPlanReview: PendingPlanReview,
): ReviewToolResult => ({
  content: [
    {
      type: "text",
      text: `Review approved for ${pendingPlanReview.planFile}.`,
    },
  ],
  details: { status: "approved" },
});

const formatDismissedReviewResult = (
  pendingPlanReview: PendingPlanReview,
): ReviewToolResult => ({
  content: [
    {
      type: "text",
      text: `Review dismissed for ${pendingPlanReview.planFile} without a decision. The pending gate is released; the file will be queued for review again on its next write, or review it anytime with the plan/spec file picker.`,
    },
  ],
  details: { status: "dismissed" },
});

const formatDeniedReviewResult = (
  pendingPlanReview: PendingPlanReview,
  feedback?: string,
): ReviewToolResult => {
  const headingGuidance = isHtmlPath(pendingPlanReview.resolvedPlanPath)
    ? ""
    : ` ${KEEP_PLAN_HEADING_GUIDANCE}`;
  return {
    content: [
      {
        type: "text",
        text: `YOUR REVIEW WAS NOT APPROVED. Revise ${pendingPlanReview.planFile} and call ${PLAN_REVIEW_SUBMIT_TOOL} again after addressing this feedback.${headingGuidance}\n\n${feedback || "Review changes requested."}`,
      },
    ],
    details: { status: "denied" },
  };
};

/** Auto-flow shell: decide → apply state → format the tool result. */
const completePendingPlanReview = (
  ctx: ExtensionContext,
  state: SessionRuntimeState,
  pendingPlanReview: PendingPlanReview,
  decision: CliReviewDecision,
): ReviewToolResult => {
  const transition = decideReviewStateTransition(decision, "auto");
  applyReviewStateTransition(
    state,
    ctx.cwd,
    pendingPlanReview.resolvedPlanPath,
    transition,
  );
  setReviewWidget(ctx);

  if (transition.outcome === "approved") {
    return formatApprovedReviewResult(pendingPlanReview);
  }
  if (transition.outcome === "dismissed") {
    return formatDismissedReviewResult(pendingPlanReview);
  }

  return formatDeniedReviewResult(pendingPlanReview, decision.feedback);
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

// --- Manual review (picker / annotate-latest) state transition ---

const getManualReviewVerdicts = (
  state: SessionRuntimeState,
  cwd: string,
): Map<string, ManualReviewVerdict> => {
  const existing = state.manualReviewVerdictsByCwd.get(cwd);
  if (existing) {
    return existing;
  }

  const next = new Map<string, ManualReviewVerdict>();
  state.manualReviewVerdictsByCwd.set(cwd, next);
  return next;
};

/**
 * Record (or clear, with `null`) the verdict a manual review left for a path.
 * The auto submit tool is where other extensions read approval from
 * (`details.status === "approved"`), so the verdict stays claimable there.
 */
const setManualReviewVerdict = (
  state: SessionRuntimeState,
  cwd: string,
  resolvedPlanPath: string,
  status: ManualReviewStatus | null,
): void => {
  const verdicts = getManualReviewVerdicts(state, cwd);
  if (status === null) {
    verdicts.delete(resolvedPlanPath);
    if (verdicts.size === 0) {
      state.manualReviewVerdictsByCwd.delete(cwd);
    }
    return;
  }

  verdicts.set(resolvedPlanPath, { resolvedPlanPath, status });
};

/**
 * One-shot claim of the manual verdict waiting for `resolvedPlanPath`, consumed
 * by the auto submit tool. Returns null when there is no unclaimed verdict.
 */
const claimManualReviewVerdict = (
  state: SessionRuntimeState,
  cwd: string,
  resolvedPlanPath: string,
): ManualReviewVerdict | null => {
  const verdicts = state.manualReviewVerdictsByCwd.get(cwd);
  const verdict = verdicts?.get(resolvedPlanPath);
  if (!verdicts || !verdict) {
    return null;
  }

  verdicts.delete(resolvedPlanPath);
  if (verdicts.size === 0) {
    state.manualReviewVerdictsByCwd.delete(cwd);
  }
  return verdict;
};

const MANUAL_VERDICT_STATUS_BY_OUTCOME: Partial<
  Record<ReviewOutcome, ManualReviewStatus>
> = {
  approved: "approved",
  rejected: "denied",
};

/**
 * The single write point for the manual entries (file picker and
 * annotate-latest). A manual review is an explicit re-arm: the reviewed
 * revision leaves the pending queue, approval settles the path, and any other
 * verdict keeps it armed until the user approves.
 *
 * Only auto-review targets (plan / specs / `.pi/html`) are affected; manual
 * review of any other `.pi/` document leaves the queue untouched.
 */
const applyManualReviewDecision = (
  ctx: ExtensionContext,
  reviewedPath: string,
  decision: CliReviewDecision,
): void => {
  const targetPath = path.resolve(ctx.cwd, reviewedPath);
  if (
    !isAutoReviewTarget(resolveHtmlReviewDirs(ctx.cwd), ctx.cwd, targetPath)
  ) {
    return;
  }

  const state = getSessionState(ctx);
  const transition = decideReviewStateTransition(decision, "manual");
  applyReviewStateTransition(state, ctx.cwd, targetPath, transition);
  setManualReviewVerdict(
    state,
    ctx.cwd,
    targetPath,
    MANUAL_VERDICT_STATUS_BY_OUTCOME[transition.outcome] ?? null,
  );
  setReviewWidget(ctx);
};

/**
 * Manual-entry wrapper for callers that only hold a decision when the review
 * produced a verdict (`null` = CLI error / interrupted / closed). A review
 * without a verdict must not change the gate state.
 */
export const applyManualReviewVerdict = (
  ctx: ExtensionContext,
  reviewedPath: string,
  decision: CliReviewDecision | null,
): void => {
  if (!decision) {
    return;
  }

  applyManualReviewDecision(ctx, reviewedPath, decision);
};

/**
 * Report a manual verdict through the auto submit tool. Phrasing matters: the
 * approved line keeps the `Review approved for <path>` shape so consumers that
 * parse the text (not just `details.status`) still recognise the approval.
 */
const formatManualReviewVerdictResult = (
  ctx: ExtensionContext,
  verdict: ManualReviewVerdict,
): ReviewToolResult => {
  const planFile = toRepoRelativePath(ctx, verdict.resolvedPlanPath);
  if (verdict.status === "approved") {
    return {
      content: [
        {
          type: "text",
          text: `Review approved for ${planFile} (reviewed manually).`,
        },
      ],
      details: { status: "approved" },
    };
  }

  return {
    content: [
      {
        type: "text",
        text: `${planFile} was rejected in a manual review. Revise it and call ${PLAN_REVIEW_SUBMIT_TOOL} again after the next write re-queues it.`,
      },
    ],
    details: { status: "denied" },
  };
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

// --- Plannotator (HTML artifact) review flow ---

/**
 * One-shot Plannotator review for a pending HTML artifact:
 *   `plannotator annotate <file> --gate --json` blocks until the reviewer
 *   decides in the browser, then maps the decision JSON onto the pending
 *   gate semantics: approved → settle, annotated → denied (pending stays,
 *   gate stays locked), dismissed → released without settling. Interrupted
 *   submits keep no session state — a retry simply re-runs the annotate
 *   command (the reviewer's fresh session shows the version diff vs the
 *   previous submission via Plannotator's per-file annotate history).
 */
const runPlannotatorHtmlReviewFlow = async (
  ctx: ExtensionContext,
  state: SessionRuntimeState,
  pendingPlanReview: PendingPlanReview,
  signal: AbortSignal | undefined,
): Promise<ReviewToolResult> => {
  const cliResult = await runPlannotatorAnnotateCli(
    ctx,
    pendingPlanReview.resolvedPlanPath,
    {
      gate: true,
      signal,
      timeoutMs: SYNC_PLANNOTATOR_TIMEOUT_MS,
      // HTML artifacts always host in the regular browser: the review opens
      // in the browser instead of splitting a Herdr pane.
      hostMode: "browser",
    },
  );
  if (cliResult.status === "error") {
    return {
      content: [{ type: "text", text: cliResult.error }],
      details: { status: "error" },
    };
  }
  if (cliResult.status === "aborted") {
    return {
      content: [{ type: "text", text: "Plannotator review interrupted." }],
      details: { status: "aborted" },
    };
  }

  return completePendingPlanReview(
    ctx,
    state,
    pendingPlanReview,
    cliResult.result,
  );
};

/**
 * Manual-entry Plannotator HTML review (picker / Ctrl+Alt+L): run the
 * annotate CLI once and deliver the feedback as a follow-up. No pending
 * gate involvement — the caller feeds the returned decision (or `null` when
 * the review never produced a verdict) to `applyManualReviewVerdict`.
 */
export const runPlannotatorHtmlReviewOnce = async (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  filePath: string,
): Promise<CliReviewDecision | null> => {
  const response = await runPlannotatorAnnotateCli(ctx, filePath, {
    signal: ctx.signal,
    timeoutMs: SYNC_PLANNOTATOR_TIMEOUT_MS,
    // Manual HTML review (picker / Ctrl+Alt+L) also always hosts in the
    // regular browser — never the Herdr terminal-browser panel.
    hostMode: "browser",
  });
  if (response.status === "error") {
    ctx.ui.notify(response.error, "warning");
    return null;
  }
  if (response.status === "aborted") {
    ctx.ui.notify("Plannotator review interrupted.", "info");
    return null;
  }

  const feedback = response.result.feedback ?? "";
  if (response.result.approved || !feedback.trim()) {
    ctx.ui.notify(
      response.result.approved
        ? "Plannotator review approved."
        : "Plannotator review closed (no feedback).",
      "info",
    );
    return response.result;
  }
  await pi.sendUserMessage(feedback, { deliverAs: "followUp" });
  return response.result;
};

export const registerPlanReviewSubmitTool = (
  pi: ExtensionAPI,
  planReviewSubmitToolParameters: TSchema,
): void => {
  pi.registerTool({
    name: PLAN_REVIEW_SUBMIT_TOOL,
    label: "Submit Plannotator Auto Review",
    description:
      "Submit a pending plan/spec/extra review target, or a pending HTML artifact, to Plannotator and wait for approval or feedback.",
    promptSnippet:
      "plannotator_auto_submit_review: submit a pending plan/spec/extra review target, or a pending HTML artifact, to Plannotator and wait for approval or feedback.",
    parameters: planReviewSubmitToolParameters,
    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      const params = rawParams as PlanReviewSubmitToolParams;
      const state = getSessionState(ctx);
      const requestedPathValue = params.path;
      const requestedPath =
        typeof requestedPathValue === "string"
          ? path.resolve(ctx.cwd, requestedPathValue)
          : null;
      const pendingPlanReviews = findPendingPlanReviewTargets(state, ctx.cwd);
      const pendingPlanReview = requestedPath
        ? pendingPlanReviews?.get(requestedPath)
        : undefined;
      if (!pendingPlanReview) {
        // A manual review consumes the pending target, so its verdict has to be
        // reportable here: this tool result is the channel other extensions
        // observe approval through (`details.status === "approved"`).
        const verdict = requestedPath
          ? claimManualReviewVerdict(state, ctx.cwd, requestedPath)
          : null;
        if (verdict) {
          return formatManualReviewVerdictResult(ctx, verdict);
        }

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

      // HTML artifacts review through the Plannotator annotate CLI
      // (one-shot, --gate --json) instead of the plan-review hook.
      if (isHtmlPath(pendingPlanReview.resolvedPlanPath)) {
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
          return await runPlannotatorHtmlReviewFlow(
            ctx,
            state,
            pendingPlanReview,
            signal,
          );
        } finally {
          state.activePlanReviewByCwd.delete(ctx.cwd);
          setReviewWidget(ctx);
        }
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

      const preprocessed = preprocessPlanMarkdown(planContent);

      let mermaidValidationNotice: string | null = null;
      const mermaidValidation = await runPlanMermaidValidation(preprocessed);
      if (mermaidValidation.skipped) {
        log.warn(`Mermaid validation skipped: ${mermaidValidation.reason}`);
        mermaidValidationNotice = `Note: mermaid 语法校验跳过（原因: ${mermaidValidation.reason}），本次提交未做 mermaid 校验。`;
      } else if (mermaidValidation.errors.length > 0) {
        return {
          content: [
            {
              type: "text",
              text: formatPlanMermaidErrors(mermaidValidation.errors),
            },
          ],
          details: { status: "error", reason: "mermaid-validation" },
        };
      }

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
        const cliResult = await runPlannotatorPlanReviewCli(ctx, preprocessed, {
          signal,
          timeoutMs: SYNC_PLANNOTATOR_TIMEOUT_MS,
          // Markdown hosting follows the session toggle: browser (default)
          // or herdr-panel when the user switched with /plannotator-review-host.
          hostMode: state.reviewHostMode,
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

        const result = completePendingPlanReview(
          ctx,
          state,
          pendingPlanReview,
          cliResult.result,
        );

        if (mermaidValidationNotice) {
          return {
            ...result,
            content: result.content.map((part) =>
              part.type === "text"
                ? { ...part, text: `${mermaidValidationNotice}\n${part.text}` }
                : part,
            ),
          };
        }
        return result;
      } finally {
        state.activePlanReviewByCwd.delete(ctx.cwd);
        setReviewWidget(ctx);
      }
    },
  });
};
