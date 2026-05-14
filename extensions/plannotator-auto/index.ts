import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
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
  checkRepoDirty,
  DEFAULT_GIT_TIMEOUT_MS,
  getGitCommonDir,
  getRepoRoot,
} from "../shared/git.ts";
import {
  createHandledState,
  type PiKitPlannotatorPendingReviewEvent,
  PLANNOTATOR_PENDING_REVIEW_CHANNEL,
} from "../shared/internal-events.ts";
import { createLogger } from "../shared/logger.ts";
import { loadSettings } from "../shared/settings.ts";
import type {
  ActivePlanReview,
  ExtraReviewTarget,
  PendingPlanReview,
  PlanFileConfig,
  ReviewTargetKind,
  SessionKeyContext,
} from "./plan-review/types.ts";

type ExtraReviewTargetConfig = {
  dir: string;
  filePattern: string;
};

type PlannotatorAutoConfig = {
  planFile?: string | null;
  extraReviewTargets?: ExtraReviewTargetConfig[];
  codeReviewAutoTrigger?: boolean;
};

type PlannotatorAutoSettings = {
  planFile?: unknown;
  extraReviewTargets?: unknown;
  codeReviewAutoTrigger?: unknown;
};

type ActiveCodeReview = {
  requestKey: string;
  startedAt: number;
};

type PlanReviewSubmitToolParams = {
  path?: unknown;
};

type SessionReviewDocument = {
  absolutePath: string;
  mtimeMs: number;
  updatedAt: number;
};

type PendingPlanReviewEventHandle = {
  markHandled: () => void;
};

type PlanReviewDecisionLike = {
  approved?: boolean;
  feedback?: string;
};

type CodeReviewDecision = {
  approved: boolean;
  feedback?: string;
  annotations?: unknown[];
};

type SessionRuntimeState = {
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

const DEFAULT_PLAN_SUBDIR = "plan";
const DEFAULT_SPECS_SUBDIR = "specs";
const DEFAULT_ISSUES_SUBDIR = "issues";
const DEFAULT_CODE_REVIEW_RETRY_DELAY_MS = 1_000;
const SYNC_PLANNOTATOR_TIMEOUT_MS = 4 * 60 * 60 * 1_000;
const SYNC_CODE_REVIEW_TIMEOUT_MS = SYNC_PLANNOTATOR_TIMEOUT_MS;
const SYNC_ANNOTATE_TIMEOUT_MS = SYNC_PLANNOTATOR_TIMEOUT_MS;
const PLAN_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}-.+\.(?:md|html)$/;
const SPEC_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}-.+-design\.md$/;
// Issue files intentionally allow any Markdown basename under a topic slug.
const ISSUE_FILE_PATTERN = /^.+\.md$/;
const REVIEW_WIDGET_KEY = "plannotator-auto-review";
const MANUAL_CODE_REVIEW_COMMAND = "plannotator-review";
const MANUAL_CODE_REVIEW_SHORTCUT = "ctrl+shift+r";
const ANNOTATE_LATEST_DOCUMENT_SHORTCUT = "ctrl+alt+l";
const PLAN_REVIEW_SUBMIT_TOOL = "plannotator_auto_submit_review";
const KEEP_PLAN_HEADING_GUIDANCE =
  "Keep the first # heading unchanged unless the reviewer explicitly asks you " +
  "to rename the plan; Plannotator uses that heading to show version diffs.";
const planReviewSubmitToolParameters = Type.Object({
  path: Type.String({ description: "Pending review target path" }),
});
const sessionRuntimeState = new Map<string, SessionRuntimeState>();
const sessionContextByKey = new Map<string, ExtensionContext>();

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

const listPendingPlanReviews = (
  state: SessionRuntimeState,
  cwd: string,
): PendingPlanReview[] => {
  const pendingTargets = findPendingPlanReviewTargets(state, cwd);
  return pendingTargets ? Array.from(pendingTargets.values()) : [];
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

const setReviewWidget = (ctx: ExtensionContext): void => {
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

const clearReviewWidget = (ctx: ExtensionContext): void => {
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

const getGateablePendingPlanReviews = (
  state: SessionRuntimeState,
  cwd: string,
): PendingPlanReview[] => {
  if (state.activePlanReviewByCwd.has(cwd)) {
    return [];
  }

  return listPendingPlanReviews(state, cwd);
};

const isPlanReviewSettled = (
  state: SessionRuntimeState,
  cwd: string,
): boolean =>
  !state.activePlanReviewByCwd.has(cwd) &&
  (findPendingPlanReviewTargets(state, cwd)?.size ?? 0) === 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const sanitizeExtraReviewTargets = (
  value: unknown,
): ExtraReviewTargetConfig[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const next = value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }

    const dir = typeof entry.dir === "string" ? entry.dir.trim() : "";
    const filePattern =
      typeof entry.filePattern === "string" ? entry.filePattern.trim() : "";
    if (dir.length === 0 || filePattern.length === 0) {
      return [];
    }

    return [{ dir, filePattern }];
  });

  return next.length > 0 ? next : undefined;
};

