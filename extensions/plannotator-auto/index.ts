import fs from "node:fs";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
  checkRepoDirty,
  DEFAULT_GIT_TIMEOUT_MS,
  getRepoRoot,
} from "../shared/git.ts";
import { createLogger } from "../shared/logger.ts";
import { loadSettings } from "../shared/settings.ts";
import {
  createRequestPlannotator,
  createReviewResultStore,
  formatCodeReviewMessage,
  requestCodeReview,
} from "./plannotator-api.ts";

type PlannotatorAutoConfig = {
  planFile?: string | null;
};

type PlannotatorAutoSettings = {
  planFile?: unknown;
};

type PlannotatorState = {
  phase?: string;
  planFilePath?: string;
};

type PlanFileMode = "file" | "directory";

type PlanFileConfig = {
  planFile: string;
  resolvedPlanPath: string;
  mode: PlanFileMode;
};

type PendingTrigger = {
  commands: string[];
  planFile: string;
  createdAt: number;
};

type SessionRuntimeState = {
  toolArgsByCallId: Map<string, unknown>;
  pendingTrigger: PendingTrigger | null;
  pendingRetry: ReturnType<typeof setTimeout> | null;
  pendingReviewByCwd: Set<string>;
  pendingReviewRetry: ReturnType<typeof setTimeout> | null;
  reviewInFlight: boolean;
  plannotatorUnavailableNotified: boolean;
};

const DEFAULT_PLAN_SUBDIR = "plan";
const PLAN_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}-.+\.md$/;
const sessionRuntimeState = new Map<string, SessionRuntimeState>();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const sanitizeConfig = (value: unknown): PlannotatorAutoConfig => {
  if (!isRecord(value)) {
    return {};
  }

  const raw = value as PlannotatorAutoSettings;
  if (raw.planFile === null) {
    return { planFile: null };
  }

  if (typeof raw.planFile !== "string") {
    return {};
  }

  const trimmed = raw.planFile.trim();
  return trimmed.length > 0 ? { planFile: trimmed } : {};
};

let log: ReturnType<typeof createLogger> | null = null;

const createSessionRuntimeState = (): SessionRuntimeState => ({
  toolArgsByCallId: new Map<string, unknown>(),
  pendingTrigger: null,
  pendingRetry: null,
  pendingReviewByCwd: new Set<string>(),
  pendingReviewRetry: null,
  reviewInFlight: false,
  plannotatorUnavailableNotified: false,
});

export const getSessionKey = (ctx: {
  cwd: string;
  sessionManager: { getSessionFile: () => string | null | undefined };
}): string => ctx.sessionManager.getSessionFile() ?? `${ctx.cwd}::ephemeral`;

const getSessionState = (ctx: ExtensionContext): SessionRuntimeState => {
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

  if (state.pendingRetry) {
    clearTimeout(state.pendingRetry);
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
  });
  return config;
};

const getDefaultPlanDir = (cwd: string): string => {
  const repoSlug = path.basename(cwd);
  return path.join(".pi", "plans", repoSlug, DEFAULT_PLAN_SUBDIR);
};

const statPath = (value: string): fs.Stats | null => {
  try {
    return fs.statSync(value);
  } catch {
    return null;
  }
};

const detectPlanMode = (
  planFile: string,
  resolvedPlanPath: string,
): PlanFileMode => {
  const stats = statPath(resolvedPlanPath);
  if (stats?.isDirectory()) {
    return "directory";
  }
  if (stats?.isFile()) {
    return "file";
  }
  return path.extname(planFile).toLowerCase() === ".md" ? "file" : "directory";
};

const resolveCommandPlanPath = (
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

const isPlanFileMatch = (planDir: string, targetPath: string): boolean => {
  if (path.dirname(targetPath) !== planDir) {
    return false;
  }
  return PLAN_FILE_PATTERN.test(path.basename(targetPath));
};

const resolveCommandName = (
  pi: ExtensionAPI,
  baseName: string,
): string | null => {
  const command = pi
    .getCommands()
    .find(
      (entry) =>
        entry.name === baseName || entry.name.startsWith(`${baseName}:`),
    );
  return command?.name ?? null;
};

const buildCommandText = (
  pi: ExtensionAPI,
  baseName: string,
  args?: string,
): string | null => {
  const commandName = resolveCommandName(pi, baseName);
  if (!commandName) {
    log?.warn("plannotator-auto command missing", { baseName });
    return null;
  }

  return args ? `/${commandName} ${args}` : `/${commandName}`;
};

const scheduleTriggerRetry = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  reason: string,
  delay = 120,
): void => {
  const sessionKey = getSessionKey(ctx);
  const state = getSessionState(ctx);
  if (state.pendingRetry) {
    return;
  }

  state.pendingRetry = setTimeout(() => {
    const currentState = sessionRuntimeState.get(sessionKey);
    if (!currentState) {
      return;
    }

    currentState.pendingRetry = null;
    tryTriggerPlanMode(pi, ctx, reason);
  }, delay);
};

