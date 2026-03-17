import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { createBashTool, getShellConfig } from "@mariozechner/pi-coding-agent";
import {
  resolveEnvGuardConfig,
  rewriteGitDiffCommand,
} from "../env-guard/index.ts";
import { createLogger } from "../shared/logger.ts";
import { loadGlobalSettings, updateSettings } from "../shared/settings.ts";

type RtkRewriteConfig = {
  enabled: boolean;
  notify: boolean;
  exclude: string[];
};

type RtkRewriteSettings = {
  enabled?: unknown;
  notify?: unknown;
  exclude?: unknown;
};

const DEFAULT_CONFIG: RtkRewriteConfig = {
  enabled: true,
  notify: true,
  exclude: [],
};

let cachedConfig: RtkRewriteConfig = DEFAULT_CONFIG;
let configLoaded = false;
let log: ReturnType<typeof createLogger> | null = null;
let execCommand: ExtensionAPI["exec"] | null = null;

const normalizeEntry = (value: string): string => value.trim().toLowerCase();

const uniqueList = (items: string[]): string[] => Array.from(new Set(items));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const sanitizeConfig = (value: unknown): RtkRewriteConfig => {
  const raw = isRecord(value) ? (value as RtkRewriteSettings) : {};
  const enabled =
    typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled;
  const notify =
    typeof raw.notify === "boolean" ? raw.notify : DEFAULT_CONFIG.notify;
  const excludeRaw = Array.isArray(raw.exclude)
    ? raw.exclude.filter((item): item is string => typeof item === "string")
    : [];
  const exclude = uniqueList(
    excludeRaw.map(normalizeEntry).filter((item) => item.length > 0),
  );

  return {
    enabled,
    notify,
    exclude,
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
    log?.debug("rtk rewrite output", { command, output });
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

const resolveRewrite = async (
  command: string,
  ctx: ExtensionContext,
  source: "tool" | "user_bash",
): Promise<{ command: string; rtkRewritten: boolean }> => {
  const config = getConfig();
  const { gitDiffFlags } = resolveEnvGuardConfig(ctx.cwd);
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

      return { command: rewritten, rtkRewritten: true };
    }

    if (!rewritten) {
      log?.debug("rtk rewrite empty result", { source, command });
    } else if (rewritten === command) {
      log?.debug("rtk rewrite no-op", { source, command });
    }
  } else if (!config.enabled) {
    log?.debug("rtk rewrite skipped (disabled)", { source, command });
  } else {
    log?.debug("rtk rewrite skipped (excluded)", {
      source,
      command,
      exclude: config.exclude,
    });
  }

  const fallback = rewriteGitDiffCommand(command, gitDiffFlags);
  if (fallback !== command) {
    log?.debug("git diff rewrite applied", {
      source,
      command,
      rewritten: fallback,
    });
  }

  return { command: fallback, rtkRewritten: false };
};

const formatStatus = (config: RtkRewriteConfig): string => {
  const status = config.enabled ? "enabled" : "disabled";
  const notify = config.notify ? "on" : "off";
  const exclude = config.exclude.length ? config.exclude.join(", ") : "none";
  return `RTK rewrite ${status} | notify ${notify} | exclude: ${exclude}`;
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

  pi.registerTool({
    ...createBashTool(process.cwd()),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { command } = params;
      const resolved = await resolveRewrite(command, ctx, "tool");
      const bashTool = createBashTool(ctx.cwd);
      return bashTool.execute(
        toolCallId,
        { ...params, command: resolved.command },
        signal,
        onUpdate,
      );
    },
  });

  pi.on("user_bash", async (event, ctx) => {
    const resolved = await resolveRewrite(event.command, ctx, "user_bash");
    if (resolved.command === event.command) {
      return;
    }

    try {
      if (!execCommand) {
        return;
      }
      const { shell, args } = getShellConfig();
      const result = await execCommand(shell, [...args, resolved.command], {
        cwd: event.cwd,
      });
      const output = `${result.stdout}${result.stderr}`.trimEnd();
      return {
        result: {
          output: output.length > 0 ? output : "(no output)",
          exitCode: result.code,
          cancelled: false,
          truncated: false,
        },
      };
    } catch (error) {
      return {
        result: {
          output: `rtk rewrite execution failed: ${String(error)}`,
          exitCode: 1,
          cancelled: false,
          truncated: false,
        },
      };
    }
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
      const config = loadConfig({ forceReload: true });
      notifyStatus(ctx, config);
    },
  });

  pi.on("session_start", () => {
    loadConfig({ forceReload: true });
  });

  pi.on("session_switch", () => {
    loadConfig({ forceReload: true });
  });
}
