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

// Queue auto-trigger; the actual submission happens when it is safe.
const queuePlanTrigger = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  planFile: string,
): void => {
  const commands = [
    buildCommandText(pi, "plannotator-set-file", planFile),
    buildCommandText(pi, "plannotator", planFile),
    buildCommandText(pi, "plannotator-annotate", planFile),
  ].filter((value): value is string => Boolean(value));

  if (commands.length === 0) {
    return;
  }

  pendingTrigger = {
    commands,
    planFile,
    createdAt: Date.now(),
  };

  log?.debug("plannotator-auto queued trigger", {
    planFile,
    commands,
  });
  tryTriggerPlanMode(ctx, "queue");
};

const resolvePlanPath = (cwd: string, planFile: string): string =>
  path.resolve(cwd, planFile);

const getPlanFileConfig = (
  ctx: ExtensionContext,
): { planFile: string; resolvedPlanPath: string } | null => {
  const config = loadConfig();
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

  log?.info("plannotator-auto queueing /plannotator trigger", {
    toolName,
    planFile: planConfig.planFile,
    resolvedPlanPath: planConfig.resolvedPlanPath,
  });
  queuePlanTrigger(pi, ctx, planConfig.planFile);
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