const sanitizeConfig = (value: unknown): PlannotatorAutoConfig => {
  if (!isRecord(value)) {
    return {};
  }

  const raw = value as PlannotatorAutoSettings;
  const next: PlannotatorAutoConfig = {};

  if (raw.planFile === null) {
    next.planFile = null;
  } else if (typeof raw.planFile === "string") {
    const trimmed = raw.planFile.trim();
    if (trimmed.length > 0) {
      next.planFile = trimmed;
    }
  }

  const extraReviewTargets = sanitizeExtraReviewTargets(raw.extraReviewTargets);
  if (extraReviewTargets) {
    next.extraReviewTargets = extraReviewTargets;
  }

  if (typeof raw.codeReviewAutoTrigger === "boolean") {
    next.codeReviewAutoTrigger = raw.codeReviewAutoTrigger;
  }

  return next;
};

let log: ReturnType<typeof createLogger> | null = null;

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

const getSessionState = (ctx: SessionKeyContext): SessionRuntimeState => {
  const key = getSessionKey(ctx);
  const cached = sessionRuntimeState.get(key);
  if (cached) {
    return cached;
  }

  const next = createSessionRuntimeState();
  sessionRuntimeState.set(key, next);
  return next;
};

const clearSessionState = (sessionKey: string): void => {
  const state = sessionRuntimeState.get(sessionKey);
  if (!state) {
    return;
  }

  if (state.pendingReviewRetry) {
    clearTimeout(state.pendingReviewRetry);
  }

  sessionRuntimeState.delete(sessionKey);
};

const loadConfig = (
  cwd: string,
  options?: {
    forceReload?: boolean;
  },
): PlannotatorAutoConfig => {
  const { merged } = loadSettings(cwd, options);
  const config = sanitizeConfig(merged.plannotatorAuto);
  log?.debug("plannotator-auto config loaded", {
    cwd,
    planFile: config.planFile,
    extraReviewTargetCount: config.extraReviewTargets?.length ?? 0,
    codeReviewAutoTrigger: config.codeReviewAutoTrigger ?? false,
  });
  return config;
};

const isCodeReviewAutoTriggerEnabled = (
  ctx: Pick<ExtensionContext, "cwd">,
): boolean => loadConfig(ctx.cwd).codeReviewAutoTrigger ?? false;

const resolveRepoSlugFromGitCommonDir = (cwd: string): string | null => {
  const commonDir = getGitCommonDir(cwd, DEFAULT_GIT_TIMEOUT_MS);
  if (!commonDir) {
    return null;
  }

  const candidate = path.basename(path.dirname(commonDir)).trim();
  return candidate.length > 0 ? candidate : null;
};

const getDefaultReviewRoots = (cwd: string): string[] => {
  const candidates = [
    resolveRepoSlugFromGitCommonDir(cwd),
    path.basename(cwd).trim(),
  ].filter((candidate): candidate is string => Boolean(candidate));

  return Array.from(
    new Set(
      candidates.map((candidate) => path.join(".pi", "plans", candidate)),
    ),
  );
};

const getDefaultPlanDirs = (cwd: string): string[] =>
  getDefaultReviewRoots(cwd).map((root) =>
    path.join(root, DEFAULT_PLAN_SUBDIR),
  );

const getDefaultSpecDirs = (cwd: string): string[] =>
  getDefaultReviewRoots(cwd).map((root) =>
    path.join(root, DEFAULT_SPECS_SUBDIR),
  );

const resolveExtraReviewTargets = (
  cwd: string,
  extraReviewTargets: ExtraReviewTargetConfig[] | undefined,
): ExtraReviewTarget[] =>
  (extraReviewTargets ?? []).flatMap((target) => {
    try {
      return [
        {
          dir: path.resolve(cwd, target.dir),
          pattern: new RegExp(target.filePattern),
        },
      ];
    } catch {
      return [];
    }
  });

const toRepoRelativePath = (
  ctx: Pick<ExtensionContext, "cwd">,
  targetPath: string,
): string => {
  const relative = path.relative(ctx.cwd, targetPath);
  if (
    relative.length > 0 &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  ) {
    return relative;
  }

  return targetPath;
};

const isDirectChildFileMatch = (
  dir: string,
  pattern: RegExp,
  targetPath: string,
): boolean => {
  if (path.dirname(targetPath) !== dir) {
    return false;
  }

  return pattern.test(path.basename(targetPath));
};

const isPlanFileMatch = (planDir: string, targetPath: string): boolean =>
  isDirectChildFileMatch(planDir, PLAN_FILE_PATTERN, targetPath);

const isPlanFileMatchAny = (planDirs: string[], targetPath: string): boolean =>
  planDirs.some((planDir) => isPlanFileMatch(planDir, targetPath));

const isSpecFileMatch = (specDir: string, targetPath: string): boolean =>
  isDirectChildFileMatch(specDir, SPEC_FILE_PATTERN, targetPath);

const isExtraReviewTargetMatch = (
  target: ExtraReviewTarget,
  targetPath: string,
): boolean => isDirectChildFileMatch(target.dir, target.pattern, targetPath);

const isSpecFileMatchAny = (specDirs: string[], targetPath: string): boolean =>
  specDirs.some((specDir) => isSpecFileMatch(specDir, targetPath));

const getWildcardReviewTargetKind = (
  plansRoot: string,
  targetPath: string,
): ReviewTargetKind | null => {
  const relative = path.relative(plansRoot, targetPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }

  const parts = relative.split(path.sep);
  const [repoSlug, targetDir, fileName, issueFileName] = parts;
  if (!repoSlug || !targetDir) {
    return null;
  }

  if (parts.length === 3) {
    if (targetDir === DEFAULT_PLAN_SUBDIR && PLAN_FILE_PATTERN.test(fileName)) {
      return "plan";
    }

    if (
      targetDir === DEFAULT_SPECS_SUBDIR &&
      SPEC_FILE_PATTERN.test(fileName)
    ) {
      return "spec";
    }
  }

  const topicSlug = fileName;
  if (
    parts.length === 4 &&
    targetDir === DEFAULT_ISSUES_SUBDIR &&
    Boolean(topicSlug) &&
    ISSUE_FILE_PATTERN.test(issueFileName)
  ) {
    // Issue drafts reuse the existing plan-review action.
    return "plan";
  }

  return null;
};

