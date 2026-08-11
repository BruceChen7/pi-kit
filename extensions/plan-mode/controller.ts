import fs from "node:fs";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";

/** Structural mirror of the (non-public) ToolResultEventResult type. */
interface ToolResultEventResult {
  content?: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  details?: unknown;
  isError?: boolean;
}

import { pathsFromWriteToolInput } from "../shared/tool-targets.ts";
import {
  formatApprovedArtifactPolicyFailure,
  formatArtifactPolicyFailure,
  isStandardPlanArtifactPath,
  validateArtifactPolicy,
} from "./artifact-policy.ts";
import {
  captureGitHead,
  maybeSendCallflowSummary,
} from "./callflow-summary.ts";
import {
  ACT_CODE_WRITING_GUIDANCE,
  ACT_TODO_TOOL_NAME,
  BUILTIN_TOOL_NAMES,
  DEFAULT_CONFIG,
  DIRECT_ACT_TODO_GUIDANCE,
  EXECUTION_TODO_DISCIPLINE_GUIDANCE,
  MARKDOWN_PLAN_REVIEW_ARTIFACT_LOCATION,
  MODE_WIDGET_KEY,
  PATH_GUARDED_TOOL_NAMES,
  PLAN_INSPECTION_TOOL_SLASH_LIST,
  PLAN_MODE_TOOL_NAMES,
  PLAN_REVIEW_ARTIFACT_GUIDANCE,
  PLANNOTATOR_SUBMIT_TOOL_NAME,
  REVIEW_ARTIFACT_LOCATION,
  REVIEW_ARTIFACT_WRITE_HINT,
  STATE_ENTRY_TYPE,
  STATUS_KEY,
  TODO_TOOL_NAME,
  TODO_WIDGET_KEY,
  WRITE_TOOL_NAMES,
} from "./constants.ts";
import {
  decideAgentStartPostActions,
  decideAgentStartPreActions,
  decidePlanReviewObligation,
  getApprovedReviewPathToQueue,
} from "./controller-decisions.ts";
import { decideToolBlock, type GuardPolicyTarget } from "./guard-policy.ts";
import {
  formatReviewWaitReason,
  getApprovedReviewPath,
  isAutoReviewTargetPath,
  isReviewArtifactPath,
  normalizeToolPath,
  pathFromToolCall,
  pathsFromToolCall,
  relativeToolPath,
  turnWasAborted,
} from "./guards.ts";
import { isHtmlArtifactPathIn, resolveHtmlArtifactDirs } from "./html-dirs.ts";
import {
  getSessionStateEntries,
  hasCompletedAllTodos,
  latestSnapshot,
  loadPlanModeConfig,
  PlanModeState,
  stringProperty,
} from "./state.ts";
import type {
  InputSource,
  PlanMode,
  PlanModeConfig,
  PlanPhase,
} from "./types.ts";
import {
  colorModeWidgetLines,
  colorTodoWidgetHeading,
  formatModeWidgetLines,
  formatPlanDecision,
  formatTodoWidgetLines,
  getModeLabel,
} from "./ui.ts";

const PLAN_HEADING_REVIEW_GUIDANCE =
  "Keep the plan's first # heading unchanged across denied revisions unless " +
  "the reviewer explicitly asks for a rename; Plannotator uses that heading " +
  "to group version diffs.";
const APPROVED_ARTIFACT_CHANGED_REVIEW_MESSAGE =
  "Plan Mode is waiting for an approved Plannotator plan/spec. The " +
  "approved artifact changed and must be reviewed again before " +
  "continuing approved execution.";
// APPROVED_EXECUTION_ABORTED_REVIEW_MESSAGE removed - no longer used.
// The abort path now uses ctx.ui.notify() instead of sendUserMessage()
// to avoid restarting the agent (which caused an infinite retry loop).

// ── Date helpers ──────────────────────────────────────────────

/** Return today's date as YYYY-MM-DD (UTC, which matches local date
 *  for all practical purposes). Pure function, no side-effects. */
export const getTodayDateString = (): string =>
  new Date().toISOString().slice(0, 10);

/** Validate that a plan artifact path's date prefix equals today's date.
 *  Returns an error message when the date doesn't match, or null if it
 *  matches or the path has no date pattern (non-standard paths pass). */
