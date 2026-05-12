import fs from "node:fs";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import {
  formatApprovedArtifactPolicyFailure,
  formatArtifactPolicyFailure,
  isStandardPlanArtifactPath,
  validateArtifactPolicy,
} from "./artifact-policy.ts";
import {
  ARCHITECTURE_TEST_GUIDANCE,
  BUILTIN_TOOL_NAMES,
  DEFAULT_CONFIG,
  DEFAULT_MODE_SELECTION_TIMEOUT_MS,
  DIRECT_ACT_TODO_GUIDANCE,
  KEY_CODE_SKETCH_GUIDANCE,
  LOGIC_CHANGE_DIAGRAM_GUIDANCE,
  MODE_SELECTION_MESSAGE,
  MODE_SELECTION_OPTIONS,
  MODE_SELECTION_TITLE,
  OUTSIDE_CWD_ALLOWED_TOOL_NAMES,
  PATH_GUARDED_TOOL_NAMES,
  PLAN_INSPECTION_TOOL_COMMA_LIST,
  PLAN_INSPECTION_TOOL_SLASH_LIST,
  PLAN_MODE_TOOL_NAMES,
  PLANNOTATOR_SUBMIT_TOOL_NAME,
  REVIEW_ARTIFACT_LOCATION,
  REVIEW_ARTIFACT_TARGET,
  REVIEW_ARTIFACT_WRITE_GUIDANCE,
  REVIEW_ARTIFACT_WRITE_HINT,
  STATE_ENTRY_TYPE,
  STATUS_KEY,
  TODO_TOOL_NAME,
  TODO_WIDGET_KEY,
  WRITE_TOOL_NAMES,
} from "./constants.ts";
import {
  formatApprovedContinuationFollowUp,
  formatReviewWaitReason,
  getApprovedReviewPath,
  isAllowedPath,
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
  isPlanMode,
  latestSnapshot,
  loadPlanModeConfig,
  PlanModeState,
  promptRequestsPlanMode,
  stringProperty,
} from "./state.ts";
import type { InputSource, PlanMode, PlanModeConfig } from "./types.ts";
import {
  colorTodoWidgetHeading,
  formatPlanDecision,
  formatTodoWidgetLines,
  getModeLabel,
} from "./ui.ts";

export class PlanModeController {
  config: PlanModeConfig = DEFAULT_CONFIG;
  state = new PlanModeState(DEFAULT_CONFIG.defaultMode);
  private reviewRequiredForTurn = false;
  private inputSourceForTurn: InputSource = "unknown";
  private internalExtensionBypassForTurn = false;
  private approvedPlanContinuationForTurn = false;
  private modePromptedForTurn = false;
  constructor(private readonly pi: ExtensionAPI) {}

  restore(ctx: ExtensionContext): void {
    this.config = loadPlanModeConfig(ctx.cwd);
    const entries = getSessionStateEntries(ctx);
    this.state.restore(latestSnapshot(entries), this.config.defaultMode);
    this.reviewRequiredForTurn = false;
    this.inputSourceForTurn = "unknown";
    this.internalExtensionBypassForTurn = false;
    this.approvedPlanContinuationForTurn = false;
    this.modePromptedForTurn = false;
  }

  persist(): void {
    this.pi.appendEntry(STATE_ENTRY_TYPE, this.state.snapshot());
  }

  applyMode(ctx: ExtensionContext): void {
    this.pi.setActiveTools(this.getToolsForCurrentMode());
    this.updateUi(ctx);
  }

  getToolsForCurrentMode(): string[] {
    const stableTools = [...BUILTIN_TOOL_NAMES, TODO_TOOL_NAME];
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
    ctx.ui.notify(`Plan mode: ${getModeLabel(this.state)}`, "info");
  }