const getWildcardPlansRootFromConfig = (planConfig: PlanFileConfig): string =>
  path.dirname(path.dirname(planConfig.resolvedPlanPath));

const isExtraReviewTargetMatchAny = (
  targets: ExtraReviewTarget[] | undefined,
  targetPath: string,
): boolean =>
  (targets ?? []).some((target) =>
    isExtraReviewTargetMatch(target, targetPath),
  );

const resolvePlanPath = (cwd: string, planFile: string): string =>
  path.resolve(cwd, planFile);

const resolvePlanPaths = (cwd: string, planFiles: string[]): string[] =>
  planFiles.map((planFile) => resolvePlanPath(cwd, planFile));

const getPlanFileConfig = (ctx: ExtensionContext): PlanFileConfig | null => {
  const config = loadConfig(ctx.cwd);
  if (config.planFile === null) {
    return null;
  }

  const planFiles = config.planFile
    ? [config.planFile]
    : getDefaultPlanDirs(ctx.cwd);
  const specFiles = config.planFile
    ? planFiles.map((planFile) =>
        path.join(path.dirname(planFile), DEFAULT_SPECS_SUBDIR),
      )
    : getDefaultSpecDirs(ctx.cwd);
  const planFile = planFiles[0];
  const resolvedPlanPath = resolvePlanPath(ctx.cwd, planFile);
  const resolvedPlanPaths = resolvePlanPaths(ctx.cwd, planFiles);
  const resolvedSpecPaths = resolvePlanPaths(ctx.cwd, specFiles);
  const extraReviewTargets = resolveExtraReviewTargets(
    ctx.cwd,
    config.extraReviewTargets,
  );

  log?.debug("plannotator-auto resolved plan directory", {
    planFile,
    resolvedPlanPath,
    resolvedPlanPaths,
    resolvedSpecPaths,
    extraReviewTargets,
  });

  return {
    planFile,
    resolvedPlanPath,
    resolvedPlanPaths,
    resolvedSpecPaths,
    extraReviewTargets,
  };
};

const resolveToolPath = (args: unknown): string | null => {
  if (!isRecord(args)) {
    return null;
  }

  const value = args.path;
  return typeof value === "string" ? value : null;
};

const BASH_OUTPUT_PATH_PATTERN =
  /(?:>>|>|tee\s+(?:-[a-zA-Z]+\s+)*)\s*([^\s;&|]+)/g;

const stripShellQuotes = (value: string): string =>
  value.replace(/^(["'])(.*)\1$/, "$2");

const extractBashPathCandidates = (args: unknown): string[] => {
  if (!isRecord(args) || typeof args.command !== "string") {
    return [];
  }

  const paths = Array.from(args.command.matchAll(BASH_OUTPUT_PATH_PATTERN))
    .map((match) => match[1])
    .filter((value): value is string => Boolean(value))
    .map(stripShellQuotes);

  return Array.from(new Set(paths));
};

const summarizeToolArgs = (
  args: unknown,
): {
  argsType: string;
  argKeys: string[] | null;
} => {
  if (isRecord(args)) {
    return {
      argsType: "object",
      argKeys: Object.keys(args),
    };
  }

  if (Array.isArray(args)) {
    return {
      argsType: "array",
      argKeys: null,
    };
  }

  return {
    argsType: typeof args,
    argKeys: null,
  };
};

type ReviewTargetMatch = {
  kind: ReviewTargetKind;
  reviewFile: string;
};

const getReviewTargetKind = (
  planConfig: PlanFileConfig,
  targetPath: string,
  wildcardPlansRoot: string,
): ReviewTargetKind | null => {
  if (isPlanFileMatchAny(planConfig.resolvedPlanPaths, targetPath)) {
    return "plan";
  }

  if (isSpecFileMatchAny(planConfig.resolvedSpecPaths, targetPath)) {
    return "spec";
  }

  const wildcardKind = getWildcardReviewTargetKind(
    wildcardPlansRoot,
    targetPath,
  );
  if (wildcardKind) {
    return wildcardKind;
  }

  if (isExtraReviewTargetMatchAny(planConfig.extraReviewTargets, targetPath)) {
    return "plan";
  }

  return null;
};

const resolveReviewTargetMatch = (
  ctx: Pick<ExtensionContext, "cwd">,
  planConfig: PlanFileConfig,
  targetPath: string,
): ReviewTargetMatch | null => {
  const kind = getReviewTargetKind(
    planConfig,
    targetPath,
    path.resolve(ctx.cwd, ".pi", "plans"),
  );
  if (!kind) {
    return null;
  }

  return {
    kind,
    reviewFile: toRepoRelativePath(ctx, targetPath),
  };
};

export const resolvePlanFileForReview = (
  ctx: Pick<ExtensionContext, "cwd">,
  planConfig: PlanFileConfig,
  targetPath: string,
): string | null =>
  resolveReviewTargetMatch(ctx, planConfig, targetPath)?.reviewFile ?? null;

export const shouldQueueReviewForToolPath = (
  planConfig: PlanFileConfig | null,
  targetPath: string,
): boolean => {
  if (!planConfig) {
    return true;
  }

  return !getReviewTargetKind(
    planConfig,
    targetPath,
    getWildcardPlansRootFromConfig(planConfig),
  );
};

const isReviewDocumentPath = (targetPath: string): boolean =>
  [".md", ".html"].includes(path.extname(targetPath).toLowerCase());

const isHtmlPath = (targetPath: string): boolean =>
  path.extname(targetPath).toLowerCase() === ".html";

type CliReviewDecision = {
  approved: boolean;
  feedback?: string;
  exit?: boolean;
};

type CliReviewResult =
  | { status: "handled"; result: CliReviewDecision }
  | { status: "error"; error: string }
  | { status: "aborted" };

type RunPlannotatorCliOptions = {
  input?: string;
  parseStdout: (stdout: string) => CliReviewDecision;
  signal?: AbortSignal;
  timeoutMs: number;
};

const runPlannotatorCli = async (
  ctx: Pick<ExtensionContext, "cwd">,
  args: string[],
  options: RunPlannotatorCliOptions,
): Promise<CliReviewResult> =>
  new Promise((resolve) => {
    const child = spawn("plannotator", args, {
      cwd: ctx.cwd,
      env: { ...process.env, PLANNOTATOR_CWD: ctx.cwd },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let aborted = Boolean(options.signal?.aborted);

    const cleanup = () => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
    };
    const finish = (result: CliReviewResult) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };
    const abort = () => {
      aborted = true;
      child.kill();
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish({ status: "error", error: "plannotator timed out" });
    }, options.timeoutMs);

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish({ status: "error", error: error.message });
    });
    child.on("close", (code) => {
      if (aborted) {
        finish({ status: "aborted" });
        return;
      }
      if (code !== 0) {
        finish({
          status: "error",
          error: stderr || `plannotator exited with ${code}`,
        });
        return;
      }
      finish({
        status: "handled",
        result: options.parseStdout(stdout),
      });
    });

    if (options.signal) {
      options.signal.addEventListener("abort", abort, { once: true });
    }
    if (aborted) {
      abort();
    }

    child.stdin.end(options.input ?? "");
  });