export const validatePathDate = (planPath: string): string | null => {
  const match = planPath.match(/(\d{4}-\d{2}-\d{2})/);
  if (!match) return null;

  const pathDate = match[1];
  const today = getTodayDateString();
  if (pathDate === today) return null;

  return [
    `Plan artifact path uses date "${pathDate}" but today is "${today}".`,
    `Fix: rename the path to use ${today} as the date prefix.`,
    `Example: .pi/plans/<repo>/plan/${today}-<slug>.md`,
  ].join("\n");
};

export class PlanModeController {
  config: PlanModeConfig = DEFAULT_CONFIG;
  state = new PlanModeState(DEFAULT_CONFIG.defaultMode);
  private reviewRequiredForTurn = false;
  private inputSourceForTurn: InputSource = "unknown";
  private internalExtensionBypassForTurn = false;
  private approvedPlanContinuationForTurn = false;
  // ── Episode-guard markers ──────────────────────────────────────
  // Each marker is keyed on a unique identifier for the current "episode"
  // (artifact path for re-review, failure text for policy).  Once a
  // follow-up has been queued, subsequent turn-ends with the same key are
  // skipped — the post-run loop must stop, not self-continue forever.
  //
  // Reset strategy (applied consistently to both markers):
  //   · restore()       — fresh session, no episode in progress.
  //   · abort-approved  — abort ends the current episode; next normal
  //                       turn-end may remind once for the new episode.
  //   · approval        — run recovered; future unapproved episodes may
  //                       remind once.
  //   · policy pass     — artifact fixed; a new failure text queues again.
  private reReviewReminderSentFor: string | null = null;
  private policyReminderSentFor: string | null = null;
  // Session-scoped values, resolved in restore() (no IO at construction).
  private htmlArtifactDirs: string[] = [];
  constructor(private readonly pi: ExtensionAPI) {}

  restore(ctx: ExtensionContext): void {
    this.htmlArtifactDirs = resolveHtmlArtifactDirs(ctx.cwd);
    this.config = loadPlanModeConfig(ctx.cwd);
    const entries = getSessionStateEntries(ctx);
    this.state.restore(latestSnapshot(entries), this.config.defaultMode);
    this.reviewRequiredForTurn = false;
    this.inputSourceForTurn = "unknown";
    this.internalExtensionBypassForTurn = false;
    this.approvedPlanContinuationForTurn = false;
    this.reReviewReminderSentFor = null;
    this.policyReminderSentFor = null;
  }

  persist(): void {
    this.pi.appendEntry(STATE_ENTRY_TYPE, this.state.snapshot());
  }

  applyMode(ctx: ExtensionContext): void {
    this.pi.setActiveTools(this.getToolsForCurrentMode());
    this.updateUi(ctx);
  }

  getTodoToolNameForCurrentMode(): string {
    return this.getTodoToolNameForPhase(this.state.phase);
  }

  private getTodoToolNameForPhase(phase: PlanPhase): string {
    return phase === "act" ? ACT_TODO_TOOL_NAME : TODO_TOOL_NAME;
  }

  getToolsForCurrentMode(): string[] {
    return this.getToolsForPhase(this.state.phase);
  }

  private getToolsForPhase(phase: PlanPhase): string[] {
    const stableTools = [
      ...BUILTIN_TOOL_NAMES,
      this.getTodoToolNameForPhase(phase),
    ];
    if (!this.config.preserveExternalTools) {
      return stableTools;
    }

    const externalTools = this.pi
      .getActiveTools()
      .filter((toolName) => !PLAN_MODE_TOOL_NAMES.has(toolName));
    return [...new Set([...stableTools, ...externalTools])];
  }

  setMode(ctx: ExtensionContext, mode: PlanMode): void {
    this.state.setMode(mode);
    this.applyMode(ctx);
    this.persist();
  }

  toggleMode(ctx: ExtensionContext): void {
    this.setMode(ctx, this.state.mode === "act" ? "plan" : "act");
  }