const scheduleReviewRetry = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  reason: string,
  delay = 180,
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
    void maybeStartCodeReview(pi, ctx, reason);
  }, delay);
};

const clearPendingTrigger = (ctx: ExtensionContext, reason: string): void => {
  const state = getSessionState(ctx);
  if (state.pendingTrigger) {
    log?.debug("plannotator-auto cleared pending trigger", {
      reason,
      planFile: state.pendingTrigger.planFile,
      sessionKey: getSessionKey(ctx),
    });
  }
  state.pendingTrigger = null;
};

const tryTriggerPlanMode = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  reason: string,
): void => {
  const state = getSessionState(ctx);
  if (!state.pendingTrigger) {
    return;
  }

  if (!ctx.hasUI) {
    log?.warn("plannotator-auto auto-trigger skipped (no UI)", {
      reason,
      planFile: state.pendingTrigger.planFile,
      sessionKey: getSessionKey(ctx),
    });
    clearPendingTrigger(ctx, "no-ui");
    return;
  }

  if (!ctx.isIdle()) {
    log?.debug("plannotator-auto deferring trigger (agent busy)", {
      reason,
      planFile: state.pendingTrigger.planFile,
      sessionKey: getSessionKey(ctx),
    });
    scheduleTriggerRetry(pi, ctx, "busy");
    return;
  }

  const [commandText] = state.pendingTrigger.commands;
  if (!commandText) {
    clearPendingTrigger(ctx, "no-command");
    return;
  }

  pi.sendUserMessage(commandText);

  state.pendingTrigger.commands.shift();
  log?.info("plannotator-auto queued command via sendUserMessage", {
    reason,
    planFile: state.pendingTrigger.planFile,
    commandText,
    sessionKey: getSessionKey(ctx),
  });

  if (state.pendingTrigger.commands.length === 0) {
    clearPendingTrigger(ctx, "completed");
    if (state.pendingReviewByCwd.has(ctx.cwd)) {
      scheduleReviewRetry(pi, ctx, "after-plan-commands");
    }
    return;
  }

  scheduleTriggerRetry(pi, ctx, "next-command");
};

const isPlannotatorActive = (state: PlannotatorState | null): boolean =>
  Boolean(state?.phase && state.phase !== "idle");

const getStatePlanFilePath = (
  ctx: Pick<ExtensionContext, "cwd">,
  state: PlannotatorState | null,
): string | null => {
  const planFilePath = state?.planFilePath;
  if (!planFilePath) {
    return null;
  }

  const resolved = path.isAbsolute(planFilePath)
    ? planFilePath
    : path.resolve(ctx.cwd, planFilePath);
  return resolveCommandPlanPath(ctx, resolved);
};

const resolveStatePlanFilePath = (
  ctx: Pick<ExtensionContext, "cwd">,
  state: PlannotatorState | null,
  fallbackPlanFile: string,
): string => {
  const planFilePath = getStatePlanFilePath(ctx, state);
  if (!planFilePath) {
    if (isPlannotatorActive(state)) {
      log?.warn(
        "plannotator-auto missing active plan file path; using new plan file",
        {
          fallbackPlanFile,
          phase: state?.phase ?? "unknown",
        },
      );
    }
    return fallbackPlanFile;
  }
  return planFilePath;
};

export const buildPlanCommands = (
  pi: ExtensionAPI,
  ctx: Pick<ExtensionContext, "cwd">,
  planFile: string,
  state: PlannotatorState | null,
): string[] => {
  const commands: string[] = [];
  const setFileCommand = buildCommandText(pi, "plannotator-set-file", planFile);
  if (setFileCommand) {
    commands.push(setFileCommand);
  }

  if (isPlannotatorActive(state)) {
    const oldPlanFile = resolveStatePlanFilePath(ctx, state, planFile);
    const exitCommand = buildCommandText(pi, "plannotator", oldPlanFile);
    const enterCommand = buildCommandText(pi, "plannotator", planFile);
    if (exitCommand) {
      commands.push(exitCommand);
    }
    if (enterCommand) {
      commands.push(enterCommand);
    }
  } else {
    const enterCommand = buildCommandText(pi, "plannotator", planFile);
    if (enterCommand) {
      commands.push(enterCommand);
    }
  }

  return commands;
};

