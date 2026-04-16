import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  isBashToolResult,
} from "@mariozechner/pi-coding-agent";
import { getBashHookStatus, registerBashHook } from "../shared/bash-hook.ts";
import { createLogger } from "../shared/logger.ts";
import { loadGlobalSettings, updateSettings } from "../shared/settings.ts";
import {
  createBuildOutputFilter,
  createTestOutputFilter,
  DEFAULT_OUTPUT_TAIL_MAX_CHARS,
  DEFAULT_OUTPUT_TAIL_MAX_LINES,
  isBuildCommand,
  isTestCommand,
} from "./output-filter.ts";

export type CommandRegistry = {
  build: string[];
  test: string[];
};

type CommandScope = keyof CommandRegistry;
type CommandAction = "add" | "remove" | "clear" | "list";

type ParsedCommandRegistryArgs = {
  scope: CommandScope;
  action: CommandAction;
  pattern?: string;
};

type ParseCommandRegistryArgsResult =
  | { ok: true; value: ParsedCommandRegistryArgs }
  | { ok: false; error: string };

type RtkRewriteConfig = {
  enabled: boolean;
  notify: boolean;
  exclude: string[];
  buildOutputFiltering: boolean;
  testOutputAggregation: boolean;
  rewriteMatchedBuildTestCommands: boolean;
  commandRegistry: CommandRegistry;
  outputTailMaxLines: number;
  outputTailMaxChars: number;
};

type RtkRewriteSettings = {
  enabled?: unknown;
  notify?: unknown;
  exclude?: unknown;
  buildOutputFiltering?: unknown;
  testOutputAggregation?: unknown;
  rewriteMatchedBuildTestCommands?: unknown;
  commandRegistry?: unknown;
  outputTailMaxLines?: unknown;
  outputTailMaxChars?: unknown;
};

const DEFAULT_COMMAND_REGISTRY: CommandRegistry = {
  build: [],
  test: [],
};

const DEFAULT_CONFIG: RtkRewriteConfig = {
  enabled: true,
  notify: true,
  exclude: [],
  buildOutputFiltering: true,
  testOutputAggregation: true,
  rewriteMatchedBuildTestCommands: true,
  commandRegistry: DEFAULT_COMMAND_REGISTRY,
  outputTailMaxLines: DEFAULT_OUTPUT_TAIL_MAX_LINES,
  outputTailMaxChars: DEFAULT_OUTPUT_TAIL_MAX_CHARS,
};

const RTK_HOOK_ID = "rtk";
const COMMANDS_USAGE =
  "Usage: /rtk-rewrite-commands <build|test> <add|remove|clear|list> [pattern]";

let cachedConfig: RtkRewriteConfig = DEFAULT_CONFIG;
let configLoaded = false;
let log: ReturnType<typeof createLogger> | null = null;
let execCommand: ExtensionAPI["exec"] | null = null;

const normalizeEntry = (value: string): string => value.trim().toLowerCase();

const uniqueList = (items: string[]): string[] => Array.from(new Set(items));

const normalizeEntries = (value: unknown): string[] => {
  const raw = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
  return uniqueList(raw.map(normalizeEntry).filter((item) => item.length > 0));
};

const sanitizePositiveInteger = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const sanitizeCommandRegistry = (value: unknown): CommandRegistry => {
  if (!isRecord(value)) {
    return {
      build: [...DEFAULT_COMMAND_REGISTRY.build],
      test: [...DEFAULT_COMMAND_REGISTRY.test],
    };
  }

  return {
    build: normalizeEntries(value.build),
    test: normalizeEntries(value.test),
  };
};

const sanitizeConfig = (value: unknown): RtkRewriteConfig => {
  const raw = isRecord(value) ? (value as RtkRewriteSettings) : {};
  const enabled =
    typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled;
  const notify =
    typeof raw.notify === "boolean" ? raw.notify : DEFAULT_CONFIG.notify;
  const buildOutputFiltering =
    typeof raw.buildOutputFiltering === "boolean"
      ? raw.buildOutputFiltering
      : DEFAULT_CONFIG.buildOutputFiltering;
  const testOutputAggregation =
    typeof raw.testOutputAggregation === "boolean"
      ? raw.testOutputAggregation
      : DEFAULT_CONFIG.testOutputAggregation;
  const rewriteMatchedBuildTestCommands =
    typeof raw.rewriteMatchedBuildTestCommands === "boolean"
      ? raw.rewriteMatchedBuildTestCommands
      : DEFAULT_CONFIG.rewriteMatchedBuildTestCommands;
  const exclude = normalizeEntries(raw.exclude);
  const commandRegistry = sanitizeCommandRegistry(raw.commandRegistry);
  const outputTailMaxLines = sanitizePositiveInteger(
    raw.outputTailMaxLines,
    DEFAULT_CONFIG.outputTailMaxLines,
  );
  const outputTailMaxChars = sanitizePositiveInteger(
    raw.outputTailMaxChars,
    DEFAULT_CONFIG.outputTailMaxChars,
  );

  return {
    enabled,
    notify,
    exclude,
    buildOutputFiltering,
    testOutputAggregation,
    rewriteMatchedBuildTestCommands,
    commandRegistry,
    outputTailMaxLines,
    outputTailMaxChars,
  };
};