  updateUi(ctx: ExtensionContext): void {
    if (!ctx.hasUI) {
      return;
    }

    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.setWidget(
      MODE_WIDGET_KEY,
      colorModeWidgetLines(formatModeWidgetLines(this.state), ctx),
      { placement: "aboveEditor" },
    );

    const widgetLines = formatTodoWidgetLines(this.state);
    if (widgetLines.length === 0) {
      ctx.ui.setWidget(TODO_WIDGET_KEY, undefined);
      return;
    }

    ctx.ui.setWidget(
      TODO_WIDGET_KEY,
      colorTodoWidgetHeading(widgetLines, ctx),
      {
        placement: "belowEditor",
      },
    );
  }

  buildModePrompt(): string {
    const effectivePhase: PlanPhase = this.internalExtensionBypassForTurn
      ? "act"
      : this.state.phase;
    const todoToolName = this.getTodoToolNameForPhase(effectivePhase);
    const lines = [
      "## Plan Mode Extension",
      "",
      `Current workflow: ${
        this.internalExtensionBypassForTurn ? "Act" : getModeLabel(this.state)
      }.`,
      `Plan artifact format: ${this.state.getPlanArtifactFormat(this.config)} ` +
        `(${this.state.getPlanArtifactFormatSource(this.config)}).`,
      "",
      `- In plan phases, inspect with ${PLAN_INSPECTION_TOOL_SLASH_LIST}. ` +
        "Runtime guards block bash and source-code edits.",
      `- Use ${todoToolName} to maintain the concrete TODO list.`,
      "- For implementation tasks, write only reviewable artifacts under " +
        `${MARKDOWN_PLAN_REVIEW_ARTIFACT_LOCATION} and submit them with ` +
        `${PLANNOTATOR_SUBMIT_TOOL_NAME}.`,
      `- ${REVIEW_ARTIFACT_WRITE_HINT}`,
      "- Standard plan artifacts must use the following sections: " +
        "## Goal, ## Current Flow, ## Desired Flow, ## Boundaries, " +
        "## Implementation, ## Testing, ## Decisions, ## Non-goals.",
      "- If Plannotator denies the plan, revise the same file and submit again.",
      `- ${PLAN_HEADING_REVIEW_GUIDANCE}`,
      "- During approved execution, execute the approved plan and update " +
        `${todoToolName} statuses before starting each step so the widget ` +
        "shows the current step.",
      EXECUTION_TODO_DISCIPLINE_GUIDANCE,
      ...this.getHtmlArtifactGuidanceLines(),
    ];

    if (effectivePhase === "plan") {
      lines.push(...PLAN_REVIEW_ARTIFACT_GUIDANCE);
    }

    if (effectivePhase === "act" || this.state.mode === "act") {
      lines.push(...ACT_CODE_WRITING_GUIDANCE);
    }

    if (this.internalExtensionBypassForTurn || this.state.mode === "act") {
      lines.push(DIRECT_ACT_TODO_GUIDANCE);
    }

    return lines.join("\n");
  }

  private getHtmlArtifactGuidanceLines(): string[] {
    const dirs = this.htmlArtifactDirs;
    if (dirs.length === 0) {
      return [];
    }
    const dirList = dirs.join(", ");
    return [
      `- HTML review artifacts must be written under ${dirList} ` +
        `as YYYY-MM-DD-<slug>.html, then submitted with ` +
        `${PLANNOTATOR_SUBMIT_TOOL_NAME}.`,
    ];
  }

  handleInput(event: unknown): void {
    const source = stringProperty(event, "source");
    this.inputSourceForTurn =
      source === "interactive" || source === "rpc" || source === "extension"
        ? source
        : "unknown";
  }

