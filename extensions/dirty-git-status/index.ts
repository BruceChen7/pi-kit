import { spawnSync } from "node:child_process";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { createLogger } from "../shared/logger.ts";
import { loadSettings } from "../shared/settings.ts";

type DirtyGitStatusSettings = {
  enabled?: unknown;
  checkOnSessionStart?: unknown;
  timeoutMs?: unknown;
  promptFrequency?: unknown;
  commitMessageMode?: unknown;
  defaultCommitMessage?: unknown;
};

type PromptFrequency = "once_per_dirty_session";
type CommitMessageMode = "auto" | "auto_with_override" | "ask";

type DirtyGitStatusConfig = {
  enabled: boolean;
  checkOnSessionStart: boolean;
  timeoutMs: number;
  promptFrequency: PromptFrequency;
  commitMessageMode: CommitMessageMode;
  defaultCommitMessage: string;
};

type RepoState = {
  prompted: boolean;
};

type SessionState = Map<string, RepoState>;

type NotifyLevel = "success" | "info" | "warning" | "error";

export type StatusOutput = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type CommitMessageSelection = {
  message: string | null;
  usedDefault: boolean;
  cancelled: boolean;
};

type PromptDecision = {
  shouldPrompt: boolean;
  nextPrompted: boolean;
};

type CommitPipelineInput = {
  runGit: (args: string[]) => StatusOutput | Promise<StatusOutput>;
  hasUI: boolean;
  confirmCommit: () => Promise<boolean>;
  askCommitMessage: () => Promise<string | null>;
  notify: (message: string, level: NotifyLevel) => void;
  mode: CommitMessageMode;
  defaultMessage: string;
  requireConfirm: boolean;
};

type CommitPipelineResult = {
  committed: boolean;
  reason:
    | "committed"
    | "cancelled"
    | "add_failed"
    | "staged_check_failed"
    | "no_staged_changes"
    | "nothing_to_commit"
    | "commit_failed";
  message: string | null;
};

export type DirtySummary = {
  staged: number;
  unstaged: number;
  untracked: number;
  dirty: boolean;
};

const DEFAULT_CONFIG: DirtyGitStatusConfig = {
  enabled: true,
  checkOnSessionStart: true,
  timeoutMs: 2000,
  promptFrequency: "once_per_dirty_session",
  commitMessageMode: "auto_with_override",
  defaultCommitMessage: "chore: auto-commit workspace changes",
};

const LOG_NAME = "dirty-git-status";
const MANUAL_COMMAND = "commit-now";

export const DEFAULT_COMMIT_MESSAGE = DEFAULT_CONFIG.defaultCommitMessage;

const stateBySession = new Map<string, SessionState>();

let log: ReturnType<typeof createLogger> | null = null;

const normalizeBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

const normalizeNumber = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const normalizePromptFrequency = (
  value: unknown,
  fallback: PromptFrequency,
): PromptFrequency => (value === "once_per_dirty_session" ? value : fallback);

const normalizeCommitMessageMode = (
  value: unknown,
  fallback: CommitMessageMode,
): CommitMessageMode => {
  if (value === "auto" || value === "auto_with_override" || value === "ask") {
    return value;
  }
  return fallback;
};

const normalizeString = (value: unknown, fallback: string): string =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : fallback;

const getSettingsConfig = (cwd: string): DirtyGitStatusConfig => {
  const { merged } = loadSettings(cwd);
  const settings = (merged.dirtyGitStatus ?? {}) as DirtyGitStatusSettings;
  return {
    enabled: normalizeBoolean(settings.enabled, DEFAULT_CONFIG.enabled),
    checkOnSessionStart: normalizeBoolean(
      settings.checkOnSessionStart,
      DEFAULT_CONFIG.checkOnSessionStart,
    ),
    timeoutMs: normalizeNumber(settings.timeoutMs, DEFAULT_CONFIG.timeoutMs),
    promptFrequency: normalizePromptFrequency(
      settings.promptFrequency,
      DEFAULT_CONFIG.promptFrequency,
    ),
    commitMessageMode: normalizeCommitMessageMode(
      settings.commitMessageMode,
      DEFAULT_CONFIG.commitMessageMode,
    ),
    defaultCommitMessage: normalizeString(
      settings.defaultCommitMessage,
      DEFAULT_CONFIG.defaultCommitMessage,
    ),
  };
};

const getSessionKey = (ctx: ExtensionContext): string =>
  ctx.sessionManager.getSessionFile() ?? "unknown-session";

const getSessionState = (ctx: ExtensionContext): SessionState => {
  const key = getSessionKey(ctx);
  const cached = stateBySession.get(key);
  if (cached) return cached;
  const next: SessionState = new Map();
  stateBySession.set(key, next);
  return next;
};

const runGit = (
  cwd: string,
  args: string[],
  timeoutMs: number,
): StatusOutput => {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout: timeoutMs,
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
};