const parseCliReviewResult = (stdout: string): CliReviewDecision => {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return { approved: false, exit: true };
  }

  try {
    const parsed = JSON.parse(trimmed) as {
      decision?: string;
      feedback?: string;
    };
    if (parsed.decision === "approved") {
      return { approved: true };
    }
    if (parsed.decision === "dismissed") {
      return { approved: false, exit: true };
    }
    return { approved: false, feedback: parsed.feedback ?? "" };
  } catch {
    if (/The user approved\./i.test(trimmed)) {
      return { approved: true };
    }
    return { approved: false, feedback: trimmed };
  }
};

const parseCliPlanReviewResult = (stdout: string): CliReviewDecision => {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return { approved: false, exit: true };
  }

  try {
    const parsed = JSON.parse(trimmed) as {
      hookSpecificOutput?: {
        decision?: {
          behavior?: string;
          message?: string;
        };
      };
      decision?: string;
      feedback?: string;
    };
    const hookDecision = parsed.hookSpecificOutput?.decision;
    if (hookDecision?.behavior === "allow") {
      return { approved: true };
    }
    if (hookDecision?.behavior === "deny") {
      return { approved: false, feedback: hookDecision.message ?? "" };
    }
    if (parsed.decision === "approved") {
      return { approved: true };
    }
    if (parsed.decision === "dismissed") {
      return { approved: false, exit: true };
    }
    if (parsed.decision === "annotated") {
      return { approved: false, feedback: parsed.feedback ?? "" };
    }
  } catch {
    // Fall through to plaintext handling.
  }

  return { approved: false, feedback: trimmed };
};