  async handleAgentStart(event: unknown, ctx: ExtensionContext): Promise<void> {
    const preDecision = decideAgentStartPreActions({
      inputSourceForTurn: this.inputSourceForTurn,
      prompt: stringProperty(event, "prompt") ?? "",
      hasCompletedNonApprovedRun: this.hasCompletedNonApprovedRun(),
    });
    this.internalExtensionBypassForTurn = preDecision.internalExtensionBypass;

    if (preDecision.internalExtensionBypass) {
      this.pi.setActiveTools(this.getToolsForPhase("act"));
    }

    if (preDecision.shouldDismissCompletedNonApprovedRun) {
      this.dismissCompletedNonApprovedRun();
      this.updateUi(ctx);
      this.persist();
    }

    if (preDecision.shouldEnterPlanMode) {
      this.setModeWithoutUserNotification(ctx, "plan");
    }

    const confirmedContinuationPath =
      this.state.consumeConfirmedApprovedContinuation();
    const continuesApprovedPlan = confirmedContinuationPath !== null;
    this.approvedPlanContinuationForTurn = continuesApprovedPlan;
    if (continuesApprovedPlan) {
      this.applyMode(ctx);
      this.persist();
    }

    const postDecision = decideAgentStartPostActions({
      internalExtensionBypass: this.internalExtensionBypassForTurn,
      continuesApprovedPlan,
      isPlanPhase: this.state.isPlanPhase(),
      isApprovedCompletedPlanActRun: this.state.isApprovedCompletedPlanActRun(),
      canReturnPlanActToPlan: this.state.shouldReturnPlanActToPlan(),
    });

    if (postDecision.shouldCompleteApprovedRun) {
      this.state.completePlanActRun();
      this.applyMode(ctx);
      this.persist();
    } else if (postDecision.shouldReturnPlanActToPlan) {
      this.state.returnPlanActToPlan();
      this.persist();
    }

    this.state.lastAutoDecision = {
      outcome: "plan_required",
      reason: "plan mode requires a reviewed plan/spec",
    };
    this.reviewRequiredForTurn = postDecision.reviewRequiredForTurn;
  }

  clearTurnSource(): void {
    this.inputSourceForTurn = "unknown";
    this.internalExtensionBypassForTurn = false;
    this.approvedPlanContinuationForTurn = false;
  }

  private finishTurn(ctx: ExtensionContext): void {
    const restoreTools = this.internalExtensionBypassForTurn;
    this.clearTurnSource();
    if (restoreTools) {
      this.applyMode(ctx);
    }
  }

  private hasCompletedNonApprovedRun(): boolean {
    return (
      this.state.activeRun?.status === "completed" &&
      !this.state.isApprovedCompletedPlanActRun()
    );
  }

  private dismissCompletedNonApprovedRun(): void {
    this.state.archiveCompletedActiveRun();
    this.state.clearTodos();
  }

  setModeWithoutUserNotification(ctx: ExtensionContext, mode: PlanMode): void {
    this.state.setMode(mode);
    this.applyMode(ctx);
    this.persist();
  }

  getPlanPathForNewRun(): string | null {
    const approvedPlanPath = this.state.getApprovedContinuationPlanPath();
    if (
      approvedPlanPath &&
      (this.approvedPlanContinuationForTurn ||
        this.state.canStartFirstRunForApprovedPlan())
    ) {
      return approvedPlanPath;
    }

    return this.state.getUnfinishedRunPlanPath();
  }

  hasPlanReviewObligation(): boolean {
    return decidePlanReviewObligation({
      internalExtensionBypass: this.internalExtensionBypassForTurn,
      phase: this.state.phase,
      mode: this.state.mode,
      reviewRequiredForTurn: this.reviewRequiredForTurn,
      todoCount: this.state.todos.length,
      latestReviewArtifactPath: this.state.latestReviewArtifactPath,
    });
  }

  approvedExecutionNeedsReReview(latestArtifactPath: string | null): boolean {
    return (
      this.config.requireReview &&
      latestArtifactPath !== null &&
      this.state.activeRun?.planPath === latestArtifactPath &&
      !this.state.isApprovedReviewArtifactPath(latestArtifactPath)
    );
  }

  validateArtifactPolicyForPath(
    ctx: ExtensionContext,
    rawPath: string,
    options: { alreadyApproved?: boolean } = {},
  ): string | null {
    const policyPath = relativeToolPath(ctx.cwd, rawPath);
    if (!isStandardPlanArtifactPath(policyPath)) {
      return null;
    }

    const absolutePath = normalizeToolPath(ctx.cwd, rawPath);
    let content: string;
    try {
      content = fs.readFileSync(absolutePath, "utf-8");
    } catch {
      return [
        "Plan Mode artifact policy blocked review submission.",
        `Path: ${policyPath}`,
        "",
        "Fix: create or rewrite the plan artifact before submitting review.",
      ].join("\n");
    }

    const result = validateArtifactPolicy({
      path: policyPath,
      content,
      // Human-approved artifacts are final: never re-judge their content
      // forms (mermaid diagrams, call trees) at agent_end.
      config: options.alreadyApproved
        ? { ...this.config.artifactPolicy, requireReviewDetails: false }
        : this.config.artifactPolicy,
    });
    if (result.approved) {
      return null;
    }

    return options.alreadyApproved
      ? formatApprovedArtifactPolicyFailure(policyPath, result.issues)
      : formatArtifactPolicyFailure(policyPath, result.issues);
  }

