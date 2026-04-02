import fs from "node:fs";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { createLogger } from "../shared/logger.ts";
import { loadGlobalSettings } from "../shared/settings.ts";

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

const DEFAULT_PLAN_SUBDIR = "plan";
const PLAN_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}-.+\.md$/;

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
const toolArgsByCallId = new Map<string, unknown>();

type PendingTrigger = {
  commands: string[];
  planFile: string;
  createdAt: number;
};

// Defer auto-triggering until the agent is idle to avoid interrupting streaming.
let pendingTrigger: PendingTrigger | null = null;
let pendingRetry: ReturnType<typeof setTimeout> | null = null;

const loadConfig = (options?: {
  forceReload?: boolean;
}): PlannotatorAutoConfig => {
  const { global } = loadGlobalSettings(options);
  const config = sanitizeConfig(global.plannotatorAuto);
  log?.debug("plannotator-auto config loaded", { planFile: config.planFile });
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
  ctx: ExtensionContext,
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

// Best-effort hack: simulate pressing Enter in the TUI by emitting stdin data.
// Works only in interactive mode; noop in RPC/print modes.
const emitEnterKey = (): boolean => {
  if (typeof process?.stdin?.emit !== "function") {
    return false;
  }

  try {
    process.stdin.emit("data", Buffer.from("\r"));
    return true;
  } catch (error) {
    log?.warn("plannotator-auto failed to emit enter", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
};

const scheduleTriggerRetry = (
  ctx: ExtensionContext,
  reason: string,
  delay = 120,
): void => {
  if (pendingRetry) {
    return;
  }

  pendingRetry = setTimeout(() => {
    pendingRetry = null;
    tryTriggerPlanMode(ctx, reason);
  }, delay);
};

const tryTriggerPlanMode = (ctx: ExtensionContext, reason: string): void => {
  if (!pendingTrigger) {
    return;
  }

  if (!ctx.hasUI) {
    log?.warn("plannotator-auto auto-trigger skipped (no UI)", {
      reason,
      planFile: pendingTrigger.planFile,
    });
    pendingTrigger = null;
    return;
  }

  // Only submit when the agent is idle and the editor is empty to avoid
  // overwriting user input or interrupting streaming output.
  if (!ctx.isIdle()) {
    log?.debug("plannotator-auto deferring trigger (agent busy)", {
      reason,
      planFile: pendingTrigger.planFile,
    });
    scheduleTriggerRetry(ctx, "busy");
    return;
  }

  const editorText = ctx.ui.getEditorText?.() ?? "";
  if (editorText.trim().length > 0) {
    ctx.ui.notify(
      "Plannotator auto-trigger skipped: editor has pending input. Run /plannotator (and /plannotator-annotate) manually when ready.",
      "info",
    );
    log?.info("plannotator-auto skipped trigger (editor not empty)", {
      reason,
      planFile: pendingTrigger.planFile,
    });
    pendingTrigger = null;
    return;
  }

  const [commandText] = pendingTrigger.commands;
  if (!commandText) {
    pendingTrigger = null;
    return;
  }

  ctx.ui.setEditorText(commandText);
  if (!emitEnterKey()) {
    ctx.ui.notify(
      "Unable to auto-run plannotator commands. Please run /plannotator and /plannotator-annotate manually.",
      "info",
    );
    log?.warn("plannotator-auto auto-trigger failed (stdin unavailable)", {
      reason,
      planFile: pendingTrigger.planFile,
    });
    pendingTrigger = null;
    return;
  }

  pendingTrigger.commands.shift();
  log?.info("plannotator-auto submitted command via stdin", {
    reason,
    planFile: pendingTrigger.planFile,
    commandText,
  });

  if (pendingTrigger.commands.length === 0) {
    pendingTrigger = null;
    return;
  }

  scheduleTriggerRetry(ctx, "next-command");
};

const isPlannotatorActive = (state: PlannotatorState | null): boolean =>
  Boolean(state?.phase && state.phase !== "idle");

const getStatePlanFilePath = (
  ctx: ExtensionContext,
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
  ctx: ExtensionContext,
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

const buildPlanCommands = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
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

  const annotateCommand = buildCommandText(
    pi,
    "plannotator-annotate",
    planFile,
  );
  if (annotateCommand) {
    commands.push(annotateCommand);
  }

  return commands;
};

// Queue auto-trigger; the actual submission happens when it is safe.
const queuePlanTrigger = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  planFile: string,
  state: PlannotatorState | null,
): void => {
  const commands = buildPlanCommands(pi, ctx, planFile, state);

  if (commands.length === 0) {
    return;
  }

  const replacedPlanFile = pendingTrigger?.planFile;
  if (replacedPlanFile) {
    log?.info("plannotator-auto replaced pending trigger", {
      previousPlanFile: replacedPlanFile,
      planFile,
    });
  }

  pendingTrigger = {
    commands,
    planFile,
    createdAt: Date.now(),
  };

  log?.debug("plannotator-auto queued trigger", {
    planFile,
    commands,
    replacedPlanFile: replacedPlanFile ?? null,
  });
  tryTriggerPlanMode(ctx, "queue");
};

const resolvePlanPath = (cwd: string, planFile: string): string =>
  path.resolve(cwd, planFile);

const getPlanFileConfig = (ctx: ExtensionContext): PlanFileConfig | null => {
  const config = loadConfig();
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
  ctx: ExtensionContext,
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

const handlePlanFileWrite = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  toolName: string,
  args: unknown,
): void => {
  const planConfig = getPlanFileConfig(ctx);
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
  });
  queuePlanTrigger(pi, ctx, planFileForCommand, state);
};

export default function plannotatorAuto(pi: ExtensionAPI) {
  log = createLogger("plannotator-auto", { stderr: null });

  pi.on("tool_execution_start", (event) => {
    if (event.toolName !== "write" && event.toolName !== "edit") {
      return;
    }

    toolArgsByCallId.set(event.toolCallId, event.args);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") {
      return;
    }

    const args = toolArgsByCallId.get(event.toolCallId);
    toolArgsByCallId.delete(event.toolCallId);
    if (!args) {
      return;
    }

    handlePlanFileWrite(pi, ctx, event.toolName, args);
  });

  pi.on("agent_end", (_event, ctx) => {
    tryTriggerPlanMode(ctx, "agent_end");
  });
}