const runPlannotatorPlanReviewCli = async (
  ctx: Pick<ExtensionContext, "cwd">,
  planContent: string,
  options: { signal?: AbortSignal; timeoutMs: number },
): Promise<CliReviewResult> => {
  const hookEvent = {
    hook_event_name: "PermissionRequest",
    tool_input: { plan: planContent },
    permission_mode: "default",
  };

  return runPlannotatorCli(ctx, [], {
    input: `${JSON.stringify(hookEvent)}\n`,
    parseStdout: parseCliPlanReviewResult,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
};

const runPlannotatorAnnotateCli = async (
  ctx: Pick<ExtensionContext, "cwd">,
  filePath: string,
  options: {
    gate?: boolean;
    renderHtml?: boolean;
    signal?: AbortSignal;
    timeoutMs: number;
  },
): Promise<CliReviewResult> => {
  const args = ["annotate", filePath];
  if (options.renderHtml) {
    args.push("--render-html");
  }
  if (options.gate) {
    args.push("--gate");
  }
  args.push("--json");

  return runPlannotatorCli(ctx, args, {
    parseStdout: parseCliReviewResult,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
};

const parseCliCodeReviewResult = (stdout: string): CliReviewDecision => {
  const trimmed = stdout.trim();
  if (!trimmed || /no changes requested/i.test(trimmed)) {
    return { approved: true };
  }
  return { approved: false, feedback: trimmed };
};

const runPlannotatorCodeReviewCli = async (
  ctx: Pick<ExtensionContext, "cwd" | "signal">,
): Promise<CliReviewResult> =>
  runPlannotatorCli(ctx, ["review"], {
    parseStdout: parseCliCodeReviewResult,
    signal: ctx.signal,
    timeoutMs: SYNC_CODE_REVIEW_TIMEOUT_MS,
  });

const isPathWithinCwd = (
  ctx: Pick<ExtensionContext, "cwd">,
  targetPath: string,
): boolean => {
  const relative = path.relative(ctx.cwd, targetPath);
  return (
    relative.length === 0 ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};

const getSessionReviewDocuments = (
  state: SessionRuntimeState,
  cwd: string,
): Map<string, SessionReviewDocument> => {
  const existing = state.reviewDocumentsByCwd.get(cwd);
  if (existing) {
    return existing;
  }

  const next = new Map<string, SessionReviewDocument>();
  state.reviewDocumentsByCwd.set(cwd, next);
  return next;
};

const recordSessionReviewDocumentPath = (
  ctx: ExtensionContext,
  toolPath: string,
): void => {
  const absolutePath = path.resolve(ctx.cwd, toolPath);
  if (
    !isReviewDocumentPath(absolutePath) ||
    !isPathWithinCwd(ctx, absolutePath)
  ) {
    return;
  }

  let stats: fs.Stats;
  try {
    stats = fs.statSync(absolutePath);
  } catch {
    return;
  }

  if (!stats.isFile()) {
    return;
  }

  getSessionReviewDocuments(getSessionState(ctx), ctx.cwd).set(absolutePath, {
    absolutePath,
    mtimeMs: stats.mtimeMs,
    updatedAt: Date.now(),
  });
};

const recordSessionReviewDocumentWrites = (
  ctx: ExtensionContext,
  toolName: string,
  args: unknown,
): void => {
  if (toolName === "bash") {
    for (const toolPath of extractBashPathCandidates(args)) {
      recordSessionReviewDocumentPath(ctx, toolPath);
    }
    return;
  }

  const toolPath = resolveToolPath(args);
  if (toolPath) {
    recordSessionReviewDocumentPath(ctx, toolPath);
  }
};

const findLatestSessionReviewDocument = (
  ctx: ExtensionContext,
): {
  absolutePath: string;
  repoRelativePath: string;
} | null => {
  const documents = getSessionState(ctx).reviewDocumentsByCwd.get(ctx.cwd);
  if (!documents || documents.size === 0) {
    return null;
  }

  let latest: SessionReviewDocument | null = null;
  for (const [absolutePath, candidate] of documents) {
    if (
      !isReviewDocumentPath(absolutePath) ||
      !isPathWithinCwd(ctx, absolutePath)
    ) {
      documents.delete(absolutePath);
      continue;
    }

    let stats: fs.Stats;
    try {
      stats = fs.statSync(absolutePath);
    } catch {
      documents.delete(absolutePath);
      continue;
    }

    if (!stats.isFile()) {
      documents.delete(absolutePath);
      continue;
    }

    const refreshed = {
      ...candidate,
      mtimeMs: stats.mtimeMs,
    };
    documents.set(absolutePath, refreshed);

    if (
      !latest ||
      refreshed.mtimeMs > latest.mtimeMs ||
      (refreshed.mtimeMs === latest.mtimeMs &&
        refreshed.updatedAt >= latest.updatedAt)
    ) {
      latest = refreshed;
    }
  }

  if (!latest) {
    return null;
  }

  return {
    absolutePath: latest.absolutePath,
    repoRelativePath: toRepoRelativePath(ctx, latest.absolutePath),
  };
};

const annotateLatestReviewDocument = async (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> => {
  if (!ctx.hasUI) {
    ctx.ui.notify("Latest document annotation requires UI mode.", "warning");
    return;
  }

  const latestDocument = findLatestSessionReviewDocument(ctx);
  if (!latestDocument) {
    ctx.ui.notify(
      "No Markdown or HTML files have been modified in this session.",
      "warning",
    );
    return;
  }

  const renderHtml = isHtmlPath(latestDocument.absolutePath);

  log?.info("plannotator-auto annotating latest session document", {
    cwd: ctx.cwd,
    documentFile: latestDocument.repoRelativePath,
    renderHtml,
    sessionKey: getSessionKey(ctx),
    shortcut: ANNOTATE_LATEST_DOCUMENT_SHORTCUT,
  });

  try {
    const response = await runPlannotatorAnnotateCli(
      ctx,
      latestDocument.absolutePath,
      {
        renderHtml,
        signal: ctx.signal,
        timeoutMs: SYNC_ANNOTATE_TIMEOUT_MS,
      },
    );

    if (response.status === "handled") {
      const message = formatAnnotationMessage({
        filePath: latestDocument.repoRelativePath,
        feedback: response.result.feedback ?? "",
      });

      if (message) {
        pi.sendUserMessage(message, { deliverAs: "followUp" });
      } else {
        ctx.ui.notify("Document annotation closed (no feedback).", "info");
      }
      return;
    }

    if (response.status === "aborted") {
      ctx.ui.notify("Plannotator annotation interrupted.", "info");
      return;
    }

    ctx.ui.notify(response.error, "warning");
  } catch (error) {
    ctx.ui.notify(
      error instanceof Error
        ? error.message
        : "Plannotator annotation request failed.",
      "warning",
    );
  }
};

const formatCodeReviewMessage = (result: {
  approved: boolean;
  feedback?: string;
  annotations?: unknown[];
}): string | null => {
  if (result.approved) {
    return "# Code Review\n\nCode review completed — no changes requested.";
  }

  if (!result.feedback?.trim()) {
    if ((result.annotations?.length ?? 0) > 0) {
      return "# Code Review\n\nCode review completed with inline annotations. Please address the review comments.";
    }

    return null;
  }

  return `${result.feedback}\n\nPlease address this feedback.`;
};

const formatAnnotationMessage = (options: {
  filePath: string;
  feedback: string;
  annotations?: unknown[];
  isFolder?: boolean;
}): string | null => {
  const feedback = options.feedback.trim();
  const hasAnnotations = (options.annotations?.length ?? 0) > 0;
  if (!feedback && !hasAnnotations) {
    return null;
  }

  const header = options.isFolder
    ? `# Markdown Annotations\n\nFolder: ${options.filePath}`
    : `# Markdown Annotations\n\nFile: ${options.filePath}`;

  const body = feedback
    ? `${feedback}\n\nPlease address the annotation feedback above.`
    : "Annotation completed with inline comments. Please address the annotation feedback above.";

  return `${header}\n\n${body}`;
};

const markReviewPending = (ctx: ExtensionContext): void => {
  const state = getSessionState(ctx);
  state.pendingReviewByCwd.add(ctx.cwd);

  log?.debug("plannotator-auto queued code review candidate", {
    cwd: ctx.cwd,
    sessionKey: getSessionKey(ctx),
    pendingReviewCount: state.pendingReviewByCwd.size,
  });
};

const clearReviewPending = (ctx: ExtensionContext): void => {
  getSessionState(ctx).pendingReviewByCwd.delete(ctx.cwd);
};

const createCodeReviewRequestKey = (): string =>
  `sync:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

const notifyCodeReviewUnavailable = (
  ctx: ExtensionContext,
  state: SessionRuntimeState,
  message: string,
): void => {
  if (state.plannotatorUnavailableNotified) {
    log?.debug(
      "plannotator-auto suppressed duplicate unavailable notification",
      {
        cwd: ctx.cwd,
        sessionKey: getSessionKey(ctx),
        message,
      },
    );
    return;
  }

  state.plannotatorUnavailableNotified = true;
  log?.warn("plannotator-auto notified plannotator unavailable", {
    cwd: ctx.cwd,
    sessionKey: getSessionKey(ctx),
    message,
  });
  ctx.ui.notify(message, "warning");
};

const scheduleReviewRetry = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  reason: string,
  delayMs = DEFAULT_CODE_REVIEW_RETRY_DELAY_MS,
): void => {
  const sessionKey = getSessionKey(ctx);
  const state = getSessionState(ctx);
  if (state.pendingReviewRetry) {
    return;
  }

  state.pendingReviewRetry = setTimeout(() => {
    const currentState = sessionRuntimeState.get(sessionKey);
    if (!currentState) {
      return;
    }

    currentState.pendingReviewRetry = null;
    const currentCtx = sessionContextByKey.get(sessionKey);
    if (!currentCtx) {
      return;
    }

    void maybeStartCodeReview(pi, currentCtx, reason);
  }, delayMs);
};

const handleCodeReviewCompletion = (
  pi: ExtensionAPI,
  ctx: Pick<ExtensionContext, "cwd"> & {
    ui?: Pick<ExtensionContext["ui"], "notify">;
  },
  state: SessionRuntimeState,
  active: ActiveCodeReview,
  result: CodeReviewDecision,
  onStateChanged?: () => void,
): void => {
  const superseded = state.pendingReviewByCwd.has(ctx.cwd);

  state.activeCodeReviewByCwd.delete(ctx.cwd);
  state.plannotatorUnavailableNotified = false;
  onStateChanged?.();

  if (superseded) {
    log?.info("plannotator-auto suppressed stale code-review completion", {
      cwd: ctx.cwd,
      requestKey: active.requestKey,
      approved: result.approved,
    });
    return;
  }

  const message = formatCodeReviewMessage(result);
  if (message) {
    pi.sendUserMessage(message, { deliverAs: "followUp" });
    return;
  }

  ctx.ui?.notify("Code review closed (no feedback).", "info");
};

const clearActiveCodeReview = (
  ctx: Pick<ExtensionContext, "cwd">,
  state: SessionRuntimeState,
  onStateChanged?: () => void,
): void => {
  if (state.activeCodeReviewByCwd.delete(ctx.cwd)) {
    onStateChanged?.();
  }
};

const maybeStartCodeReview = async (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  reason: string,
  options: { force?: boolean } = {},
): Promise<void> => {
  const state = getSessionState(ctx);
  const hasPending = state.pendingReviewByCwd.has(ctx.cwd);
  const active = state.activeCodeReviewByCwd.get(ctx.cwd);
  const isManualReview = options.force === true;
  const codeReviewAutoTriggerEnabled = isCodeReviewAutoTriggerEnabled(ctx);

  if (!isManualReview && !codeReviewAutoTriggerEnabled && !active) {
    if (hasPending) {
      log?.debug(
        "plannotator-auto skipped review (code-review auto trigger disabled)",
        {
          cwd: ctx.cwd,
          reason,
          sessionKey: getSessionKey(ctx),
        },
      );
      clearReviewPending(ctx);
    }
    return;
  }

  const hasReviewCandidate = isManualReview || hasPending || Boolean(active);
  if (!hasReviewCandidate || state.reviewInFlight) {
    return;
  }

  if (!ctx.hasUI) {
    log?.debug("plannotator-auto skipped review (no UI)", {
      cwd: ctx.cwd,
      reason,
      sessionKey: getSessionKey(ctx),
    });
    clearReviewPending(ctx);
    return;
  }

  if (!ctx.isIdle()) {
    scheduleReviewRetry(pi, ctx, "busy-review");
    return;
  }

  if (!isPlanReviewSettled(state, ctx.cwd)) {
    log?.debug(
      "plannotator-auto deferring code review until plan review settles",
      {
        cwd: ctx.cwd,
        reason,
        sessionKey: getSessionKey(ctx),
      },
    );
    scheduleReviewRetry(pi, ctx, "review-after-plan-review");
    return;
  }

  const repoRoot = getRepoRoot(ctx.cwd, DEFAULT_GIT_TIMEOUT_MS);
  if (!repoRoot) {
    log?.debug("plannotator-auto skipped review (not a git repo)", {
      cwd: ctx.cwd,
      reason,
      sessionKey: getSessionKey(ctx),
    });
    clearReviewPending(ctx);
    return;
  }

  const dirty = checkRepoDirty(repoRoot, DEFAULT_GIT_TIMEOUT_MS);
  if (!dirty) {
    log?.warn("plannotator-auto failed to check git status", {
      cwd: ctx.cwd,
      repoRoot,
      reason,
      sessionKey: getSessionKey(ctx),
    });
    clearReviewPending(ctx);
    return;
  }

  if (!dirty.summary.dirty) {
    log?.debug("plannotator-auto skipped review (repo clean)", {
      cwd: ctx.cwd,
      repoRoot,
      summary: dirty.summary,
      reason,
      sessionKey: getSessionKey(ctx),
    });
    clearReviewPending(ctx);
    if (isManualReview) {
      ctx.ui.notify("No uncommitted changes to review.", "info");
    }
    return;
  }

  state.reviewInFlight = true;
  const activeReview: ActiveCodeReview = {
    requestKey: createCodeReviewRequestKey(),
    startedAt: Date.now(),
  };
  state.activeCodeReviewByCwd.set(ctx.cwd, activeReview);
  setReviewWidget(ctx);

  try {
    log?.info("plannotator-auto starting code review via CLI", {
      cwd: ctx.cwd,
      repoRoot,
      reason,
      sessionKey: getSessionKey(ctx),
    });

    const response = await runPlannotatorCodeReviewCli(ctx);
    if (response.status === "error") {
      clearActiveCodeReview(ctx, state, () => setReviewWidget(ctx));
      notifyCodeReviewUnavailable(ctx, state, response.error);
      return;
    }
    if (response.status === "aborted") {
      clearActiveCodeReview(ctx, state, () => setReviewWidget(ctx));
      return;
    }

    clearReviewPending(ctx);
    state.plannotatorUnavailableNotified = false;
    handleCodeReviewCompletion(
      pi,
      ctx,
      state,
      activeReview,
      response.result,
      () => setReviewWidget(ctx),
    );
  } finally {
    state.reviewInFlight = false;
    setReviewWidget(ctx);
  }
};

const queuePlanReviewForToolPath = (
  ctx: ExtensionContext,
  planConfig: PlanFileConfig,
  toolPath: string,
): boolean => {
  const state = getSessionState(ctx);
  const targetPath = path.resolve(ctx.cwd, toolPath);
  if (state.settledPlanReviewPaths.has(targetPath)) {
    log?.info("plannotator-auto skipped plan review for settled plan", {
      cwd: ctx.cwd,
      toolPath,
      targetPath,
      sessionKey: getSessionKey(ctx),
    });
    return false;
  }

  const reviewTarget = resolveReviewTargetMatch(ctx, planConfig, targetPath);
  if (!reviewTarget) {
    log?.debug("plannotator-auto tool write/edit did not match review target", {
      cwd: ctx.cwd,
      toolPath,
      targetPath,
      configuredPlanPath: planConfig.resolvedPlanPath,
      configuredSpecPaths: planConfig.resolvedSpecPaths,
      configuredExtraReviewTargets: planConfig.extraReviewTargets,
      sessionKey: getSessionKey(ctx),
    });
    return false;
  }

  log?.info("plannotator-auto detected review-target update", {
    cwd: ctx.cwd,
    toolPath,
    targetPath,
    planFile: reviewTarget.reviewFile,
    kind: reviewTarget.kind,
    sessionKey: getSessionKey(ctx),
  });

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

const handlePlanFileWrite = (
  ctx: ExtensionContext,
  args: unknown,
  planConfig: PlanFileConfig | null,
): boolean => {
  if (!planConfig) {
    log?.debug(
      "plannotator-auto skipped plan-file write handling (plan review disabled)",
      {
        cwd: ctx.cwd,
        sessionKey: getSessionKey(ctx),
      },
    );
    return false;
  }

  const toolPath = resolveToolPath(args);
  if (!toolPath) {
    log?.debug(
      "plannotator-auto skipped plan-file write handling (missing path arg)",
      {
        cwd: ctx.cwd,
        ...summarizeToolArgs(args),
        sessionKey: getSessionKey(ctx),
      },
    );
    return false;
  }

  return queuePlanReviewForToolPath(ctx, planConfig, toolPath);
};

const handleBashPlanFileWrites = (
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

const isReviewTrackedToolName = (toolName: string): boolean =>
  toolName === "write" || toolName === "edit" || toolName === "bash";

export default function plannotatorAuto(pi: ExtensionAPI) {
  log = createLogger("plannotator-auto", { stderr: null });

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

  const runManualCodeReview = async (
    ctx: ExtensionContext,
    reason: string,
  ): Promise<void> => {
    await maybeStartCodeReview(pi, ctx, reason, { force: true });
  };

  pi.registerCommand(MANUAL_CODE_REVIEW_COMMAND, {
    description: "Run plannotator CLI review for uncommitted changes",
    handler: async (_args, ctx) => {
      await runManualCodeReview(ctx, "manual-command");
    },
  });

  pi.registerShortcut(MANUAL_CODE_REVIEW_SHORTCUT, {
    description: "Run plannotator CLI review for uncommitted changes",
    handler: async (ctx) => {
      await runManualCodeReview(ctx, "manual-shortcut");
    },
  });

  pi.registerShortcut(ANNOTATE_LATEST_DOCUMENT_SHORTCUT, {
    description: "Annotate latest session document (Ctrl+Alt+L)",
    handler: async (ctx) => {
      await annotateLatestReviewDocument(pi, ctx);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    const sessionKey = getSessionKey(ctx);
    sessionContextByKey.set(sessionKey, ctx);
    getSessionState(ctx);
    setReviewWidget(ctx);

    log?.debug("plannotator-auto session started", {
      cwd: ctx.cwd,
      sessionKey,
    });
  });

  pi.on("session_shutdown", (_event, ctx) => {
    const sessionKey = getSessionKey(ctx);
    log?.debug("plannotator-auto session shutdown", {
      cwd: ctx.cwd,
      sessionKey,
    });

    clearReviewWidget(ctx);
    sessionContextByKey.delete(sessionKey);
    clearSessionState(sessionKey);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    const pendingPlanReviews = getGateablePendingPlanReviews(
      getSessionState(ctx),
      ctx.cwd,
    );
    if (pendingPlanReviews.length === 0) {
      return;
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
  });

  pi.on("tool_execution_start", (event, ctx) => {
    sessionContextByKey.set(getSessionKey(ctx), ctx);

    if (!isReviewTrackedToolName(event.toolName)) {
      return;
    }

    log?.debug("plannotator-auto captured tool args", {
      cwd: ctx.cwd,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      sessionKey: getSessionKey(ctx),
    });

    getSessionState(ctx).toolArgsByCallId.set(event.toolCallId, event.args);
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    sessionContextByKey.set(getSessionKey(ctx), ctx);

    if (!isReviewTrackedToolName(event.toolName)) {
      return;
    }

    const state = getSessionState(ctx);
    const args = state.toolArgsByCallId.get(event.toolCallId);
    state.toolArgsByCallId.delete(event.toolCallId);
    if (!args) {
      log?.debug(
        "plannotator-auto missing stored tool args on tool_execution_end",
        {
          cwd: ctx.cwd,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          sessionKey: getSessionKey(ctx),
        },
      );
      return;
    }

    if (event.isError) {
      log?.debug(
        "plannotator-auto skipping review queue after failed tool execution",
        {
          cwd: ctx.cwd,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          sessionKey: getSessionKey(ctx),
        },
      );
      return;
    }

    recordSessionReviewDocumentWrites(ctx, event.toolName, args);

    const toolPath = resolveToolPath(args);
    const planConfig = getPlanFileConfig(ctx);
    if (toolPath) {
      const targetPath = path.resolve(ctx.cwd, toolPath);
      const shouldQueueCodeReview = shouldQueueReviewForToolPath(
        planConfig,
        targetPath,
      );

      log?.debug("plannotator-auto evaluated tool path for review queue", {
        cwd: ctx.cwd,
        toolName: event.toolName,
        toolPath,
        targetPath,
        shouldQueueCodeReview,
        configuredPlanPath: planConfig?.resolvedPlanPath ?? null,
        sessionKey: getSessionKey(ctx),
      });

      if (shouldQueueCodeReview) {
        if (isCodeReviewAutoTriggerEnabled(ctx)) {
          markReviewPending(ctx);
        } else {
          log?.debug(
            "plannotator-auto skipped review queue (code-review auto trigger disabled)",
            {
              cwd: ctx.cwd,
              toolName: event.toolName,
              toolPath,
              targetPath,
              sessionKey: getSessionKey(ctx),
            },
          );
        }
      }
    } else if (event.toolName !== "bash") {
      log?.debug("plannotator-auto tool args missing path for review queue", {
        cwd: ctx.cwd,
        toolName: event.toolName,
        ...summarizeToolArgs(args),
        sessionKey: getSessionKey(ctx),
      });
    }

    const queuedPlanReview =
      event.toolName === "bash"
        ? handleBashPlanFileWrites(ctx, args, planConfig)
        : handlePlanFileWrite(ctx, args, planConfig);

    const pendingPlanReviews = getGateablePendingPlanReviews(state, ctx.cwd);
    if (queuedPlanReview && pendingPlanReviews.length > 0) {
      notifyPendingPlanReviewGate(pi, ctx, state, pendingPlanReviews);
    }

    setReviewWidget(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    sessionContextByKey.set(getSessionKey(ctx), ctx);

    log?.debug("plannotator-auto handling agent_end", {
      cwd: ctx.cwd,
      sessionKey: getSessionKey(ctx),
    });

    const state = getSessionState(ctx);
    const pendingPlanReviews = getGateablePendingPlanReviews(state, ctx.cwd);
    if (pendingPlanReviews.length > 0) {
      notifyPendingPlanReviewGate(pi, ctx, state, pendingPlanReviews);
      setReviewWidget(ctx);
      return;
    }

    await maybeStartCodeReview(pi, ctx, "agent_end");
    setReviewWidget(ctx);
  });
}