  maybeBlockTool(
    event: ToolCallEvent,
    ctx: ExtensionContext,
  ): { block: true; reason: string } | undefined {
    if (this.internalExtensionBypassForTurn) {
      return undefined;
    }

    if (event.toolName === PLANNOTATOR_SUBMIT_TOOL_NAME) {
      const rawPath = pathFromToolCall(event);
      if (rawPath) {
        const policyFailure = this.validateArtifactPolicyForPath(ctx, rawPath);
        if (policyFailure) {
          return {
            block: true,
            reason: policyFailure,
          };
        }
      }
    }

    const targetResult = pathsFromToolCall(event);
    const targets: GuardPolicyTarget[] =
      targetResult.kind === "paths"
        ? targetResult.paths.map(({ rawPath }) => {
            const absolutePath = normalizeToolPath(ctx.cwd, rawPath);
            const relativePath = path.relative(ctx.cwd, absolutePath);
            const isInsideCwd =
              relativePath === "" ||
              (!relativePath.startsWith("..") &&
                !path.isAbsolute(relativePath));
            return {
              rawPath,
              exists: fs.existsSync(absolutePath),
              isInsideCwd,
              isReviewArtifact: isReviewArtifactPath(ctx.cwd, rawPath),
              isHtmlArtifact: isHtmlArtifactPathIn(
                this.htmlArtifactDirs,
                absolutePath,
              ),
              wasRead: this.state.hasReadFile(absolutePath),
              wasFreshlyWritten: this.state.wasFileFreshlyWritten(absolutePath),
            };
          })
        : [];

    return decideToolBlock({
      internalExtensionBypass: this.internalExtensionBypassForTurn,
      isPlanPhase: this.state.isPlanPhase(),
      readBeforeWrite: this.config.guards.readBeforeWrite,
      toolName: event.toolName,
      todoToolName: this.getTodoToolNameForCurrentMode(),
      isWriteTool: WRITE_TOOL_NAMES.has(event.toolName),
      isPathGuardedTool: PATH_GUARDED_TOOL_NAMES.has(event.toolName),
      targetResult,
      targets,
    });
  }

  sendReviewWaitMessage(message: string): void {
    this.pi.sendUserMessage(message, { deliverAs: "followUp" });
  }

