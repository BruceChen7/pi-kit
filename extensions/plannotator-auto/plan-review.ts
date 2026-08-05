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
import {
  createHandledState,
  type PiKitPlannotatorPendingReviewEvent,
  PLANNOTATOR_PENDING_REVIEW_CHANNEL,
} from "../shared/internal-events.ts";
import { createLogger } from "../shared/logger.ts";
import {
  type LavishDecision,
  runLavishOpenCli,
  runLavishPollCli,
  runPlannotatorPlanReviewCli,
} from "./cli.ts";
import { extractBashPathCandidates, resolveToolPaths } from "./helpers.ts";
import {
  checkLavishHtmlCompliance,
  formatLavishHtmlIssues,
  type LavishHtmlIssue,
} from "./lavish-html-check.ts";
import {
  formatPlanMermaidErrors,
  runPlanMermaidValidation,
} from "./mermaid-validator.ts";
import { isHtmlPath, resolveReviewTargetMatch } from "./paths.ts";
import type { PendingPlanReview, PlanFileConfig } from "./plan-review/types.ts";
import { getSessionState, type SessionRuntimeState } from "./session.ts";

const KEEP_PLAN_HEADING_GUIDANCE =
  "Keep the first # heading unchanged unless the reviewer explicitly asks you " +
  "to rename the plan; Plannotator uses that heading to show version diffs.";
const MERMAID_RENDERING_GUIDANCE =
  "If the document contains Mermaid, use only ```mermaid fenced blocks (never ~~~), keep fences paired and non-empty, use language tag 'mermaid' only (not mmd/mermaidjs), prefer simple graph/flowchart syntax, and if correctness is uncertain, replace the diagram with plain Markdown bullets before submitting.";
const PLAN_REVIEW_SUBMIT_TOOL = "plannotator_auto_submit_review";
const REVIEW_WIDGET_KEY = "plannotator-auto-review";
const SYNC_PLANNOTATOR_TIMEOUT_MS = 4 * 60 * 60 * 1_000;

const log = createLogger("plannotator-auto", { stderr: null });

type PendingPlanReviewEventHandle = {
  markHandled: () => void;
};

type PlanReviewSubmitToolParams = {
  path?: unknown;
  reply?: unknown;
};