const loadConfig = (options?: { forceReload?: boolean }): RtkRewriteConfig => {
  const { global } = loadGlobalSettings(options);
  const config = sanitizeConfig(global.rtkRewrite);
  cachedConfig = config;
  configLoaded = true;
  return config;
};

const getConfig = (): RtkRewriteConfig => {
  if (!configLoaded) {
    return loadConfig();
  }
  return cachedConfig;
};

const updateConfig = (
  cwd: string,
  updater: (current: RtkRewriteConfig) => RtkRewriteConfig,
): RtkRewriteConfig => {
  const result = updateSettings(cwd, "global", (settings) => {
    const current = sanitizeConfig(settings.rtkRewrite);
    const next = updater(current);
    return {
      ...settings,
      rtkRewrite: {
        enabled: next.enabled,
        notify: next.notify,
        exclude: [...next.exclude],
        buildOutputFiltering: next.buildOutputFiltering,
        testOutputAggregation: next.testOutputAggregation,
        rewriteMatchedBuildTestCommands: next.rewriteMatchedBuildTestCommands,
        commandRegistry: {
          build: [...next.commandRegistry.build],
          test: [...next.commandRegistry.test],
        },
        outputTailMaxLines: next.outputTailMaxLines,
        outputTailMaxChars: next.outputTailMaxChars,
      },
    };
  });

  const config = sanitizeConfig(result.settings.rtkRewrite);
  cachedConfig = config;
  configLoaded = true;
  return config;
};

const shouldExclude = (command: string, exclude: string[]): boolean => {
  const normalized = command.trimStart().toLowerCase();
  for (const entry of exclude) {
    if (!entry) continue;
    if (normalized === entry) return true;
    if (normalized.startsWith(`${entry} `)) return true;
    if (normalized.startsWith(`${entry}\t`)) return true;
  }
  return false;
};

const formatEntries = (entries: string[]): string => {
  if (entries.length === 0) return "none";
  if (entries.length <= 3) return entries.join(", ");
  return `${entries.slice(0, 3).join(", ")} +${entries.length - 3}`;
};

const formatScopedCommands = (
  scope: CommandScope,
  entries: string[],
  opts?: { previewOnly?: boolean },
): string => {
  if (opts?.previewOnly) {
    return `${scope} (${entries.length}): ${formatEntries(entries)}`;
  }

  if (entries.length === 0) {
    return `${scope} commands (0): none`;
  }

  return `${scope} commands (${entries.length}): ${entries.join(", ")}`;
};

type RewriteCommandMatchConfig = Pick<
  RtkRewriteConfig,
  "rewriteMatchedBuildTestCommands" | "commandRegistry"
>;

export const shouldSkipRewriteForBuildTestCommand = (
  command: string,
  config: RewriteCommandMatchConfig,
): boolean => {
  if (config.rewriteMatchedBuildTestCommands) {
    return false;
  }

  return (
    isBuildCommand(command, config.commandRegistry.build) ||
    isTestCommand(command, config.commandRegistry.test)
  );
};

export const parseCommandRegistryArgs = (
  rawArgs: string,
): ParseCommandRegistryArgsResult => {
  const trimmed = rawArgs.trim();
  if (!trimmed) {
    return { ok: false, error: COMMANDS_USAGE };
  }

  const [scopeRaw = "", actionRaw = "", ...rest] = trimmed.split(/\s+/);
  if (scopeRaw !== "build" && scopeRaw !== "test") {
    return { ok: false, error: "Scope must be build or test." };
  }

  if (
    actionRaw !== "add" &&
    actionRaw !== "remove" &&
    actionRaw !== "clear" &&
    actionRaw !== "list"
  ) {
    return { ok: false, error: "Action must be add, remove, clear, or list." };
  }

  const pattern = rest.join(" ").trim();
  if ((actionRaw === "add" || actionRaw === "remove") && !pattern) {
    return { ok: false, error: "Pattern is required for add/remove." };
  }

  if ((actionRaw === "clear" || actionRaw === "list") && pattern) {
    return {
      ok: false,
      error: "Pattern is not allowed for clear/list.",
    };
  }

  return pattern
    ? {
        ok: true,
        value: {
          scope: scopeRaw,
          action: actionRaw,
          pattern,
        },
      }
    : {
        ok: true,
        value: {
          scope: scopeRaw,
          action: actionRaw,
        },
      };
};