  async handleAgentEnd(
    event: { messages?: readonly unknown[] },
    ctx: ExtensionContext,
  ): Promise<void> {
    this.updateUi(ctx);
    const latestArtifactPath = this.state.getLatestReviewArtifactPath();
    const latestReviewArtifactApproved =
      this.state.isApprovedReviewArtifactPath(latestArtifactPath);
    if (turnWasAborted(event, ctx)) {
      if (this.state.abortApprovedExecution(latestArtifactPath)) {
        this.persist();
        // Allow one re-review reminder in the next (non-abort) episode.
        this.reReviewReminderSentFor = null;
        // Do NOT sendUserMessage() here. During agent_end the session still
        // counts as streaming (_isAgentRunActive), so the message is queued
        // as a follow-up and the post-run loop continues the agent with
        // agent.continue(). Every following turn-end would hit
        // approvedExecutionNeedsReReview() and queue another follow-up —
        // an infinite self-continuation loop (the "keeps retrying after
        // ESC" bug). Notify via UI instead and let the agent actually stop.
        if (ctx.hasUI) {
          ctx.ui.notify(
            "Execution aborted. Submit the plan for re-review.",
            "info",
          );
        }
        this.finishTurn(ctx);
        return;
      }
      // Aborted turns skip generic plan reminders; still surface this review
      // gate so the next turn does not appear idle while execution is blocked.
      // Use notify() for the same reason — a queued follow-up would keep
      // the agent loop self-continuing.
      if (this.approvedExecutionNeedsReReview(latestArtifactPath)) {
        if (ctx.hasUI) {
          ctx.ui.notify("Plan artifact changed. Submit for re-review.", "info");
        }
        this.finishTurn(ctx);
        return;
      }
      // No approved execution to abort and no artifact to re-review —
      // this is a plain abort in act mode (e.g. user pressed ESC during
      // a tool-calling turn). Notify the user so they know ESC was handled.
      if (ctx.hasUI) {
        ctx.ui.notify("Operation cancelled.", "info");
      }
      this.finishTurn(ctx);
      return;
    }
    if (this.hasPlanReviewObligation() && this.state.todos.length === 0) {
      const todoToolName = this.getTodoToolNameForCurrentMode();
      this.pi.sendUserMessage(
        "Plan Mode requires a concrete TODO list before ending this planning turn. " +
          `Call ${todoToolName} with action ` +
          '"set" or "add", then create and ' +
          `submit a reviewable plan/spec with ${PLANNOTATOR_SUBMIT_TOOL_NAME}. ` +
          `Reason: ${formatPlanDecision(this.state.lastAutoDecision) ?? "plan review required"}.`,
        { deliverAs: "followUp" },
      );
      this.finishTurn(ctx);
      return;
    }

    if (latestArtifactPath) {
      const policyFailure = this.validateArtifactPolicyForPath(
        ctx,
        latestArtifactPath,
        { alreadyApproved: latestReviewArtifactApproved },
      );
      if (policyFailure) {
        // Queue the fix reminder only when the failure changed since the
        // last queue (e.g. the artifact was rewritten). Re-queueing the
        // identical failure on every turn-end would keep the post-run
        // continuation loop spinning forever when the agent does not or
        // cannot fix the artifact.
        if (this.policyReminderSentFor !== policyFailure) {
          this.policyReminderSentFor = policyFailure;
          this.pi.sendUserMessage(policyFailure, { deliverAs: "followUp" });
        }
        this.finishTurn(ctx);
        return;
      }
    }
    // Validation passes or no artifact to validate — allow a future
    // failure to remind without stale marker from an earlier episode.
    this.policyReminderSentFor = null;

    if (this.approvedExecutionNeedsReReview(latestArtifactPath)) {
      // Remind at most once per unapproved episode. Without this guard,
      // every turn-end queues the same follow-up and the post-run loop
      // keeps continuing the agent (agent.continue()) — an infinite
      // self-continuation loop. This is the same "keeps retrying" bug,
      // triggered when the user sends a new message after an ESC abort
      // cleared the plan approval.
      if (this.reReviewReminderSentFor !== latestArtifactPath) {
        this.reReviewReminderSentFor = latestArtifactPath;
        this.sendReviewWaitMessage(APPROVED_ARTIFACT_CHANGED_REVIEW_MESSAGE);
      }
      this.finishTurn(ctx);
      return;
    }

    if (
      this.state.mode === "plan" &&
      this.state.phase === "act" &&
      this.state.pendingApprovedPlanContinuationPath
    ) {
      const runId = this.state.activeRun?.id ?? null;
      const approvedHeadRef = this.state.activeRun?.approvedHeadRef ?? null;
      this.state.clearPendingApprovedPlanContinuation();
      this.persist();
      // Post-execution call-flow summary (opt-in, best-effort). Sent after
      // clearing the continuation so the queued follow-up cannot re-trigger
      // this branch and self-continue the agent loop. The "sent" flag lives
      // on the persisted run so a restart cannot double-send; a re-approval
      // after return-to-draft resets it for the new episode.
      if (
        this.config.callflowSummary &&
        runId !== null &&
        approvedHeadRef !== null &&
        !this.state.activeRun?.callflowSummarySent
      ) {
        if (this.state.activeRun) {
          this.state.activeRun.callflowSummarySent = true;
          this.persist();
        }
        await maybeSendCallflowSummary(this.pi, ctx, approvedHeadRef);
      }
      this.finishTurn(ctx);
      return;
    }

    if (
      this.config.requireReview &&
      this.state.isPlanPhase() &&
      this.state.todos.length > 0 &&
      !latestReviewArtifactApproved
    ) {
      this.pi.sendUserMessage(
        "Plan Mode is waiting for an approved Plannotator plan/spec. Write the plan " +
          `under ${REVIEW_ARTIFACT_LOCATION}, then call ` +
          `${PLANNOTATOR_SUBMIT_TOOL_NAME}. ${REVIEW_ARTIFACT_WRITE_HINT} ` +
          `Reason: ${formatReviewWaitReason(this.state)}.`,
        { deliverAs: "followUp" },
      );
    }
    this.finishTurn(ctx);
  }

