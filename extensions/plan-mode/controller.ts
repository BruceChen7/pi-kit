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

import {
  createPublisher,
  isFreshEvent,
  readEvent,
  type SeenEvent,
  seenAfter,
} from "../shared/event-protocol.ts";
import { PLAN_MODE_STATUS_OWNER_CHANNEL } from "../shared/internal-events.ts";
import { uiHostProfile } from "../shared/rich-ui.ts";
import {
  classifyToolCall,
  findToolAnnotations,
  type ToolCallPolicy,
} from "../shared/tool-policy.ts";
import { pathsFromToolArgs } from "../shared/tool-targets.ts";
import { createLinesWidget } from "../shared/widget-lines.ts";
import {
  formatApprovedArtifactPolicyFailure,
  formatArtifactPolicyFailure,
  isStandardPlanArtifactPath,
  validateArtifactPolicy,
} from "./artifact-policy.ts";
import { readPathsFromBashCommand } from "./bash-read-paths.ts";
import {
  ACT_CODE_WRITING_GUIDANCE,
  ACT_TODO_TOOL_NAME,
  BUILTIN_TOOL_NAMES,
  DEFAULT_CONFIG,
  DIRECT_ACT_TODO_GUIDANCE,
  EXECUTION_TODO_DISCIPLINE_GUIDANCE,
  MARKDOWN_PLAN_REVIEW_ARTIFACT_LOCATION,
  MODE_WIDGET_KEY,
  PLAN_INSPECTION_TOOL_SLASH_LIST,
  PLAN_MODE_TOOL_NAMES,
  PLAN_REVIEW_ARTIFACT_GUIDANCE,
  PLAN_SUBMIT_CHECKLIST,
  PLANNOTATOR_SUBMIT_TOOL_NAME,
  REVIEW_ARTIFACT_LOCATION,
  REVIEW_ARTIFACT_WRITE_HINT,
  STATE_ENTRY_TYPE,
  STATUS_KEY,
  TODO_TOOL_NAME,
  TODO_WIDGET_KEY,
} from "./constants.ts";
import {
  decideAgentStartPostActions,
  decideAgentStartPreActions,
  decidePlanReviewObligation,
  getApprovedReviewPathToQueue,
  parseReviewVerdictEvent,
} from "./controller-decisions.ts";
import { decideToolBlock, type GuardPolicyTarget } from "./guard-policy.ts";
import {
  formatReviewWaitReason,
  getApprovedReviewPath,
  isAutoReviewTargetPath,
  isPathGuardedToolCall,
  isReadToolCall,
  isReviewArtifactPath,
  isWriteToolCall,
  normalizeToolPath,
  pathFromToolCall,
  pathsFromToolCall,
  relativeToolPath,
  turnWasAborted,
} from "./guards.ts";
import { isHtmlArtifactPathIn, resolveHtmlArtifactDirs } from "./html-dirs.ts";
import {
  getSessionStateEntries,
  latestSnapshot,
  loadPlanModeConfigWithDiagnostics,
  PlanModeState,
  stringProperty,
} from "./state.ts";
import {
  createTodoCloseoutLedger,
  decideTodoCloseout,
  lastAssistantTextFromMessages,
  type TodoCloseoutLedger,
} from "./todo-closeout.ts";
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
  formatPlanModeStatusLine,
  formatTodoWidgetLines,
  getModeLabel,
} from "./ui.ts";
import {
  claimsStatusSurface,
  decidePlanModeUi,
  type PlanModeUiInput,
} from "./widget-plan.ts";

/** What `handleAgentEnd` did that the caller must react to. */
export type AgentEndOutcome = { kind: "todo-closeout-ask" };

/** widget 观感留在 Shell（Core 只给未上色的内容）：mode widget 整行 accent，TODO 只染标题行。 */
const colorWidgetLines = (
  key: string,
  lines: string[],
  ctx: ExtensionContext,
): string[] => {
  switch (key) {
    case TODO_WIDGET_KEY:
      return colorTodoWidgetHeading(lines, ctx);
    case MODE_WIDGET_KEY:
      return colorModeWidgetLines(lines, ctx);
    default:
      return lines;
  }
};

