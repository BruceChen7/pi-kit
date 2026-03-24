import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { createLogger } from "../shared/logger.ts";
import { loadGlobalSettings } from "../shared/settings.ts";

type PlannotatorAutoConfig = {
  planFile: string | null;
};

type PlannotatorAutoSettings = {
  planFile?: unknown;
};

type PlannotatorState = {
  phase?: string;
  planFilePath?: string;
};

const DEFAULT_PLAN_FILE = ".pi/PLAN.md";

const DEFAULT_CONFIG: PlannotatorAutoConfig = {
  planFile: DEFAULT_PLAN_FILE,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const sanitizeConfig = (value: unknown): PlannotatorAutoConfig => {
  if (!isRecord(value)) {
    return DEFAULT_CONFIG;
  }

  const raw = value as PlannotatorAutoSettings;
  if (raw.planFile === null) {
    return { planFile: null };
  }

  if (typeof raw.planFile !== "string") {
    return DEFAULT_CONFIG;
  }

  const trimmed = raw.planFile.trim();
  return trimmed.length > 0 ? { planFile: trimmed } : DEFAULT_CONFIG;
};

let log: ReturnType<typeof createLogger> | null = null;
const toolArgsByCallId = new Map<string, unknown>();

const loadConfig = (options?: {
  forceReload?: boolean;
}): PlannotatorAutoConfig => {
  const { global } = loadGlobalSettings(options);
  const config = sanitizeConfig(global.plannotatorAuto);
  log?.debug("plannotator-auto config loaded", { planFile: config.planFile });
  return config;
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

const sendCommand = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  baseName: string,
  args?: string,
): void => {
  const commandName = resolveCommandName(pi, baseName);
  if (!commandName) {
    log?.warn("plannotator-auto command missing", { baseName });
    return;
  }

  const commandText = args ? `/${commandName} ${args}` : `/${commandName}`;
  const deliverAs = ctx.isIdle() ? undefined : "steer";
  if (deliverAs) {
    pi.sendUserMessage(commandText, { deliverAs });
  } else {
    pi.sendUserMessage(commandText);
  }

  log?.debug("plannotator-auto sent command", {
    commandText,
    idle: ctx.isIdle(),
  });
};

const resolvePlanPath = (cwd: string, planFile: string): string =>
  path.resolve(cwd, planFile);

const getPlanFileConfig = (
  ctx: ExtensionContext,
): { planFile: string; resolvedPlanPath: string } | null => {
  const config = loadConfig({ forceReload: true });
  if (!config.planFile) {
    return null;
  }

  return {
    planFile: config.planFile,
    resolvedPlanPath: resolvePlanPath(ctx.cwd, config.planFile),
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

const shouldTriggerPlanMode = (ctx: ExtensionContext): boolean => {
  const state = getPlannotatorState(ctx);
  if (!state?.phase) {
    return true;
  }
  return state.phase === "idle";
};

const resolveToolPath = (args: unknown): string | null => {
  if (!isRecord(args)) {
    return null;
  }
  const value = args.path;
  return typeof value === "string" ? value : null;
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
  if (targetPath !== planConfig.resolvedPlanPath) {
    return;
  }

  if (!shouldTriggerPlanMode(ctx)) {
    log?.debug("plannotator-auto skipped trigger (not idle)", {
      phase: getPlannotatorState(ctx)?.phase ?? "unknown",
      toolName,
      planFile: planConfig.planFile,
      resolvedPlanPath: planConfig.resolvedPlanPath,
    });
    return;
  }

  log?.info("plannotator-auto triggering /plannotator", {
    toolName,
    planFile: planConfig.planFile,
    resolvedPlanPath: planConfig.resolvedPlanPath,
  });
  sendCommand(pi, ctx, "plannotator-set-file", planConfig.planFile);
  sendCommand(pi, ctx, "plannotator");
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
}
