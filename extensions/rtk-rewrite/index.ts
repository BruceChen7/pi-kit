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
  DEFAULT_BUILD_COMMANDS,
  DEFAULT_TEST_COMMANDS,
  mergeCommandLists,
} from "./output-filter.ts";

type RtkRewriteConfig = {
  enabled: boolean;
  notify: boolean;
  exclude: string[];
  buildOutputFiltering: boolean;
  testOutputAggregation: boolean;
  buildCommands: string[];
  testCommands: string[];
};

type RtkRewriteSettings = {
  enabled?: unknown;
  notify?: unknown;
  exclude?: unknown;
  buildOutputFiltering?: unknown;
  testOutputAggregation?: unknown;
  buildCommands?: unknown;
  testCommands?: unknown;
};

const DEFAULT_CONFIG: RtkRewriteConfig = {
  enabled: true,
  notify: true,
  exclude: [],
  buildOutputFiltering: true,
  testOutputAggregation: true,
  buildCommands: [],
  testCommands: [],
};

const RTK_HOOK_ID = "rtk";

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

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
  const exclude = normalizeEntries(raw.exclude);
  const buildCommands = normalizeEntries(raw.buildCommands);
  const testCommands = normalizeEntries(raw.testCommands);

  return {
    enabled,
    notify,
    exclude,
    buildOutputFiltering,
    testOutputAggregation,
    buildCommands,
    testCommands,
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
        buildCommands: [...next.buildCommands],
        testCommands: [...next.testCommands],
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

const formatExtras = (entries: string[]): string => {
  if (entries.length === 0) return "none";
  if (entries.length <= 3) return entries.join(", ");
  return `${entries.slice(0, 3).join(", ")} +${entries.length - 3}`;
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

  if (config.enabled && !shouldExclude(command, config.exclude)) {
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
  }

  if (!config.enabled) {
    log?.debug("rtk rewrite skipped (disabled)", { source, command });
  } else {
    log?.debug("rtk rewrite skipped (excluded)", {
      source,
      command,
      exclude: config.exclude,
    });
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
  const buildCommands = mergeCommandLists(
    DEFAULT_BUILD_COMMANDS,
    config.buildCommands,
  );
  const testCommands = mergeCommandLists(
    DEFAULT_TEST_COMMANDS,
    config.testCommands,
  );
  const filters = [
    createBuildOutputFilter({
      enabled: config.buildOutputFiltering,
      commands: buildCommands,
    }),
    createTestOutputFilter({
      enabled: config.testOutputAggregation,
      commands: testCommands,
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
  const buildFilter = `${config.buildOutputFiltering ? "on" : "off"} (extra: ${formatExtras(config.buildCommands)})`;
  const testFilter = `${config.testOutputAggregation ? "on" : "off"} (extra: ${formatExtras(config.testCommands)})`;
  return `RTK rewrite ${status} | notify ${notify} | exclude: ${exclude} | build filter ${buildFilter} | test filter ${testFilter}`;
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