const PLAN_HEADING_REVIEW_GUIDANCE =
  "Keep the plan's first # heading unchanged across denied revisions unless " +
  "the reviewer explicitly asks for a rename; Plannotator uses that heading " +
  "to group version diffs.";
const REVIEW_APPROVAL_REQUIRED_MESSAGE =
  "Plan approval is no longer active. Review the current plan/spec, make any " +
  "requested changes, and submit it for review before continuing approved execution.";
// ── Date helpers ──────────────────────────────────────────────

/** Regular file on disk, so a shell argument that merely looks like a path
 *  (a sed range, a grep pattern) is never registered as a read. */
const isExistingFile = (absolutePath: string): boolean => {
  try {
    return fs.statSync(absolutePath).isFile();
  } catch {
    return false;
  }
};

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
  //   · review verdict  — a real rejection starts a new unapproved episode.
  //   · approval        — run recovered; future unapproved episodes may
  //                       remind once.
  //   · policy pass     — artifact fixed; a new failure text queues again.
  private reReviewReminderSentFor: string | null = null;
  private policyReminderSentFor: string | null = null;
  // 收尾闸账本：会话内内存态，不进 snapshot（resume 后重新拿一次预算是期望行为）。
  private todoCloseoutLedger: TodoCloseoutLedger = createTodoCloseoutLedger();
  // Session-scoped values, resolved in restore() (no IO at construction).
  // HTML artifact dirs need a `git rev-parse` (repo slug), so they resolve on
  // first use instead of on session_start; only the write guard and the mode
  // prompt read them, both after startup.
  private sessionCwd: string | null = null;
  private htmlArtifactDirsCache: string[] | null = null;
  // pi-web 只在 widget 挂载时判定默认展开，所以“首次出现”要先发短帧（见 widget-plan.ts）。
  private todoWidgetPresent = false;
  // 别的扩展挂上来的一段状态文字（key → text），渲染态，不持久化。
  private badges = new Map<string, string>();
  /** 跨扩展事件的发布实例：序号只在本生命周期内递增。 */
  private readonly events = createPublisher(
    `plan-mode-${Math.random().toString(36).slice(2)}`,
  );
  /** 收到过的 badge 事件，按 key 记最后一次序号，重放/乱序的丢掉。 */
  private readonly seenBadges = new Map<string, SeenEvent>();
  // 上一次广播出去的接管状态；只在翻转时通知生产方。
  private claimedStatusSurface = false;
  constructor(private readonly pi: ExtensionAPI) {}

  restore(ctx: ExtensionContext): void {
    this.sessionCwd = ctx.cwd;
    this.htmlArtifactDirsCache = null;
    const loaded = loadPlanModeConfigWithDiagnostics(ctx.cwd);
    this.config = loaded.config;
    // 被忽略的项目配置不能静默消失：放宽护栏的键要说出来，人才知道去看。
    if (loaded.ignoredProjectKeys.length > 0 && ctx.hasUI) {
      ctx.ui.notify(
        `plan-mode 忽略了几项放宽护栏的项目配置：${loaded.ignoredProjectKeys.join("、")}`,
        "warning",
      );
    }
    const entries = getSessionStateEntries(ctx);
    this.state.restore(latestSnapshot(entries), this.config.defaultMode);
    this.reviewRequiredForTurn = false;
    this.inputSourceForTurn = "unknown";
    this.internalExtensionBypassForTurn = false;
    this.approvedPlanContinuationForTurn = false;
    this.reReviewReminderSentFor = null;
    this.policyReminderSentFor = null;
    this.todoCloseoutLedger = createTodoCloseoutLedger();
    this.todoWidgetPresent = false;
    // badge 是渲染态：换会话/换分支后由生产方下一 tick 重新挂上来。
    this.badges.clear();
    // 复位成「未声明」，下一次 updateUi 会重新广播接管状态。生产方若已经记着
    // 接管，收到重复通知会忽略；生产方重启过则会在这里补上。
    this.claimedStatusSurface = false;
  }

  private get htmlArtifactDirs(): string[] {
    if (this.sessionCwd === null) return [];
    this.htmlArtifactDirsCache ??= resolveHtmlArtifactDirs(this.sessionCwd);
    return this.htmlArtifactDirsCache;
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

    const profile = uiHostProfile(ctx);
    const badges = [...this.badges.values()];
    const input: PlanModeUiInput = {
      host: {
        contentVisibleWithoutInteraction:
          profile.widgets.contentVisibleWithoutInteraction,
        autoExpandedLines: profile.widgets.autoExpandedLines,
        lineLimit: profile.widgets.lineLimit,
        factory: profile.widgets.factory,
      },
      todoWidgetPresent: this.todoWidgetPresent,
      content: {
        todoLines: formatTodoWidgetLines(this.state),
        modeLines: formatModeWidgetLines(this.state, badges),
        statusText: formatPlanModeStatusLine(this.state, badges),
      },
    };
    const decision = decidePlanModeUi(input);

    for (const emission of decision.emissions) {
      switch (emission.kind) {
        case "status":
          ctx.ui.setStatus(emission.key, emission.text);
          break;
        case "widget": {
          const lines = colorWidgetLines(emission.key, emission.lines, ctx);
          if (emission.transport === "component") {
            // 组件工厂绕开宿主对 string[] 的条数裁剪（长 TODO 列表不再被砍）。
            ctx.ui.setWidget(emission.key, createLinesWidget(lines), {
              placement: emission.placement,
            });
          } else {
            ctx.ui.setWidget(emission.key, lines, {
              placement: emission.placement,
            });
          }
          break;
        }
        case "widget-clear":
          ctx.ui.setWidget(emission.key, undefined);
          break;
      }
    }
    this.todoWidgetPresent = decision.todoWidgetPresent;
    this.syncStatusOwner(claimsStatusSurface(input));
  }

  /**
   * 只有翻转时广播：生产方收到后会重画自己的 UI，广播方再重画就会形成同步回环。
   */
  private syncStatusOwner(claimed: boolean): void {
    if (claimed === this.claimedStatusSurface) {
      return;
    }
    this.claimedStatusSurface = claimed;
    try {
      this.pi.events.emit(
        PLAN_MODE_STATUS_OWNER_CHANNEL,
        this.events.next({
          type: "plan-mode.status-owner",
          active: claimed,
        }),
      );
    } catch {
      // 没有订阅者不影响本次渲染。
    }
  }

  /**
   * 另一扩展挂上来的一段状态文字（目前是 subagent 的运行计数）。
   * 文本不变就不重画：每次 tick 都会重复广播同一份内容。
   */
  /**
   * 从一条原始事件里取出 badge 负载：新格式是带序号信封，旧格式是裸负载。
   * 返回 undefined 表示这条事件不该被处理（协议不符、重放、乱序）。
   */
  acceptBadgeEvent(
    raw: unknown,
  ): { key: string; text: string | null } | undefined {
    const event = readEvent<{ key?: unknown; text?: unknown }>(raw);
    if (event === undefined) return undefined;
    const key = event.payload.key;
    if (typeof key !== "string" || key === "") return undefined;
    const seen = this.seenBadges.get(key);
    if (!isFreshEvent(seen, event)) return undefined;
    const next = seenAfter(seen, event);
    if (next !== undefined) this.seenBadges.set(key, next);
    const text = event.payload.text;
    return { key, text: typeof text === "string" ? text : null };
  }

  setBadge(key: string, text: string | null, ctx: ExtensionContext): void {
    if ((this.badges.get(key) ?? null) === text) {
      return;
    }
    if (text === null) {
      this.badges.delete(key);
    } else {
      this.badges.set(key, text);
    }
    this.updateUi(ctx);
  }

  /**
   * badge 只接受本会话的：总线按会话隔离，cwd 不一致说明是上一个会话的残留。
   */
  acceptsBadgeFrom(cwd: string): boolean {
    return this.sessionCwd === null || this.sessionCwd === cwd;
  }

  /**
   * 撤销本扩展在宿主上的 UI，并复位渲染态（session_shutdown 用）。
   *
   * 与 updateUi 分开：这不是「按当前状态再算一遍」，而是一次性清场。badge 必须先清，
   * 否则生产方 shutdown 时补发的 null 会被当成变化，在清场之后再画一帧。
   */
  clearUi(ctx: ExtensionContext): void {
    this.todoWidgetPresent = false;
    this.badges.clear();
    this.claimedStatusSurface = false;
    if (!ctx.hasUI) {
      return;
    }
    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.setWidget(MODE_WIDGET_KEY, undefined);
    ctx.ui.setWidget(TODO_WIDGET_KEY, undefined);
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

    if (effectivePhase === "act") {
      // The artifact policy enforces the same content forms on an act-mode
      // submit, so act mode states the contract before the write instead of
      // bouncing the submission with a format-fix round-trip. Only the
      // checklist goes in: the plan-phase design guidance above it is
      // methodology, and every act turn would pay for it.
      lines.push(...PLAN_SUBMIT_CHECKLIST);
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
    // Persist once at the turn boundary. Tool results no longer persist
    // individually — a single assistant message can carry several parallel
    // tool calls, and persisting per toolResult wrote near-duplicate
    // snapshots (same millisecond, only readFiles/freshlyWrittenFiles
    // differing) into the session JSONL.
    this.persist();
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

    return this.state.getApprovedUnfinishedRunPlanPath();
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

  /**
   * Annotation-based policy for one call. Only MCP tools (`mcp__*`) get a kind
   * other than `"unknown"`; pi-kit's own tools keep the name-based handling in
   * `WRITE_TOOL_NAMES` / `PATH_GUARDED_TOOL_NAMES`.
   */
  private toolCallPolicy(toolName: string, args: unknown): ToolCallPolicy {
    return classifyToolCall({
      toolName,
      args,
      annotations: findToolAnnotations(this.pi.getAllTools?.(), toolName),
    });
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

    const toolPolicy = this.toolCallPolicy(event.toolName, event.input);
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
      isWriteTool: isWriteToolCall(event.toolName, toolPolicy),
      isPathGuardedTool: isPathGuardedToolCall(event.toolName, toolPolicy),
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
  ): Promise<AgentEndOutcome | undefined> {
    this.updateUi(ctx);
    const latestArtifactPath = this.state.getLatestReviewArtifactPath();
    const latestReviewArtifactApproved =
      this.state.isApprovedReviewArtifactPath(latestArtifactPath);
    if (turnWasAborted(event, ctx)) {
      const approvedExecution =
        this.state.getApprovedUnfinishedRunPlanPath() !== null;
      if (approvedExecution) {
        // ESC ends this agent run, not the user's approval of its plan.
        // Notify via UI rather than follow-up so the agent actually stops.
        if (ctx.hasUI) {
          ctx.ui.notify(
            "Execution interrupted. The approved plan remains available.",
            "info",
          );
        }
        this.finishTurn(ctx);
        return;
      }
      // If this active artifact has no live approval, keep its review gate
      // visible even though this turn is stopping.
      if (this.approvedExecutionNeedsReReview(latestArtifactPath)) {
        if (ctx.hasUI) {
          ctx.ui.notify(REVIEW_APPROVAL_REQUIRED_MESSAGE, "info");
        }
        this.finishTurn(ctx);
        return;
      }
      // No live approved execution and no review obligation: plain cancel.
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
      // self-continuation loop. This branch is for a real approval loss,
      // not an interrupted run whose approval remains live.
      if (this.reReviewReminderSentFor !== latestArtifactPath) {
        this.reReviewReminderSentFor = latestArtifactPath;
        this.sendReviewWaitMessage(REVIEW_APPROVAL_REQUIRED_MESSAGE);
      }
      this.finishTurn(ctx);
      return;
    }

    if (
      this.state.mode === "plan" &&
      this.state.phase === "act" &&
      this.state.pendingApprovedPlanContinuationPath
    ) {
      this.state.clearPendingApprovedPlanContinuation();
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

    // The gate lives last so every review/abort branch above keeps its
    // priority. `phase !== "act"` is an explicit criterion, not an accident of
    // branch order: the plan-phase review branch above returns no value and
    // falls through to here.
    const closeout = decideTodoCloseout({
      phase: this.state.phase,
      todos: this.state.todos,
      ledger: this.todoCloseoutLedger,
      runKey: this.state.activeRun?.id ?? null,
      lastAssistantText: lastAssistantTextFromMessages(event.messages ?? []),
      todoToolName: this.getTodoToolNameForCurrentMode(),
    });
    this.todoCloseoutLedger = closeout.ledger;

    if (closeout.kind === "ask") {
      this.pi.sendUserMessage(closeout.message, { deliverAs: "followUp" });
      this.finishTurn(ctx);
      return { kind: "todo-closeout-ask" };
    }
    // A UI note, not a follow-up: the gate has stopped asking and must not
    // open another LLM turn.
    if (closeout.kind === "give-up" && ctx.hasUI) {
      ctx.ui.notify(closeout.note, "info");
    }

    this.finishTurn(ctx);
  }

  handleToolResult(
    event: ToolResultEvent,
    ctx: ExtensionContext,
  ): ToolResultEventResult | undefined {
    const toolPolicy = this.toolCallPolicy(event.toolName, event.input);

    if (event.toolName === "bash" && !event.isError) {
      const command = stringProperty(event.input, "command");
      for (const rawPath of readPathsFromBashCommand(command ?? "")) {
        const absolutePath = normalizeToolPath(ctx.cwd, rawPath);
        if (isExistingFile(absolutePath)) {
          this.state.markFileRead(absolutePath);
        }
      }
      return;
    }

    if (isReadToolCall(event.toolName, toolPolicy) && !event.isError) {
      for (const { rawPath } of pathsFromToolArgs(event.input)) {
        this.state.markFileRead(normalizeToolPath(ctx.cwd, rawPath));
      }
      return;
    }

    if (isWriteToolCall(event.toolName, toolPolicy) && !event.isError) {
      for (const { rawPath } of pathsFromToolArgs(event.input)) {
        const absolutePath = normalizeToolPath(ctx.cwd, rawPath);
        this.state.markFileFreshlyWritten(absolutePath);
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

    this.recordApprovedPlan(ctx, pathToQueue);
  }

  /**
   * Record an approval for `planPath`: the single state transition shared by
   * the submit tool result and a manual review verdict. Ownership stays here;
   * the callers only decide that this path is approved.
   */
  private recordApprovedPlan(ctx: ExtensionContext, planPath: string): void {
    this.state.beginApprovedExecutionRun(planPath);

    this.state.activePlanPath = planPath;
    this.state.latestReviewArtifactPath = planPath;
    this.state.reviewApprovedPlanPaths.add(planPath);
    // Approval recovers the run; allow a future unapproved episode to
    // send its single re-review reminder again.
    this.reReviewReminderSentFor = null;
    this.state.pendingApprovedPlanContinuationPath = planPath;
    this.state.resumableApprovedPlanPath = planPath;
    const wasDirectAct = this.state.mode === "act";
    this.state.switchApprovedPlanToAct(wasDirectAct);
    this.applyMode(ctx);
  }

  /**
   * Manual reviews (picker / annotate-latest) end in plannotator-auto, whose
   * verdict only reached plan-mode through a later submit-tool call. Follow
   * the verdict directly so an approved artifact stops asking for review and
   * a rejected one stops approved execution.
   */
  handleReviewVerdict(raw: unknown, ctx: ExtensionContext): void {
    const verdict = parseReviewVerdictEvent(raw);
    if (verdict === null) {
      return;
    }
    if (path.resolve(verdict.cwd) !== path.resolve(ctx.cwd)) {
      return;
    }
    // Only the artifact this controller is gating: a manual review of some
    // other document must not change the run's approval.
    if (verdict.path !== this.state.getLatestReviewArtifactPath()) {
      return;
    }

    if (verdict.approved) {
      if (this.state.isApprovedReviewArtifactPath(verdict.path)) {
        return;
      }
      this.recordApprovedPlan(ctx, verdict.path);
      // The review runs between agent turns, so no turn-end will persist
      // this transition for us.
      this.persist();
      return;
    }

    this.state.clearApprovalForPlanPath(verdict.path);
    // New unapproved episode: the next turn-end may remind once.
    this.reReviewReminderSentFor = null;
    this.applyMode(ctx);
    this.persist();
  }
}