  updateUi(ctx: ExtensionContext): void {
    if (!ctx.hasUI) {
      return;
    }

    ctx.ui.setStatus(STATUS_KEY, undefined);

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
    const lines = [
      "## Plan Mode Extension",
      "",
      `Current mode: ${getModeLabel(this.state)}.`,
      "",
      `- In plan phases, inspect with ${PLAN_INSPECTION_TOOL_SLASH_LIST}. ` +
        "Runtime guards block bash and source-code edits.",
      `- Use ${TODO_TOOL_NAME} to maintain the concrete TODO list.`,
      "- For implementation tasks, write only " +
        `${REVIEW_ARTIFACT_TARGET} and submit them with ` +
        `${PLANNOTATOR_SUBMIT_TOOL_NAME}.`,
      `- ${REVIEW_ARTIFACT_WRITE_HINT}`,
      "- Standard plan artifacts must use ## Context, ## Steps, " +
        "## Verification, and ## Review with Chinese checkbox steps.",
      ARCHITECTURE_TEST_GUIDANCE,
      ...LOGIC_CHANGE_DIAGRAM_GUIDANCE,
      ...KEY_CODE_SKETCH_GUIDANCE,
      "- If Plannotator denies the plan, revise the same file and submit again.",
      "- In act phases, execute the approved plan and update " +
        `${TODO_TOOL_NAME} statuses to in_progress and done so the widget shows the current step.`,
    ];

    if (this.state.mode === "act") {
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
    const prompt = stringProperty(event, "prompt") ?? "";
    this.internalExtensionBypassForTurn =
      this.inputSourceForTurn === "extension";

    if (!this.internalExtensionBypassForTurn && this.dismissCompletedRun()) {
      this.updateUi(ctx);
      this.persist();
    }

    if (promptRequestsPlanMode(prompt)) {
      this.setModeWithoutUserNotification(ctx, "plan");
    } else if (this.shouldPromptModeForTurn(ctx)) {
      await this.promptModeForTurn(ctx);
    }

    const confirmedContinuationPath =
      this.state.consumeConfirmedApprovedContinuation();
    const continuesApprovedPlan = confirmedContinuationPath !== null;
    this.approvedPlanContinuationForTurn = continuesApprovedPlan;
    if (continuesApprovedPlan) {
      this.applyMode(ctx);
      this.persist();
    }

    if (
      !this.internalExtensionBypassForTurn &&
      this.state.shouldReturnPlanActToPlan() &&
      !continuesApprovedPlan
    ) {
      this.state.returnPlanActToPlan();
      this.persist();
    }

    this.state.lastAutoDecision = {
      outcome: "plan_required",
      reason: "plan mode requires a reviewed plan/spec",
    };
    this.reviewRequiredForTurn =
      this.state.isPlanPhase() && !this.internalExtensionBypassForTurn;
  }

  clearTurnSource(): void {
    this.inputSourceForTurn = "unknown";
    this.internalExtensionBypassForTurn = false;
    this.approvedPlanContinuationForTurn = false;
    this.modePromptedForTurn = false;
  }

  private dismissCompletedRun(): boolean {
    if (this.state.activeRun?.status !== "completed") {
      return false;
    }
    this.state.archiveCompletedActiveRun();
    this.state.clearTodos();
    return true;
  }

  shouldPromptModeForTurn(ctx: ExtensionContext): boolean {
    return (
      ctx.hasUI &&
      this.state.mode === "act" &&
      !this.modePromptedForTurn &&
      !this.internalExtensionBypassForTurn &&
      this.inputSourceForTurn === "interactive"
    );
  }

  setModeWithoutUserNotification(ctx: ExtensionContext, mode: PlanMode): void {
    this.state.setMode(mode);
    this.applyMode(ctx);
    this.persist();
  }

  async promptModeForTurn(ctx: ExtensionContext): Promise<void> {
    this.modePromptedForTurn = true;
    ctx.ui.notify(MODE_SELECTION_MESSAGE, "info");
    const selected = await ctx.ui.select(
      MODE_SELECTION_TITLE,
      MODE_SELECTION_OPTIONS,
      { timeout: DEFAULT_MODE_SELECTION_TIMEOUT_MS },
    );
    this.setModeWithoutUserNotification(
      ctx,
      isPlanMode(selected) ? selected : "act",
    );
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
        const absolutePath = normalizeToolPath(ctx.cwd, rawPath);
        if (
          this.config.guards.cwdOnly &&
          !isAllowedPath(absolutePath, ctx.cwd, this.config.guards.allowedPaths)
        ) {
          return {
            block: true,
            reason:
              `plan-mode blocked ${event.toolName}: path is outside cwd and ` +
              `allowed paths: ${rawPath}`,
          };
        }

        const policyFailure = this.validateArtifactPolicyForPath(ctx, rawPath);
        if (policyFailure) {
          return {
            block: true,
            reason: policyFailure,
          };
        }
      }
    }

    if (this.state.isPlanPhase() && event.toolName === "bash") {
      return {
        block: true,
        reason:
          `plan-mode blocked ${event.toolName}: current phase is read-only. ` +
          `Use ${PLAN_INSPECTION_TOOL_COMMA_LIST}, and ${TODO_TOOL_NAME}.`,
      };
    }