const getRepoRoot = (cwd: string, timeoutMs: number): string | null => {
  const result = runGit(cwd, ["rev-parse", "--show-toplevel"], timeoutMs);
  if (result.exitCode !== 0) return null;
  const root = result.stdout.trim();
  return root.length > 0 ? root : null;
};

const repoNameFromRoot = (repoRoot: string): string =>
  repoRoot.split("/").pop() ?? repoRoot;

const normalizeMessage = (value: string | null): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const containsNothingToCommit = (output: string): boolean =>
  output.toLowerCase().includes("nothing to commit");

const formatSummary = (summary: DirtySummary): string =>
  `staged ${summary.staged}, unstaged ${summary.unstaged}, untracked ${summary.untracked}`;

export const computeDirtySummary = (porcelain: string): DirtySummary => {
  const lines = porcelain
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  let staged = 0;
  let unstaged = 0;
  let untracked = 0;

  for (const line of lines) {
    if (line.startsWith("??")) {
      untracked += 1;
      continue;
    }

    const index = line[0];
    const worktree = line[1];
    if (index && index !== " ") staged += 1;
    if (worktree && worktree !== " ") unstaged += 1;
  }

  return {
    staged,
    unstaged,
    untracked,
    dirty: lines.length > 0,
  };
};

export const shouldPromptForDirtyRepo = (input: {
  porcelain: string;
  alreadyPrompted: boolean;
}): PromptDecision => {
  if (input.porcelain.trim().length === 0) {
    return { shouldPrompt: false, nextPrompted: false };
  }

  if (input.alreadyPrompted) {
    return { shouldPrompt: false, nextPrompted: true };
  }

  return { shouldPrompt: true, nextPrompted: true };
};

export const selectCommitMessage = (input: {
  mode: CommitMessageMode;
  hasUI: boolean;
  defaultMessage: string;
  userInput: string | null;
}): CommitMessageSelection => {
  if (input.mode === "auto") {
    return {
      message: input.defaultMessage,
      usedDefault: true,
      cancelled: false,
    };
  }

  const normalizedInput = normalizeMessage(input.userInput);

  if (input.mode === "auto_with_override") {
    if (normalizedInput) {
      return {
        message: normalizedInput,
        usedDefault: false,
        cancelled: false,
      };
    }
    return {
      message: input.defaultMessage,
      usedDefault: true,
      cancelled: false,
    };
  }

  if (!input.hasUI) {
    return {
      message: input.defaultMessage,
      usedDefault: true,
      cancelled: false,
    };
  }

  if (!normalizedInput) {
    return {
      message: null,
      usedDefault: false,
      cancelled: true,
    };
  }

  return {
    message: normalizedInput,
    usedDefault: false,
    cancelled: false,
  };
};

export const runCommitPipeline = async (
  input: CommitPipelineInput,
): Promise<CommitPipelineResult> => {
  if (input.requireConfirm) {
    const confirmed = await input.confirmCommit();
    if (!confirmed) {
      input.notify("Commit cancelled", "info");
      return { committed: false, reason: "cancelled", message: null };
    }
  }

  const addResult = await Promise.resolve(input.runGit(["add", "-A"]));
  if (addResult.exitCode !== 0) {
    const error =
      addResult.stderr.trim() || addResult.stdout.trim() || "git add -A failed";
    input.notify(error, "error");
    return { committed: false, reason: "add_failed", message: null };
  }

  const stagedResult = await Promise.resolve(
    input.runGit(["diff", "--cached", "--name-only"]),
  );
  if (stagedResult.exitCode !== 0) {
    const error =
      stagedResult.stderr.trim() ||
      stagedResult.stdout.trim() ||
      "Failed to inspect staged files";
    input.notify(error, "error");
    return {
      committed: false,
      reason: "staged_check_failed",
      message: null,
    };
  }

  if (stagedResult.stdout.trim().length === 0) {
    input.notify("No staged changes to commit", "info");
    return {
      committed: false,
      reason: "no_staged_changes",
      message: null,
    };
  }

  let userInput: string | null = null;
  if (
    input.hasUI &&
    (input.mode === "auto_with_override" || input.mode === "ask")
  ) {
    userInput = await input.askCommitMessage();
  }

  const selected = selectCommitMessage({
    mode: input.mode,
    hasUI: input.hasUI,
    defaultMessage: input.defaultMessage,
    userInput,
  });

  if (selected.cancelled || !selected.message) {
    input.notify("Commit cancelled (message required)", "info");
    return { committed: false, reason: "cancelled", message: null };
  }

  const commitResult = await Promise.resolve(
    input.runGit(["commit", "-m", selected.message]),
  );

  if (commitResult.exitCode === 0) {
    input.notify(`Committed: ${selected.message}`, "success");
    return {
      committed: true,
      reason: "committed",
      message: selected.message,
    };
  }

  const rawError = commitResult.stderr.trim() || commitResult.stdout.trim();
  if (containsNothingToCommit(rawError)) {
    input.notify("Nothing to commit", "info");
    return {
      committed: false,
      reason: "nothing_to_commit",
      message: null,
    };
  }

  input.notify(rawError || "git commit failed", "error");
  return {
    committed: false,
    reason: "commit_failed",
    message: null,
  };
};