export const applyCommandRegistryAction = (
  registry: CommandRegistry,
  command: ParsedCommandRegistryArgs,
): { registry: CommandRegistry; changed: boolean } => {
  const next: CommandRegistry = {
    build: [...registry.build],
    test: [...registry.test],
  };

  if (command.action === "list") {
    return { registry: next, changed: false };
  }

  if (command.action === "clear") {
    if (next[command.scope].length === 0) {
      return { registry: next, changed: false };
    }

    next[command.scope] = [];
    return { registry: next, changed: true };
  }

  const pattern = normalizeEntry(command.pattern ?? "");
  if (!pattern) {
    return { registry: next, changed: false };
  }

  if (command.action === "add") {
    if (next[command.scope].includes(pattern)) {
      return { registry: next, changed: false };
    }
    next[command.scope] = [...next[command.scope], pattern];
    return { registry: next, changed: true };
  }

  const filtered = next[command.scope].filter((entry) => entry !== pattern);
  if (filtered.length === next[command.scope].length) {
    return { registry: next, changed: false };
  }

  next[command.scope] = filtered;
  return { registry: next, changed: true };
};

const runRtkRewrite = async (
  command: string,
  ctx: ExtensionContext,
): Promise<string | null> => {
  try {
    if (!execCommand) {
      log?.debug("rtk rewrite exec not ready");
      return null;
    }
    log?.debug("rtk rewrite command", { command, cwd: ctx.cwd });
    const result = await execCommand("rtk", ["rewrite", command], {
      cwd: ctx.cwd,
    });
    if (result.code !== 0) {
      const stderr = result.stderr.trim();
      log?.warn("rtk rewrite returned non-zero", {
        command,
        code: result.code,
        stderr: stderr.length > 0 ? stderr : null,
      });
      return null;
    }
    const output = result.stdout.trim();
    log?.info("rtk rewrite output", { command, output });
    return output.length > 0 ? output : null;
  } catch (error) {
    log?.warn("rtk rewrite failed", {
      command,
      cwd: ctx.cwd,
      error: String(error),
    });
    return null;
  }
};

const resolveRtkRewrite = async (
  command: string,
  ctx: ExtensionContext,
  source: "tool" | "user_bash",
): Promise<string | null> => {
  const config = getConfig();
  log?.debug("rtk rewrite requested", {
    source,
    command,
    enabled: config.enabled,
  });

  if (!config.enabled) {
    log?.debug("rtk rewrite skipped (disabled)", { source, command });
    return null;
  }

  if (shouldExclude(command, config.exclude)) {
    log?.debug("rtk rewrite skipped (excluded)", {
      source,
      command,
      exclude: config.exclude,
    });
    return null;
  }

  if (shouldSkipRewriteForBuildTestCommand(command, config)) {
    log?.debug("rtk rewrite skipped (build/test rewrite disabled)", {
      source,
      command,
    });
    return null;
  }

  const rewritten = await runRtkRewrite(command, ctx);
  if (rewritten && rewritten !== command) {
    log?.info("rtk rewrite applied", { source, command, rewritten });

    if (config.notify && ctx.hasUI) {
      ctx.ui.notify(`RTK rewrite: ${command} → ${rewritten}`, "info");
    }

    return rewritten;
  }

  if (!rewritten) {
    log?.debug("rtk rewrite empty result", { source, command });
  } else if (rewritten === command) {
    log?.debug("rtk rewrite no-op", { source, command });
  }

  return null;
};

const resolveOriginalCommand = (
  command: string,
  ctx: ExtensionContext,
): string => {
  const status = getBashHookStatus(ctx.cwd);
  if (status.lastRun && status.lastRun.resolved === command) {
    return status.lastRun.command;
  }
  return command;
};