const queuePlanTrigger = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  planFile: string,
  state: PlannotatorState | null,
): void => {
  const runtimeState = getSessionState(ctx);
  const commands = buildPlanCommands(pi, ctx, planFile, state);

  if (commands.length === 0) {
    return;
  }

  const replacedPlanFile = runtimeState.pendingTrigger?.planFile;
  if (replacedPlanFile) {
    log?.info("plannotator-auto replaced pending trigger", {
      previousPlanFile: replacedPlanFile,
      planFile,
      sessionKey: getSessionKey(ctx),
    });
  }

  runtimeState.pendingTrigger = {
    commands,
    planFile,
    createdAt: Date.now(),
  };

  log?.debug("plannotator-auto queued trigger", {
    planFile,
    commands,
    replacedPlanFile: replacedPlanFile ?? null,
    sessionKey: getSessionKey(ctx),
  });
  tryTriggerPlanMode(pi, ctx, "queue");
};

const resolvePlanPath = (cwd: string, planFile: string): string =>
  path.resolve(cwd, planFile);

const getPlanFileConfig = (ctx: ExtensionContext): PlanFileConfig | null => {
  const config = loadConfig(ctx.cwd);
  if (config.planFile === null) {
    return null;
  }

  const planFile = config.planFile ?? getDefaultPlanDir(ctx.cwd);
  const resolvedPlanPath = resolvePlanPath(ctx.cwd, planFile);
  const mode = detectPlanMode(planFile, resolvedPlanPath);

  log?.debug("plannotator-auto resolved plan path", {
    planFile,
    resolvedPlanPath,
    mode,
  });

  return {
    planFile,
    resolvedPlanPath,
    mode,
  };
};

const getPlannotatorState = (
  ctx: ExtensionContext,
): PlannotatorState | null => {
  let state: PlannotatorState | null = null;
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "custom" && entry.customType === "plannotator") {
      state = entry.data as PlannotatorState | null;
    }
  }
  return state;
};

const resolveToolPath = (args: unknown): string | null => {
  if (!isRecord(args)) {
    return null;
  }
  const value = args.path;
  return typeof value === "string" ? value : null;
};

const resolvePlanFileForCommand = (
  ctx: Pick<ExtensionContext, "cwd">,
  planConfig: PlanFileConfig,
  targetPath: string,
): string | null => {
  if (planConfig.mode === "file") {
    return targetPath === planConfig.resolvedPlanPath
      ? planConfig.planFile
      : null;
  }

  if (!isPlanFileMatch(planConfig.resolvedPlanPath, targetPath)) {
    return null;
  }

  return resolveCommandPlanPath(ctx, targetPath);
};

export const shouldQueueReviewForToolPath = (
  planConfig: PlanFileConfig | null,
  targetPath: string,
): boolean => {
  if (!planConfig) {
    return true;
  }

  if (planConfig.mode === "file") {
    return targetPath !== planConfig.resolvedPlanPath;
  }

  return !isPlanFileMatch(planConfig.resolvedPlanPath, targetPath);
};

const markReviewPending = (ctx: ExtensionContext): void => {
  getSessionState(ctx).pendingReviewByCwd.add(ctx.cwd);
};

const clearReviewPending = (ctx: ExtensionContext): void => {
  getSessionState(ctx).pendingReviewByCwd.delete(ctx.cwd);
};