  handleToolResult(
    event: ToolResultEvent,
    ctx: ExtensionContext,
  ): ToolResultEventResult | undefined {
    if (event.toolName === "read" && !event.isError) {
      const rawPath = stringProperty(event.input, "path");
      if (rawPath) {
        this.state.markFileRead(normalizeToolPath(ctx.cwd, rawPath));
        this.persist();
      }
      return;
    }

    if (WRITE_TOOL_NAMES.has(event.toolName) && !event.isError) {
      let wroteTrackedPath = false;
      for (const { rawPath } of pathsFromWriteToolInput(event.input)) {
        const absolutePath = normalizeToolPath(ctx.cwd, rawPath);
        this.state.markFileFreshlyWritten(absolutePath);
        wroteTrackedPath = true;
        if (isAutoReviewTargetPath(ctx.cwd, rawPath, this.htmlArtifactDirs)) {
          const policyPath = relativeToolPath(ctx.cwd, rawPath);
          // Validate the date prefix before marking — a wrong-date path
          // should not pollute latestReviewArtifactPath in state.
          const dateError = validatePathDate(policyPath);
          if (dateError) {
            // Fail the tool call with a clear error so the agent learns
            // the date requirement and retries with the correct name.
            try {
              fs.unlinkSync(absolutePath);
            } catch {
              // best-effort cleanup
            }
            return {
              isError: true,
              content: [{ type: "text" as const, text: dateError }],
            };
          }
          this.state.markReviewArtifactWritten(policyPath);
        }
      }
      if (wroteTrackedPath) {
        this.persist();
      }
      return;
    }

    if (event.toolName !== PLANNOTATOR_SUBMIT_TOOL_NAME || event.isError) {
      return;
    }

    const approvedPath = getApprovedReviewPath(event, ctx);
    const reviewArtifactPath =
      approvedPath &&
      isAutoReviewTargetPath(ctx.cwd, approvedPath, this.htmlArtifactDirs)
        ? approvedPath
        : null;
    const pathToQueue = getApprovedReviewPathToQueue({
      reviewArtifactPath,
      latestReviewArtifactPath: this.state.latestReviewArtifactPath,
      alreadyApproved:
        reviewArtifactPath !== null &&
        this.state.isApprovedReviewArtifactPath(reviewArtifactPath),
      pendingApprovedPlanContinuationPath:
        this.state.pendingApprovedPlanContinuationPath,
      confirmedApprovedContinuationPath:
        this.state.confirmedApprovedContinuationPath,
      phase: this.state.phase,
      activePlanPath: this.state.activePlanPath,
    });
    if (pathToQueue === null) {
      return;
    }

    this.state.activePlanPath = pathToQueue;
    this.state.latestReviewArtifactPath = pathToQueue;
    this.state.reviewApprovedPlanPaths.add(pathToQueue);
    // Approval recovers the run; allow a future unapproved episode to
    // send its single re-review reminder again.
    this.reReviewReminderSentFor = null;
    this.state.pendingApprovedPlanContinuationPath = pathToQueue;
    this.state.resumableApprovedPlanPath = pathToQueue;
    if (this.state.activeRun) {
      this.state.activeRun.planPath = pathToQueue;
      this.state.activeRun.status = hasCompletedAllTodos(this.state.todos)
        ? "completed"
        : "executing";
      this.state.activeRun.approvedAt = new Date().toISOString();
      // Capture the baseline ref for the post-execution calldiff summary
      // (best-effort; null outside git).
      this.state.activeRun.approvedHeadRef =
        captureGitHead(ctx.cwd) ?? undefined;
    }
    const wasDirectAct = this.state.mode === "act";
    this.state.switchApprovedPlanToAct(wasDirectAct);
    this.applyMode(ctx);
    this.persist();
  }
}