const resolveFilteredOutput = (
  output: string,
  command: string,
  config: RtkRewriteConfig,
): string | null => {
  const filters = [
    createBuildOutputFilter({
      enabled: config.buildOutputFiltering,
      commands: config.commandRegistry.build,
      maxLines: config.outputTailMaxLines,
      maxChars: config.outputTailMaxChars,
    }),
    createTestOutputFilter({
      enabled: config.testOutputAggregation,
      commands: config.commandRegistry.test,
      maxLines: config.outputTailMaxLines,
      maxChars: config.outputTailMaxChars,
    }),
  ];

  for (const filter of filters) {
    if (!filter.enabled) continue;
    if (!filter.matches(command)) continue;
    const next = filter.apply(output, command);
    if (next && next !== output) {
      return next;
    }
    return null;
  }

  return null;
};

const formatStatus = (config: RtkRewriteConfig): string => {
  const status = config.enabled ? "enabled" : "disabled";
  const notify = config.notify ? "on" : "off";
  const exclude = config.exclude.length ? config.exclude.join(", ") : "none";
  const buildTestRewrite = config.rewriteMatchedBuildTestCommands
    ? "on"
    : "off";
  const buildFilter = `${config.buildOutputFiltering ? "on" : "off"} (${formatScopedCommands(
    "build",
    config.commandRegistry.build,
    {
      previewOnly: true,
    },
  )})`;
  const testFilter = `${config.testOutputAggregation ? "on" : "off"} (${formatScopedCommands(
    "test",
    config.commandRegistry.test,
    {
      previewOnly: true,
    },
  )})`;
  const tailCaps = `lines ${config.outputTailMaxLines}, chars ${config.outputTailMaxChars}`;
  return `RTK rewrite ${status} | notify ${notify} | exclude: ${exclude} | build/test rewrite ${buildTestRewrite} | build filter ${buildFilter} | test filter ${testFilter} | tail caps: ${tailCaps}`;
};

const notifyStatus = (
  ctx: ExtensionCommandContext,
  config: RtkRewriteConfig,
  prefix?: string,
): void => {
  const message = prefix
    ? `${prefix} ${formatStatus(config)}`
    : formatStatus(config);
  ctx.ui.notify(message, "info");
};

const handleEnable = (ctx: ExtensionCommandContext, enabled: boolean): void => {
  const config = updateConfig(ctx.cwd, (current) => ({
    ...current,
    enabled,
  }));
  notifyStatus(ctx, config, `RTK rewrite ${enabled ? "enabled" : "disabled"}.`);
};

const handleToggle = (ctx: ExtensionCommandContext): void => {
  const config = updateConfig(ctx.cwd, (current) => ({
    ...current,
    enabled: !current.enabled,
  }));
  notifyStatus(ctx, config, "RTK rewrite toggled.");
};

const handleBuildTestRewriteToggle = (ctx: ExtensionCommandContext): void => {
  const config = updateConfig(ctx.cwd, (current) => ({
    ...current,
    rewriteMatchedBuildTestCommands: !current.rewriteMatchedBuildTestCommands,
  }));
  notifyStatus(ctx, config, "RTK build/test rewrite toggled.");
};

const handleExclude = (
  ctx: ExtensionCommandContext,
  rawEntry: string,
): void => {
  const entry = normalizeEntry(rawEntry);
  if (!entry) {
    ctx.ui.notify("Provide a command prefix to exclude.", "warning");
    return;
  }

  const config = updateConfig(ctx.cwd, (current) => {
    const exclude = uniqueList([...current.exclude, entry]);
    return { ...current, exclude };
  });

  notifyStatus(ctx, config, `Excluded "${entry}".`);
};

const handleInclude = (
  ctx: ExtensionCommandContext,
  rawEntry: string,
): void => {
  const entry = normalizeEntry(rawEntry);
  if (!entry) {
    ctx.ui.notify("Provide a command prefix to include.", "warning");
    return;
  }

  const config = updateConfig(ctx.cwd, (current) => {
    const exclude = current.exclude.filter((item) => item !== entry);
    return { ...current, exclude };
  });

  notifyStatus(ctx, config, `Included "${entry}".`);
};

const describeRegistryAction = (
  command: ParsedCommandRegistryArgs,
  entries: string[],
): string => {
  if (command.action === "add") {
    return `Added "${normalizeEntry(command.pattern ?? "")}". ${formatScopedCommands(command.scope, entries)}`;
  }

  if (command.action === "remove") {
    return `Removed "${normalizeEntry(command.pattern ?? "")}". ${formatScopedCommands(command.scope, entries)}`;
  }

  return `Cleared ${command.scope} commands. ${formatScopedCommands(command.scope, entries)}`;
};