type PlanReviewDecisionLike = {
  approved?: boolean;
  feedback?: string;
  dismissed?: boolean;
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
    ? "Lavish review is active"
    : "Plan/Spec review is active";
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

const formatPendingPlanReviewGateMessage = (planFiles: string[]): string => {
  const targets = formatPlanFileBulletList(planFiles);
  const htmlTarget = planFiles.some((file) => isHtmlPath(file));
  const heading = htmlTarget
    ? "[LAVISH REVIEW - PENDING]"
    : "[PLANNOTATOR AUTO - PENDING REVIEW]";
  const guidance = htmlTarget
    ? ""
    : ` ${KEEP_PLAN_HEADING_GUIDANCE} ${MERMAID_RENDERING_GUIDANCE}`;
  return [
    heading,
    "You still have pending review drafts:",
    targets,
    `Call ${PLAN_REVIEW_SUBMIT_TOOL} with one of these paths before continuing.${guidance}`,
  ].join("\n\n");
};

const formatPendingPlanReviewPrompt = (planFiles: string[]): string => {
  const targets = formatPlanFileBulletList(planFiles);
  const htmlTarget = planFiles.some((file) => isHtmlPath(file));
  const nextAction =
    `Your next required action is calling ${PLAN_REVIEW_SUBMIT_TOOL} ` +
    "with one pending path.";
  const deniedAction = htmlTarget
    ? `If the user sends feedback, revise the artifact and call ${PLAN_REVIEW_SUBMIT_TOOL} again (optionally with a reply describing your changes).`
    : `If a review is denied, revise that same file and call ${PLAN_REVIEW_SUBMIT_TOOL} again.`;
  // Markdown-only guidance: HTML plans have no `# heading` and do not use
  // ```mermaid fenced blocks, so the guidance would actively mislead agents.
  const markdownGuidance = htmlTarget
    ? ""
    : ` ${KEEP_PLAN_HEADING_GUIDANCE} ${MERMAID_RENDERING_GUIDANCE}`;
  const heading = htmlTarget
    ? "[LAVISH REVIEW - PENDING]"
    : "[PLANNOTATOR AUTO - PENDING REVIEW]";

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
  const htmlTarget = planFiles.some((file) => isHtmlPath(file));
  const body = formatPendingPlanReviewGateMessage(planFiles);
  const handled = createHandledState();
  trackPendingPlanReviewEvent(state, ctx.cwd, pendingPlanReviews, handled);

  pi.events.emit(PLANNOTATOR_PENDING_REVIEW_CHANNEL, {
    type: "plannotator-auto.pending-review",
    requestId: `plannotator_pending_review_${Date.now()}`,
    createdAt: Date.now(),
    title: htmlTarget ? "Lavish review pending" : "Plannotator review pending",
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

const queuePlanReviewsForToolPaths = (
  ctx: ExtensionContext,
  planConfig: PlanFileConfig | null,
  toolPaths: Iterable<string>,
): boolean => {
  if (!planConfig) {
    return false;
  }

  let queued = false;
  for (const toolPath of toolPaths) {
    if (queuePlanReviewForToolPath(ctx, planConfig, toolPath)) {
      queued = true;
    }
  }

  return queued;
};

export const handlePlanFileWrite = (
  ctx: ExtensionContext,
  args: unknown,
  planConfig: PlanFileConfig | null,
): boolean =>
  queuePlanReviewsForToolPaths(ctx, planConfig, resolveToolPaths(args));

export const handleBashPlanFileWrites = (
  ctx: ExtensionContext,
  args: unknown,
  planConfig: PlanFileConfig | null,
): boolean =>
  queuePlanReviewsForToolPaths(
    ctx,
    planConfig,
    extractBashPathCandidates(args),
  );

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
) => {
  const headingGuidance = isHtmlPath(pendingPlanReview.resolvedPlanPath)
    ? ""
    : ` ${KEEP_PLAN_HEADING_GUIDANCE}`;
  return {
    content: [
      {
        type: "text" as const,
        text: `YOUR REVIEW WAS NOT APPROVED. Revise ${pendingPlanReview.planFile} and call ${PLAN_REVIEW_SUBMIT_TOOL} again after addressing this feedback.${headingGuidance}\n\n${feedback || "Review changes requested."}`,
      },
    ],
    details: { status: "denied" },
  };
};

const dismissPendingPlanReview = (
  state: SessionRuntimeState,
  cwd: string,
  pendingPlanReviews: Map<string, PendingPlanReview>,
  pendingPlanReview: PendingPlanReview,
) => {
  // Dismissed = no decision, no revision demand. Release the gate but do NOT
  // settle the path: the next write to the same file re-queues the review.
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
        text: `Review dismissed for ${pendingPlanReview.planFile} without a decision. The pending gate is released; the file will be queued for review again on its next write, or review it anytime with the plan/spec file picker.`,
      },
    ],
    details: { status: "dismissed" },
  };
};

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

  if (result.dismissed) {
    return dismissPendingPlanReview(
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

// --- Lavish (HTML artifact) review flow ---

const LAVISH_DEFAULT_REPLY = "Agent updated the artifact. Please review again.";

type ReviewToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
};

export const formatLavishFeedback = (
  planFile: string,
  decision: Extract<LavishDecision, { kind: "feedback" }>,
): string => {
  const promptLines =
    decision.prompts.length > 0
      ? decision.prompts.map((prompt) => `- ${prompt}`)
      : ["(no feedback text)"];
  return [
    "[LAVISH REVIEW FEEDBACK]",
    `Review feedback for ${planFile}:`,
    ...promptLines,
    decision.nextStep ? `\n${decision.nextStep}` : "",
  ]
    .join("\n")
    .trim();
};

/**
 * Hard-gate Lavish review loop for a pending HTML artifact:
 *   first submit  → `lavish-axi open` + `poll` (wait for the first batch)
 *   later submits → `poll --agent-reply <reply>` + keep waiting
 * feedback stays pending (= denied semantics); ended / user-ended / final
 * feedback batch releases the gate (= approved semantics). Interrupted
 * submits never re-open the session (`lavishSessionOpened`).
 */
const runLavishReviewFlow = async (
  ctx: ExtensionContext,
  state: SessionRuntimeState,
  pendingPlanReviews: Map<string, PendingPlanReview>,
  pendingPlanReview: PendingPlanReview,
  reply: string | undefined,
  signal: AbortSignal,
): Promise<ReviewToolResult> => {
  const openedNow = !pendingPlanReview.lavishSessionOpened;
  if (openedNow) {
    const openResult = await runLavishOpenCli(
      ctx,
      pendingPlanReview.resolvedPlanPath,
      {
        signal,
        timeoutMs: SYNC_PLANNOTATOR_TIMEOUT_MS,
      },
    );
    if (openResult.status === "error") {
      return {
        content: [{ type: "text", text: openResult.error }],
        details: { status: "error" },
      };
    }
    if (openResult.status === "aborted") {
      return {
        content: [{ type: "text", text: "Lavish review interrupted." }],
        details: { status: "aborted" },
      };
    }
    if (openResult.result.kind === "user-ended") {
      approvePendingPlanReview(
        state,
        ctx.cwd,
        pendingPlanReviews,
        pendingPlanReview,
      );
      return {
        content: [
          {
            type: "text",
            text: `The user ended the Lavish review session for ${pendingPlanReview.planFile}; review is complete.`,
          },
        ],
        details: { status: "approved" },
      };
    }
    pendingPlanReview.lavishSessionOpened = true;
  }

  const pollResult = await runLavishPollCli(
    ctx,
    pendingPlanReview.resolvedPlanPath,
    {
      agentReply: openedNow ? undefined : (reply ?? LAVISH_DEFAULT_REPLY),
      signal,
      timeoutMs: SYNC_PLANNOTATOR_TIMEOUT_MS,
    },
  );
  if (pollResult.status === "error") {
    return {
      content: [{ type: "text", text: pollResult.error }],
      details: { status: "error" },
    };
  }
  if (pollResult.status === "aborted") {
    return {
      content: [{ type: "text", text: "Lavish review interrupted." }],
      details: { status: "aborted" },
    };
  }

  const decision = pollResult.result;
  if (decision.kind === "ended") {
    approvePendingPlanReview(
      state,
      ctx.cwd,
      pendingPlanReviews,
      pendingPlanReview,
    );
    const endedByNote =
      decision.endedBy === "user" ? " (ended by the user)" : "";
    return {
      content: [
        {
          type: "text",
          text: `Lavish review ended${endedByNote} for ${pendingPlanReview.planFile}.`,
        },
      ],
      details: { status: "approved" },
    };
  }

  // Final feedback batch with session ended = review complete: deliver the
  // feedback and release the gate (the user cannot send more feedback).
  if (decision.kind === "feedback" && decision.sessionEnded) {
    approvePendingPlanReview(
      state,
      ctx.cwd,
      pendingPlanReviews,
      pendingPlanReview,
    );
    return {
      content: [
        {
          type: "text",
          text: `${formatLavishFeedback(pendingPlanReview.planFile, decision)}\n\nThe user ended the Lavish session with this feedback; review is complete. Revise ${pendingPlanReview.planFile} and deliver updates in this conversation.`,
        },
      ],
      details: { status: "approved" },
    };
  }

  // Ordinary feedback = denied semantics: pending stays, gate stays locked.
  if (decision.kind === "feedback") {
    return {
      content: [
        {
          type: "text",
          text: formatLavishFeedback(pendingPlanReview.planFile, decision),
        },
      ],
      details: { status: "denied" },
    };
  }

  // opened / user-ended never come from poll — defensive fallback.
  return {
    content: [
      {
        type: "text",
        text: "Lavish poll returned an unexpected result.",
      },
    ],
    details: { status: "error" },
  };
};

/**
 * Manual-entry Lavish review (picker / Ctrl+Alt+L): open + poll once, deliver
 * the first feedback batch as a follow-up. No pending gate involvement.
 */
/**
 * Read an HTML artifact and run the static Lavish-annotate compliance check.
 * Errors block submission; warnings only annotate the result.
 */
const readLavishHtmlCompliance = (
  filePath: string,
): { status: "read-error" } | { status: "ok"; issues: LavishHtmlIssue[] } => {
  try {
    const html = fs.readFileSync(filePath, "utf-8");
    return { status: "ok", issues: checkLavishHtmlCompliance(html) };
  } catch {
    return { status: "read-error" };
  }
};

const formatLavishHtmlComplianceBlock = (
  planFile: string,
  issues: LavishHtmlIssue[],
): string => formatLavishHtmlIssues(issues, { blocked: true, planFile });

export const runLavishReviewOnce = async (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  filePath: string,
): Promise<void> => {
  const compliance = readLavishHtmlCompliance(filePath);
  if (compliance.status === "read-error") {
    ctx.ui.notify(
      `Could not read ${path.relative(ctx.cwd, filePath)} before opening Lavish.`,
      "warning",
    );
    return;
  }
  const blockIssues = compliance.issues.filter(
    (issue) => issue.severity === "error",
  );
  if (blockIssues.length > 0) {
    ctx.ui.notify(
      formatLavishHtmlComplianceBlock(
        path.relative(ctx.cwd, filePath),
        compliance.issues,
      ),
      "warning",
    );
    return;
  }
  const warningIssues = compliance.issues.filter(
    (issue) => issue.severity === "warning",
  );
  if (warningIssues.length > 0) {
    ctx.ui.notify(
      formatLavishHtmlIssues(warningIssues, {
        blocked: false,
        planFile: path.relative(ctx.cwd, filePath),
      }),
      "info",
    );
  }
  ctx.ui.notify("Opening Lavish review…", "info");
  const openResult = await runLavishOpenCli(ctx, filePath, {
    signal: ctx.signal,
    timeoutMs: SYNC_PLANNOTATOR_TIMEOUT_MS,
  });
  if (openResult.status === "error") {
    ctx.ui.notify(openResult.error, "warning");
    return;
  }
  if (openResult.status === "aborted") {
    ctx.ui.notify("Lavish review interrupted.", "info");
    return;
  }
  if (openResult.result.kind === "user-ended") {
    ctx.ui.notify(
      "The user ended the Lavish review session; not reopened.",
      "info",
    );
    return;
  }

  const pollResult = await runLavishPollCli(ctx, filePath, {
    signal: ctx.signal,
    timeoutMs: SYNC_PLANNOTATOR_TIMEOUT_MS,
  });
  if (pollResult.status === "error") {
    ctx.ui.notify(pollResult.error, "warning");
    return;
  }
  if (pollResult.status === "aborted") {
    ctx.ui.notify("Lavish review interrupted.", "info");
    return;
  }

  const decision = pollResult.result;
  if (decision.kind === "ended") {
    ctx.ui.notify("Lavish review ended.", "info");
    return;
  }
  if (
    decision.kind === "feedback" &&
    (decision.prompts.length > 0 || decision.nextStep)
  ) {
    const feedback = formatLavishFeedback(
      path.relative(ctx.cwd, filePath),
      decision,
    );
    await pi.sendUserMessage(feedback, { deliverAs: "followUp" });
    return;
  }
  ctx.ui.notify("Lavish review closed (no feedback).", "info");
};

export const registerPlanReviewSubmitTool = (
  pi: ExtensionAPI,
  planReviewSubmitToolParameters: TSchema,
): void => {
  pi.registerTool({
    name: PLAN_REVIEW_SUBMIT_TOOL,
    label: "Submit Plannotator Auto Review",
    description:
      "Submit a pending plan/spec/extra review target to Plannotator, or a pending HTML artifact to Lavish, and wait for approval or feedback.",
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

      // HTML artifacts review through the Lavish open/poll loop instead of the
      // Plannotator plan-review hook. Before opening, run the static
      // Lavish-annotate compliance gate: errors block the submission, warnings
      // are attached to the first-submit result so the agent can fix them.
      if (isHtmlPath(pendingPlanReview.resolvedPlanPath)) {
        const compliance = readLavishHtmlCompliance(
          pendingPlanReview.resolvedPlanPath,
        );
        if (compliance.status === "read-error") {
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
        const blockIssues = compliance.issues.filter(
          (issue) => issue.severity === "error",
        );
        if (blockIssues.length > 0) {
          return {
            content: [
              {
                type: "text",
                text: formatLavishHtmlComplianceBlock(
                  pendingPlanReview.planFile,
                  compliance.issues,
                ),
              },
            ],
            details: { status: "error", reason: "lavish-html-compliance" },
          };
        }
        const warningIssues = compliance.issues.filter(
          (issue) => issue.severity === "warning",
        );
        const openedBefore = pendingPlanReview.lavishSessionOpened;
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
          const result = await runLavishReviewFlow(
            ctx,
            state,
            pendingPlanReviews,
            pendingPlanReview,
            typeof params.reply === "string" ? params.reply : undefined,
            signal,
          );
          if (warningIssues.length > 0 && !openedBefore) {
            const existing = result.content[0]?.text ?? "";
            result.content = [
              {
                type: "text",
                text:
                  existing +
                  "\n\n" +
                  formatLavishHtmlIssues(warningIssues, {
                    blocked: false,
                    planFile: pendingPlanReview.planFile,
                  }),
              },
            ];
          }
          return result;
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
      // Real syntax validation against the mermaid parser. Covers fence
      // structure (unclosed/empty) AND parse errors; all failures are
      // collected and reported together. A broken runtime degrades to a
      // skip (never blocks the review gate).
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
          pendingPlanReviews,
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