    if (this.state.isPlanPhase() && WRITE_TOOL_NAMES.has(event.toolName)) {
      const rawPath = pathFromToolCall(event);
      if (rawPath && isReviewArtifactPath(ctx.cwd, rawPath)) {
        return undefined;
      }
      return {
        block: true,
        reason:
          `plan-mode blocked ${event.toolName}: current phase can only write ` +
          REVIEW_ARTIFACT_WRITE_GUIDANCE,
      };
    }

    if (!this.config.guards.cwdOnly && !this.config.guards.readBeforeWrite) {
      return undefined;
    }

    if (!PATH_GUARDED_TOOL_NAMES.has(event.toolName)) {
      return undefined;
    }

    const targetResult = pathsFromToolCall(event);
    if (targetResult.kind === "unresolved-write") {
      return {
        block: true,
        reason: `plan-mode blocked ${event.toolName}: ${targetResult.reason}`,
      };
    }

    for (const { rawPath } of targetResult.paths) {
      const absolutePath = normalizeToolPath(ctx.cwd, rawPath);

      if (
        !OUTSIDE_CWD_ALLOWED_TOOL_NAMES.has(event.toolName) &&
        this.config.guards.cwdOnly &&
        !isAllowedPath(absolutePath, ctx.cwd, this.config.guards.allowedPaths)
      ) {
        return {
          block: true,
          reason:
            `plan-mode blocked ${event.toolName}: path is outside cwd and ` +
            `allowed paths: ${rawPath}`,
        };
      }

      if (
        this.config.guards.readBeforeWrite &&
        WRITE_TOOL_NAMES.has(event.toolName) &&
        fs.existsSync(absolutePath) &&
        !this.state.readFiles.has(absolutePath)
      ) {
        return {
          block: true,
          reason:
            `plan-mode blocked ${event.toolName}: read the file first before ` +
            `modifying it: ${rawPath}`,
        };
      }
    }

    return undefined;
  }

  async handleAgentEnd(
    event: { messages?: readonly unknown[] },
    ctx: ExtensionContext,
  ): Promise<void> {
    this.updateUi(ctx);
    if (turnWasAborted(event, ctx)) {
      this.clearTurnSource();
      return;
    }
    if (this.hasPlanReviewObligation() && this.state.todos.length === 0) {
      this.pi.sendUserMessage(
        "Plan Mode requires a concrete TODO list before ending this planning turn. " +
          `Call ${TODO_TOOL_NAME} with action "set" or "add", then create and ` +
          `submit a reviewable plan/spec with ${PLANNOTATOR_SUBMIT_TOOL_NAME}. ` +
          `Reason: ${formatPlanDecision(this.state.lastAutoDecision) ?? "plan review required"}.`,
        { deliverAs: "followUp" },
      );
      this.clearTurnSource();
      return;
    }

    const latestArtifactPath = this.state.getLatestReviewArtifactPath();
    const latestReviewArtifactApproved =
      this.state.isApprovedReviewArtifactPath(latestArtifactPath);
    if (latestArtifactPath) {
      const policyFailure = this.validateArtifactPolicyForPath(
        ctx,
        latestArtifactPath,
        { alreadyApproved: latestReviewArtifactApproved },
      );
      if (policyFailure) {
        this.pi.sendUserMessage(policyFailure, { deliverAs: "followUp" });
        this.clearTurnSource();
        return;
      }
    }

    const pendingContinuationPath =
      this.state.pendingApprovedPlanContinuationPath;
    if (
      this.state.mode === "plan" &&
      this.state.phase === "act" &&
      pendingContinuationPath
    ) {
      this.handlePendingApprovedContinuation(pendingContinuationPath);
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
    this.clearTurnSource();
  }

  handlePendingApprovedContinuation(pendingContinuationPath: string): void {
    this.state.clearPendingApprovedPlanContinuation();
    this.state.confirmApprovedContinuation(pendingContinuationPath);
    this.persist();
    this.pi.sendUserMessage(
      formatApprovedContinuationFollowUp(pendingContinuationPath),
      { deliverAs: "followUp" },
    );
    this.clearTurnSource();
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
      const rawPath = stringProperty(event.input, "path");
      if (rawPath && isReviewArtifactPath(ctx.cwd, rawPath)) {
        this.state.latestReviewArtifactPath = relativeToolPath(
          ctx.cwd,
          rawPath,
        );
        this.persist();
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