const handleCommandRegistry = (
  ctx: ExtensionCommandContext,
  rawArgs: string,
): void => {
  const parsed = parseCommandRegistryArgs(rawArgs);
  if (!parsed.ok) {
    ctx.ui.notify(parsed.error, "warning");
    if (parsed.error !== COMMANDS_USAGE) {
      ctx.ui.notify(COMMANDS_USAGE, "info");
    }
    return;
  }

  const command = parsed.value;
  if (command.action === "list") {
    const config = loadConfig();
    const entries = config.commandRegistry[command.scope];
    ctx.ui.notify(formatScopedCommands(command.scope, entries), "info");
    return;
  }

  let changed = false;
  const config = updateConfig(ctx.cwd, (current) => {
    const result = applyCommandRegistryAction(current.commandRegistry, command);
    changed = result.changed;
    if (!result.changed) {
      return current;
    }

    return {
      ...current,
      commandRegistry: result.registry,
    };
  });

  const entries = config.commandRegistry[command.scope];
  if (!changed) {
    ctx.ui.notify(
      `No changes for ${command.scope} commands. ${formatScopedCommands(command.scope, entries)}`,
      "info",
    );
    return;
  }

  ctx.ui.notify(describeRegistryAction(command, entries), "info");
};

export default function (pi: ExtensionAPI) {
  log = createLogger("rtk-rewrite", { stderr: null });
  execCommand = pi.exec;

  registerBashHook({
    id: RTK_HOOK_ID,
    hook: async ({ command, ctx, source }) => {
      const rewritten = await resolveRtkRewrite(command, ctx, source);
      return rewritten ? { command: rewritten } : undefined;
    },
  });

  pi.on("tool_result", (event, ctx) => {
    if (!isBashToolResult(event)) return;

    const config = getConfig();
    if (!config.enabled) return;
    if (!config.buildOutputFiltering && !config.testOutputAggregation) return;

    const command = (event.input as { command?: string }).command;
    if (!command) return;

    const originalCommand = resolveOriginalCommand(command, ctx);
    if (shouldExclude(originalCommand, config.exclude)) return;

    const content = event.content;
    const textItem = content?.find((item) => item.type === "text");
    if (!textItem || !("text" in textItem)) return;

    const filtered = resolveFilteredOutput(
      textItem.text,
      originalCommand,
      config,
    );
    if (!filtered) return;

    return {
      content: content.map((item) =>
        item.type === "text" ? { ...item, text: filtered } : item,
      ),
    };
  });

  pi.registerCommand("rtk-rewrite-enable", {
    description: "Enable RTK auto-rewrite",
    handler: async (_args, ctx) => {
      handleEnable(ctx, true);
    },
  });

  pi.registerCommand("rtk-rewrite-disable", {
    description: "Disable RTK auto-rewrite",
    handler: async (_args, ctx) => {
      handleEnable(ctx, false);
    },
  });

  pi.registerCommand("rtk-rewrite-toggle", {
    description: "Toggle RTK auto-rewrite",
    handler: async (_args, ctx) => {
      handleToggle(ctx);
    },
  });

  pi.registerCommand("rtk-rewrite-build-test-rewrite-toggle", {
    description: "Toggle RTK rewrite for matched build/test commands",
    handler: async (_args, ctx) => {
      handleBuildTestRewriteToggle(ctx);
    },
  });

  pi.registerCommand("rtk-rewrite-commands", {
    description:
      "Manage RTK build/test command lists. Usage: /rtk-rewrite-commands <build|test> <add|remove|clear|list> [pattern]",
    handler: async (args, ctx) => {
      handleCommandRegistry(ctx, args);
    },
  });

  pi.registerCommand("rtk-rewrite-exclude", {
    description: "Exclude a command prefix from RTK auto-rewrite",
    handler: async (args, ctx) => {
      handleExclude(ctx, args);
    },
  });

  pi.registerCommand("rtk-rewrite-include", {
    description: "Remove a command prefix from the exclude list",
    handler: async (args, ctx) => {
      handleInclude(ctx, args);
    },
  });

  pi.registerCommand("rtk-rewrite-status", {
    description: "Show RTK auto-rewrite status",
    handler: async (_args, ctx) => {
      const config = loadConfig();
      notifyStatus(ctx, config);
    },
  });

  pi.on("session_start", () => {
    loadConfig();
  });

  pi.on("session_switch", () => {
    loadConfig();
  });
}