const handlePlanFileWrite = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  toolName: string,
  args: unknown,
  planConfig: PlanFileConfig | null,
): void => {
  if (!planConfig) {
    return;
  }

  const toolPath = resolveToolPath(args);
  if (!toolPath) {
    return;
  }

  const targetPath = path.resolve(ctx.cwd, toolPath);
  const planFileForCommand = resolvePlanFileForCommand(
    ctx,
    planConfig,
    targetPath,
  );
  if (!planFileForCommand) {
    return;
  }

  const state = getPlannotatorState(ctx);
  const activePlanFile = isPlannotatorActive(state)
    ? getStatePlanFilePath(ctx, state)
    : null;

  if (activePlanFile && activePlanFile === planFileForCommand) {
    log?.debug("plannotator-auto skipped trigger (plan already active)", {
      phase: state?.phase ?? "unknown",
      toolName,
      planFile: planFileForCommand,
      planMode: planConfig.mode,
      resolvedPlanPath: planConfig.resolvedPlanPath,
      activePlanFile,
      sessionKey: getSessionKey(ctx),
    });
    return;
  }

  log?.info("plannotator-auto queueing /plannotator trigger", {
    toolName,
    planFile: planFileForCommand,
    planMode: planConfig.mode,
    resolvedPlanPath: planConfig.resolvedPlanPath,
    phase: state?.phase ?? "unknown",
    activePlanFile: activePlanFile ?? null,
    sessionKey: getSessionKey(ctx),
  });
  queuePlanTrigger(pi, ctx, planFileForCommand, state);
};

const notifyPlannotatorUnavailable = (
  ctx: ExtensionContext,
  state: SessionRuntimeState,
  message: string,
): void => {
  if (state.plannotatorUnavailableNotified) {
    return;
  }

  state.plannotatorUnavailableNotified = true;
  ctx.ui.notify(message, "warning");
};

const maybeStartCodeReview = async (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  reason: string,
): Promise<void> => {
  const state = getSessionState(ctx);
  if (!state.pendingReviewByCwd.has(ctx.cwd) || state.reviewInFlight) {
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

  if (state.pendingTrigger) {
    log?.debug("plannotator-auto deferring review until plan commands finish", {
      cwd: ctx.cwd,
      reason,
      sessionKey: getSessionKey(ctx),
    });
    scheduleReviewRetry(pi, ctx, "review-after-trigger");
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
    return;
  }

  const requestPlannotator = createRequestPlannotator(pi.events);
  state.reviewInFlight = true;
  clearReviewPending(ctx);

  log?.info("plannotator-auto starting code review via event API", {
    cwd: ctx.cwd,
    repoRoot,
    reason,
    sessionKey: getSessionKey(ctx),
  });

  try {
    const response = await requestCodeReview(requestPlannotator, {
      cwd: ctx.cwd,
    });

    if (response.status === "handled") {
      state.plannotatorUnavailableNotified = false;
      const message = formatCodeReviewMessage(response.result);
      if (message) {
        pi.sendUserMessage(message);
      } else {
        ctx.ui.notify("Code review closed (no feedback).", "info");
      }
      return;
    }

    if (response.status === "unavailable") {
      notifyPlannotatorUnavailable(
        ctx,
        state,
        response.error ??
          "Plannotator is not loaded. Install/enable the Plannotator extension to use shared review flows.",
      );
      return;
    }

    ctx.ui.notify(
      response.error || "Plannotator code review request failed.",
      "warning",
    );
  } catch (error) {
    ctx.ui.notify(
      error instanceof Error
        ? error.message
        : "Plannotator code review request failed.",
      "warning",
    );
  } finally {
    state.reviewInFlight = false;
  }
};

export default function plannotatorAuto(pi: ExtensionAPI) {
  log = createLogger("plannotator-auto", { stderr: null });
  const reviewResults = createReviewResultStore(pi.events);

  reviewResults.onResult((result) => {
    log?.debug("plannotator-auto observed plan review result", result);
  });

  pi.on("session_start", (_event, ctx) => {
    getSessionState(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    clearSessionState(getSessionKey(ctx));
  });

  pi.on("tool_execution_start", (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") {
      return;
    }

    getSessionState(ctx).toolArgsByCallId.set(event.toolCallId, event.args);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") {
      return;
    }

    const state = getSessionState(ctx);
    const args = state.toolArgsByCallId.get(event.toolCallId);
    state.toolArgsByCallId.delete(event.toolCallId);
    if (!args || event.isError) {
      return;
    }

    const toolPath = resolveToolPath(args);
    const planConfig = getPlanFileConfig(ctx);
    if (toolPath) {
      const targetPath = path.resolve(ctx.cwd, toolPath);
      if (shouldQueueReviewForToolPath(planConfig, targetPath)) {
        markReviewPending(ctx);
      }
    }

    handlePlanFileWrite(pi, ctx, event.toolName, args, planConfig);
  });

  pi.on("agent_end", async (_event, ctx) => {
    tryTriggerPlanMode(pi, ctx, "agent_end");
    await maybeStartCodeReview(pi, ctx, "agent_end");
  });
}
