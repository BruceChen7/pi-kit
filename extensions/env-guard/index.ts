import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
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

const GIT_DIFF_COMMAND = /(^|\s)git\s+diff(\s|$)/;
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

// Check if a position in the command string is inside single/double quotes.
function isInsideQuotes(str: string, pos: number): boolean {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < pos; i++) {
    const ch = str[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
  }
  return inSingle || inDouble;
}

// Check that "git diff" appears as a command (not as an argument to another command).
// It must be at the start, or preceded by a shell control operator (;&|), or preceded
// by one or more env var assignments (VAR=value).
function isAtCommandBoundary(command: string, matchIndex: number): boolean {
  if (matchIndex === 0) return true;
  let i = matchIndex - 1;
  while (i >= 0 && /\s/.test(command[i])) i--;
  if (i < 0 || ";|&(".includes(command[i])) return true;

  // Check for env var prefix: VAR=value or VAR1=a VAR2=b before git diff.
  // Scan backwards from matchIndex to the last control operator or string start.
  const beforeMatch = command.slice(0, matchIndex).trimEnd();
  const lastOpIdx = Math.max(
    beforeMatch.lastIndexOf(";"),
    beforeMatch.lastIndexOf("&"),
    beforeMatch.lastIndexOf("|"),
  );
  const afterOp =
    lastOpIdx >= 0
      ? beforeMatch.slice(lastOpIdx + 1).trim()
      : beforeMatch;
  // Match one or more env var assignments: VAR=value, VAR1=a VAR2=b
  if (/^(\w+=\S+\s+)*\w+=\S+$/.test(afterOp)) return true;

  return false;
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
  if (!GIT_DIFF_COMMAND.test(command)) {
    return command;
  }

  // Use match() instead of replace() to correctly handle compound commands
  // (e.g. "cd /path && git diff ..." or "VAR=val git diff ..."). The old approach
  // removed "git diff" from the middle of the string but accidentally kept the
  // compound prefix as part of the suffix, producing malformed commands like:
  //   git --no-pager diff --no-ext-diff cd /path && ...
  const match = command.match(GIT_DIFF_COMMAND);
  if (!match || match.index === undefined) return command;

  // Only rewrite if "git diff" appears as a command, not inside a quoted string
  // (e.g. git commit -m "fix: git diff issue") or as an argument to another command
  // (e.g. echo git diff).
  if (isInsideQuotes(command, match.index)) return command;
  if (!isAtCommandBoundary(command, match.index)) return command;

  // Include the (^|\s) captured character (e.g., space before "git") in the prefix
  // so &&git stays as && git for readability.
  const prefix = command.slice(0, match.index + (match[1]?.length ?? 0));
  const afterGit = command.slice(match.index + (match[1]?.length ?? 0));
  // Extract only the arguments after "git diff", leaving the prefix untouched
  const rest = afterGit.replace(GIT_DIFF_COMMAND, "").trimStart();
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