const checkRepoDirty = (
  repoRoot: string,
  timeoutMs: number,
): { porcelain: string; summary: DirtySummary } | null => {
  const result = runGit(repoRoot, ["status", "--porcelain"], timeoutMs);
  if (result.exitCode !== 0) {
    return null;
  }
  return {
    porcelain: result.stdout,
    summary: computeDirtySummary(result.stdout),
  };
};

const runManualCommit = async (
  ctx: ExtensionContext,
  config: DirtyGitStatusConfig,
): Promise<void> => {
  const repoRoot = getRepoRoot(ctx.cwd, config.timeoutMs);
  if (!repoRoot) {
    ctx.ui.notify("Not a git repository", "info");
    return;
  }

  const dirty = checkRepoDirty(repoRoot, config.timeoutMs);
  if (!dirty) {
    ctx.ui.notify("Failed to check git status", "warning");
    return;
  }

  if (!dirty.summary.dirty) {
    ctx.ui.notify("Repository is clean", "info");
    return;
  }

  const repoName = repoNameFromRoot(repoRoot);

  await runCommitPipeline({
    runGit: (args) => runGit(repoRoot, args, config.timeoutMs),
    hasUI: ctx.hasUI,
    confirmCommit: async () => {
      if (!ctx.hasUI) return true;
      return ctx.ui.confirm(
        "Commit now",
        `Dirty repo ${repoName}: ${formatSummary(dirty.summary)}. Commit now?`,
      );
    },
    askCommitMessage: async () => {
      if (!ctx.hasUI) return null;
      return ctx.ui.input(
        "Commit message (empty = default)",
        config.defaultCommitMessage,
      );
    },
    notify: (message, level) => ctx.ui.notify(message, level),
    mode: config.commitMessageMode,
    defaultMessage: config.defaultCommitMessage,
    requireConfirm: ctx.hasUI,
  });
};

const handleSessionCheck = async (
  ctx: ExtensionContext,
  trigger: "session_start" | "session_switch",
): Promise<void> => {
  const config = getSettingsConfig(ctx.cwd);
  if (!config.enabled || !config.checkOnSessionStart) {
    return;
  }

  const repoRoot = getRepoRoot(ctx.cwd, config.timeoutMs);
  if (!repoRoot) {
    return;
  }

  const dirty = checkRepoDirty(repoRoot, config.timeoutMs);
  if (!dirty) {
    ctx.ui.notify("Failed to check git status", "warning");
    log?.warn("git status check failed", { trigger, repoRoot });
    return;
  }

  const sessionState = getSessionState(ctx);
  const repoState = sessionState.get(repoRoot) ?? { prompted: false };
  if (!sessionState.has(repoRoot)) {
    sessionState.set(repoRoot, repoState);
  }

  const decision = shouldPromptForDirtyRepo({
    porcelain: dirty.porcelain,
    alreadyPrompted: repoState.prompted,
  });
  repoState.prompted = decision.nextPrompted;

  if (!decision.shouldPrompt) {
    return;
  }

  if (!ctx.hasUI) {
    log?.info("dirty repo detected but no UI available", {
      trigger,
      repoRoot,
      summary: dirty.summary,
    });
    return;
  }

  const repoName = repoNameFromRoot(repoRoot);

  await runCommitPipeline({
    runGit: (args) => runGit(repoRoot, args, config.timeoutMs),
    hasUI: ctx.hasUI,
    confirmCommit: async () =>
      ctx.ui.confirm(
        "Repository has uncommitted changes",
        `Dirty repo ${repoName}: ${formatSummary(dirty.summary)}. Commit now?`,
      ),
    askCommitMessage: async () =>
      ctx.ui.input(
        "Commit message (empty = default)",
        config.defaultCommitMessage,
      ),
    notify: (message, level) => ctx.ui.notify(message, level),
    mode: config.commitMessageMode,
    defaultMessage: config.defaultCommitMessage,
    requireConfirm: true,
  });
};

export default function dirtyGitStatusExtension(pi: ExtensionAPI) {
  log = createLogger(LOG_NAME, { stderr: null });

  pi.registerCommand(MANUAL_COMMAND, {
    description: "Commit current repo changes now",
    handler: async (_args, ctx) => {
      const config = getSettingsConfig(ctx.cwd);
      if (!config.enabled) {
        ctx.ui.notify("dirty git status is disabled", "info");
        return;
      }
      await runManualCommit(ctx, config);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    void handleSessionCheck(ctx, "session_start");
  });

  pi.on("session_switch", (_event, ctx) => {
    void handleSessionCheck(ctx, "session_switch");
  });
}
