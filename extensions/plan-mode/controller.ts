import fs from "node:fs";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { pathsFromWriteToolInput } from "../shared/tool-targets.ts";
import {
  formatApprovedArtifactPolicyFailure,
  formatArtifactPolicyFailure,
  isStandardPlanArtifactPath,
  validateArtifactPolicy,
} from "./artifact-policy.ts";
import {
  ACT_CODE_WRITING_GUIDANCE,
  ACT_TODO_TOOL_NAME,
  BUILTIN_TOOL_NAMES,
  DEFAULT_CONFIG,
  DIRECT_ACT_TODO_GUIDANCE,
  HTML_PLAN_FORMAT_GUIDANCE,
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
import { decideToolBlock, type GuardPolicyTarget } from "./guard-policy.ts";
import {
  formatReviewWaitReason,
  getApprovedReviewPath,
  isReviewArtifactPath,
  normalizeToolPath,
  pathFromToolCall,
  pathsFromToolCall,
  relativeToolPath,
  turnWasAborted,
} from "./guards.ts";
import {
  getSessionStateEntries,
  hasCompletedAllTodos,
  latestSnapshot,
  loadPlanModeConfig,
  PlanModeState,
  promptRequestsPlanMode,
  stringProperty,
} from "./state.ts";
import type {
  InputSource,
  PlanArtifactFormat,
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
const APPROVED_EXECUTION_ABORTED_REVIEW_MESSAGE =
  "Plan Mode is waiting for an approved Plannotator plan/spec. The " +
  "approved execution was aborted by the user and must be reviewed again " +
  "before continuing.";

type AgentStartPreDecisionInput = {
  inputSourceForTurn: InputSource;
  prompt: string;
  hasCompletedNonApprovedRun: boolean;
};

type AgentStartPreDecision = {
  internalExtensionBypass: boolean;
  shouldDismissCompletedNonApprovedRun: boolean;
  shouldEnterPlanMode: boolean;
};

const decideAgentStartPreActions = ({
  inputSourceForTurn,
  prompt,
  hasCompletedNonApprovedRun,
}: AgentStartPreDecisionInput): AgentStartPreDecision => {
  const internalExtensionBypass = inputSourceForTurn === "extension";
  return {
    internalExtensionBypass,
    shouldDismissCompletedNonApprovedRun:
      !internalExtensionBypass && hasCompletedNonApprovedRun,
    shouldEnterPlanMode:
      !internalExtensionBypass && promptRequestsPlanMode(prompt),
  };
};

type AgentStartPostDecisionInput = {
  internalExtensionBypass: boolean;
  continuesApprovedPlan: boolean;
  isPlanPhase: boolean;
  isApprovedCompletedPlanActRun: boolean;
  canReturnPlanActToPlan: boolean;
};

type AgentStartPostDecision = {
  reviewRequiredForTurn: boolean;
  shouldCompleteApprovedRun: boolean;
  shouldReturnPlanActToPlan: boolean;
};

const decideAgentStartPostActions = ({
  internalExtensionBypass,
  continuesApprovedPlan,
  isPlanPhase,
  isApprovedCompletedPlanActRun,
  canReturnPlanActToPlan,
}: AgentStartPostDecisionInput): AgentStartPostDecision => ({
  reviewRequiredForTurn: isPlanPhase && !internalExtensionBypass,
  shouldCompleteApprovedRun:
    !internalExtensionBypass &&
    isApprovedCompletedPlanActRun &&
    !continuesApprovedPlan,
  shouldReturnPlanActToPlan:
    !internalExtensionBypass &&
    canReturnPlanActToPlan &&
    !continuesApprovedPlan,
});

export class PlanModeController {
  config: PlanModeConfig = DEFAULT_CONFIG;
  state = new PlanModeState(DEFAULT_CONFIG.defaultMode);
  private reviewRequiredForTurn = false;
  private inputSourceForTurn: InputSource = "unknown";
  private internalExtensionBypassForTurn = false;
  private approvedPlanContinuationForTurn = false;
  constructor(private readonly pi: ExtensionAPI) {}

  restore(ctx: ExtensionContext): void {
    this.config = loadPlanModeConfig(ctx.cwd);
    const entries = getSessionStateEntries(ctx);
    this.state.restore(latestSnapshot(entries), this.config.defaultMode);
    this.reviewRequiredForTurn = false;
    this.inputSourceForTurn = "unknown";
    this.internalExtensionBypassForTurn = false;
    this.approvedPlanContinuationForTurn = false;
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

  setPlanArtifactFormat(
    ctx: ExtensionContext,
    format: PlanArtifactFormat,
  ): void {
    this.state.setPlanArtifactFormatOverride(format);
    this.applyMode(ctx);
    this.persist();
    ctx.ui.notify(`Plan artifact format: ${format} (session override)`, "info");
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
    const format = this.state.getPlanArtifactFormat(this.config);
    const reviewArtifactLocation =
      format === "html"
        ? ".pi/plans/<repo>/plan/YYYY-MM-DD-<slug>.html"
        : MARKDOWN_PLAN_REVIEW_ARTIFACT_LOCATION;
    const lines = [
      "## Plan Mode Extension",
      "",
      `Current workflow: ${
        this.internalExtensionBypassForTurn ? "Act" : getModeLabel(this.state)
      }.`,
      `Plan artifact format: ${format} ` +
        `(${this.state.getPlanArtifactFormatSource(this.config)}).`,
      "",
      `- In plan phases, inspect with ${PLAN_INSPECTION_TOOL_SLASH_LIST}. ` +
        "Runtime guards block bash and source-code edits.",
      `- Use ${todoToolName} to maintain the concrete TODO list.`,
      "- For implementation tasks, write only reviewable artifacts under " +
        `${reviewArtifactLocation} and submit them with ` +
        `${PLANNOTATOR_SUBMIT_TOOL_NAME}.`,
      `- ${REVIEW_ARTIFACT_WRITE_HINT}`,
      ...(format === "html"
        ? HTML_PLAN_FORMAT_GUIDANCE
        : [
            "- Standard plan artifacts must use ## Context, ## Steps, " +
              "## Verification, and ## Review with Chinese checkbox steps.",
          ]),
      "- If Plannotator denies the plan, revise the same file and submit again.",
      `- ${PLAN_HEADING_REVIEW_GUIDANCE}`,
      "- During approved execution, execute the approved plan and update " +
        `${todoToolName} statuses to in_progress and done so the widget shows ` +
        "the current step.",
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
    if (this.internalExtensionBypassForTurn) {
      return false;
    }
    if (!this.state.isPlanPhase()) {
      return false;
    }
    if (this.state.mode === "plan") {
      return true;
    }
    return (
      this.reviewRequiredForTurn ||
      this.state.todos.length > 0 ||
      this.state.latestReviewArtifactPath !== null
    );
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
      config: this.config.artifactPolicy,
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
              wasRead: this.state.readFiles.has(absolutePath),
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
        this.sendReviewWaitMessage(APPROVED_EXECUTION_ABORTED_REVIEW_MESSAGE);
        this.finishTurn(ctx);
        return;
      }
      // Aborted turns skip generic plan reminders; still surface this review
      // gate so the next turn does not appear idle while execution is blocked.
      if (this.approvedExecutionNeedsReReview(latestArtifactPath)) {
        this.sendReviewWaitMessage(APPROVED_ARTIFACT_CHANGED_REVIEW_MESSAGE);
        this.finishTurn(ctx);
        return;
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
        this.pi.sendUserMessage(policyFailure, { deliverAs: "followUp" });
        this.finishTurn(ctx);
        return;
      }
    }

    if (this.approvedExecutionNeedsReReview(latestArtifactPath)) {
      this.sendReviewWaitMessage(APPROVED_ARTIFACT_CHANGED_REVIEW_MESSAGE);
      this.finishTurn(ctx);
      return;
    }

    if (
      this.state.mode === "plan" &&
      this.state.phase === "act" &&
      this.state.pendingApprovedPlanContinuationPath
    ) {
      this.state.clearPendingApprovedPlanContinuation();
      this.persist();
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

  handleToolResult(event: ToolResultEvent, ctx: ExtensionContext): void {
    if (event.toolName === "read" && !event.isError) {
      const rawPath = stringProperty(event.input, "path");
      if (rawPath) {
        this.state.readFiles.add(normalizeToolPath(ctx.cwd, rawPath));
        this.persist();
      }
      return;
    }

    if (WRITE_TOOL_NAMES.has(event.toolName) && !event.isError) {
      for (const { rawPath } of pathsFromWriteToolInput(event.input)) {
        if (isReviewArtifactPath(ctx.cwd, rawPath)) {
          this.state.markReviewArtifactWritten(
            relativeToolPath(ctx.cwd, rawPath),
          );
          this.persist();
        }
      }
      return;
    }

    if (event.toolName !== PLANNOTATOR_SUBMIT_TOOL_NAME || event.isError) {
      return;
    }

    const approvedPath = getApprovedReviewPath(event, ctx);
    if (!approvedPath || !isReviewArtifactPath(ctx.cwd, approvedPath)) {
      return;
    }

    const latestPath = this.state.latestReviewArtifactPath;
    if (latestPath && approvedPath !== latestPath) {
      return;
    }

    const approvalAlreadyQueued =
      this.state.isApprovedReviewArtifactPath(approvedPath) &&
      (this.state.pendingApprovedPlanContinuationPath === approvedPath ||
        this.state.confirmedApprovedContinuationPath === approvedPath ||
        (this.state.phase === "act" &&
          this.state.activePlanPath === approvedPath));
    if (approvalAlreadyQueued) {
      return;
    }

    this.state.activePlanPath = approvedPath;
    this.state.latestReviewArtifactPath = approvedPath;
    this.state.reviewApprovedPlanPaths.add(approvedPath);
    this.state.pendingApprovedPlanContinuationPath = approvedPath;
    this.state.resumableApprovedPlanPath = approvedPath;
    if (this.state.activeRun) {
      this.state.activeRun.planPath = approvedPath;
      this.state.activeRun.status = hasCompletedAllTodos(this.state.todos)
        ? "completed"
        : "executing";
      this.state.activeRun.approvedAt = new Date().toISOString();
    }
    this.state.switchApprovedPlanToAct();
    this.applyMode(ctx);
    this.persist();
  }
}
