import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { registerBashHook } from "../shared/bash-hook.ts";
import { createLogger } from "../shared/logger.ts";
import { loadSettings } from "../shared/settings.ts";
import { tokenizeShell } from "../shared/shell/index.ts";

const DEFAULT_ENV: Record<string, string> = {
  GIT_EXTERNAL_DIFF: "",
  GIT_DIFF: "",
  GIT_PAGER: "cat",
  PAGER: "cat",
  LESS: "FRX",
};

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

// ── git diff 定位 ──────────────────────────────────────────────────────
//
// 用共享结构层的 token 判断"git diff 是不是一个真正的命令"，而不是自己写一遍
// 引号/分隔符状态机（ADR-0001 D3）。要改写的只是命令本身，所以拿的是 token 的
// 原始偏移：prefix 原样保留，rest 是 diff 之后的参数。
type GitDiffMatch = {
  /** Everything before "git diff" in the original command (preserved as-is) */
  prefix: string;
  /** Everything after "git diff" (the diff arguments) */
  rest: string;
};

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function findGitDiffCommand(command: string): GitDiffMatch | null {
  const { tokens } = tokenizeShell(command);
  let atSegmentStart = true;

  for (const [index, token] of tokens.entries()) {
    if (token.kind === "newline") {
      atSegmentStart = true;
      continue;
    }
    if (token.kind === "operator") {
      atSegmentStart = true;
      continue;
    }
    if (token.kind !== "word") continue;
    // heredoc token 不会出现在这里；引号里的词不是命令位置
    if (!atSegmentStart) continue;
    // VAR=value 前缀：同一条命令的一部分，跳过它继续找命令名
    if (ENV_ASSIGNMENT.test(token.text) && !token.quoted) continue;

    atSegmentStart = false;
    if (token.text !== "git") continue;

    const next = tokens[index + 1];
    const after = tokens[index + 2];
    if (next?.kind !== "word" || next.text !== "diff") continue;
    if (after !== undefined && after.kind === "operator" && after.raw === "-") {
      continue;
    }

    return {
      prefix: command.slice(0, token.start),
      rest: command.slice(next.end).trimStart(),
    };
  }

  return null;
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

const NO_EXT_DIFF_FLAG = "--no-ext-diff";
const END_OF_OPTIONS = /(^|\s)--(\s|$)/;
const SPECIAL_REGEX_CHARS = /[.*+?^${}()|[\]\\]/g;

function normalizeFlagList(flags: string[]): string[] {
  return flags.map((flag) => flag.trim()).filter(Boolean);
}

function uniqueFlags(flags: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const flag of flags) {
    if (seen.has(flag)) continue;
    seen.add(flag);
    result.push(flag);
  }
  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(SPECIAL_REGEX_CHARS, "\\$&");
}

function sliceBeforeOptionsEnd(value: string): string {
  const match = value.match(END_OF_OPTIONS);
  if (!match || match.index === undefined) {
    return value;
  }
  return value.slice(0, match.index).trimEnd();
}

function hasFlagToken(value: string, flag: string): boolean {
  const pattern = new RegExp(`(^|\\s)${escapeRegExp(flag)}(\\s|$)`);
  return pattern.test(value);
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
  const found = findGitDiffCommand(command);
  if (!found) return command;

  const { prefix, rest } = found;
  const flagRegion = sliceBeforeOptionsEnd(rest);
  const normalizedFlags = uniqueFlags(normalizeFlagList(extraFlags));
  const commandHasNoExtDiff = hasFlagToken(flagRegion, NO_EXT_DIFF_FLAG);
  const extraHasNoExtDiff = normalizedFlags.includes(NO_EXT_DIFF_FLAG);
  const extraFlagsFiltered = commandHasNoExtDiff
    ? normalizedFlags.filter((flag) => flag !== NO_EXT_DIFF_FLAG)
    : normalizedFlags;
  const needsNoExtDiff = !commandHasNoExtDiff && !extraHasNoExtDiff;
  const diffFlags = [
    ...(needsNoExtDiff ? [NO_EXT_DIFF_FLAG] : []),
    ...extraFlagsFiltered,
  ];
  const extra = diffFlags.length > 0 ? ` ${diffFlags.join(" ")}` : "";
  const suffix = rest ? ` ${rest}` : "";
  const rewritten = `${prefix}git --no-pager diff${extra}${suffix}`;

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
    forceReload: false,
  });

  for (const [key, value] of Object.entries(envMap)) {
    if (value === "") {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  log?.debug("Applied env guard", { cwd: ctx.cwd, gitDiffFlags });
}

export default function (pi: ExtensionAPI) {
  log = createLogger("env-guard", { stderr: null });
  registerGitDiffHook();

  pi.on("session_start", (_event, ctx) => {
    applyEnvGuard(ctx);
  });
}
