import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { registerBashHook } from "../shared/bash-hook.ts";
import { createLogger } from "../shared/logger.ts";
import { loadSettings } from "../shared/settings.ts";

const DEFAULT_ENV: Record<string, string> = {
  GIT_EXTERNAL_DIFF: "",
  GIT_DIFF: "",
  GIT_PAGER: "cat",
  PAGER: "cat",
  LESS: "FRX",
};

const GIT_DIFF_COMMAND = /^\s*git\s+diff(\s|$)/;
const GIT_DIFF_HOOK_ID = "git-diff";

type EnvGuardSettings = {
  env?: Record<string, unknown>;
  gitDiffFlags?: unknown;
};

type EnvGuardConfig = {
  cwd: string;
  envMap: Record<string, string>;
  gitDiffFlags: string[];
};

let cachedConfig: EnvGuardConfig | null = null;
let log: ReturnType<typeof createLogger> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extractEnvOverrides(
  settings: Record<string, unknown>,
): Record<string, string> {
  if (!isRecord(settings.envGuard)) return {};
  const envGuard = settings.envGuard as EnvGuardSettings;
  if (!isRecord(envGuard.env)) return {};

  const overrides: Record<string, string> = {};
  for (const [key, value] of Object.entries(envGuard.env)) {
    if (typeof value === "string") {
      overrides[key] = value;
    }
  }
  return overrides;
}

function normalizeFlagList(flags: string[]): string[] {
  return flags.map((flag) => flag.trim()).filter(Boolean);
}

function extractGitDiffFlags(
  settings: Record<string, unknown>,
): string[] | null {
  if (!isRecord(settings.envGuard)) return null;
  const envGuard = settings.envGuard as EnvGuardSettings;

  if (!Object.hasOwn(envGuard, "gitDiffFlags")) {
    return null;
  }

  const raw = envGuard.gitDiffFlags;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed ? [trimmed] : [];
  }

  if (Array.isArray(raw)) {
    return normalizeFlagList(
      raw.filter((value): value is string => typeof value === "string"),
    );
  }

  return [];
}

export function resolveEnvGuardConfig(
  cwd: string,
  options?: { forceReload?: boolean },
): EnvGuardConfig {
  if (!options?.forceReload && cachedConfig?.cwd === cwd) {
    return cachedConfig;
  }

  const {
    projectPath,
    globalPath,
    global: globalSettings,
    project: projectSettings,
  } = loadSettings(cwd, { forceReload: options?.forceReload });
  const globalOverrides = extractEnvOverrides(globalSettings);
  const projectOverrides = extractEnvOverrides(projectSettings);

  const projectFlags = extractGitDiffFlags(projectSettings);
  const globalFlags = extractGitDiffFlags(globalSettings);

  const envMap = {
    ...DEFAULT_ENV,
    ...globalOverrides,
    ...projectOverrides,
  };

  const gitDiffFlags =
    projectFlags !== null ? projectFlags : (globalFlags ?? []);

  cachedConfig = {
    cwd,
    envMap,
    gitDiffFlags,
  };

  log?.info("Loaded env-guard settings", {
    cwd,
    projectPath,
    globalPath,
    gitDiffFlags,
  });

  return cachedConfig;
}

export function rewriteGitDiffCommand(
  command: string,
  extraFlags: string[],
): string {
  if (!GIT_DIFF_COMMAND.test(command)) {
    return command;
  }

  const trimmed = command.trimStart();
  const leadingWhitespace = command.slice(0, command.length - trimmed.length);
  const rest = trimmed.replace(GIT_DIFF_COMMAND, "").trimStart();
  const normalizedFlags = normalizeFlagList(extraFlags);
  const extra =
    normalizedFlags.length > 0 ? ` ${normalizedFlags.join(" ")}` : "";
  const suffix = rest ? ` ${rest}` : "";
  const rewritten = `${leadingWhitespace}git --no-pager diff --no-ext-diff${extra}${suffix}`;

  log?.debug("Rewrote git diff command", {
    command,
    rewritten,
    extraFlags: normalizedFlags,
  });

  return rewritten;
}

function registerGitDiffHook(): void {
  registerBashHook({
    id: GIT_DIFF_HOOK_ID,
    hook: async ({ command, cwd, ctx }) => {
      const { gitDiffFlags } = resolveEnvGuardConfig(cwd);
      const rewritten = rewriteGitDiffCommand(command, gitDiffFlags);
      if (rewritten !== command) {
        if (ctx.hasUI) {
          ctx.ui.notify(`Git diff rewrite: ${command} → ${rewritten}`, "info");
        }
        return { command: rewritten };
      }
      return undefined;
    },
  });
}

function applyEnvGuard(ctx: ExtensionContext): void {
  const { envMap, gitDiffFlags } = resolveEnvGuardConfig(ctx.cwd, {
    forceReload: true,
  });

  for (const [key, value] of Object.entries(envMap)) {
    process.env[key] = value;
  }

  log?.debug("Applied env guard", { cwd: ctx.cwd, gitDiffFlags });
}

export default function (pi: ExtensionAPI) {
  log = createLogger("env-guard", { stderr: null });
  registerGitDiffHook();

  pi.on("session_start", (_event, ctx) => {
    applyEnvGuard(ctx);
  });

  pi.on("session_switch", (_event, ctx) => {
    applyEnvGuard(ctx);
  });
}
