import { spawnSync } from "node:child_process";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { createLogger } from "../shared/logger.ts";
import { loadSettings, updateSettings } from "../shared/settings.ts";

type DirtyGitStatusSettings = {
  enabled?: unknown;
  checkOnSessionStart?: unknown;
  timeoutMs?: unknown;
  promptFrequency?: unknown;
  commitMessageMode?: unknown;
  defaultCommitMessage?: unknown;
  aiDefaultCommitMessage?: unknown;
  aiDefaultCommitMessageIncludeDiff?: unknown;
  aiDefaultCommitMessageTimeoutMs?: unknown;
  aiDefaultCommitMessageMaxDiffChars?: unknown;
  aiDefaultCommitMessageLanguage?: unknown;
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
  aiDefaultCommitMessage: boolean;
  aiDefaultCommitMessageIncludeDiff: boolean;
  aiDefaultCommitMessageTimeoutMs: number;
  aiDefaultCommitMessageMaxDiffChars: number;
  aiDefaultCommitMessageLanguage: string;
};

type RepoState = {
  prompted: boolean;
};

type SessionState = Map<string, RepoState>;

type NotifyLevel = "info" | "warning" | "error";

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
  askCommitMessage: (
    defaultMessage: string,
  ) => Promise<string | null | undefined>;
  notify: (message: string, level: NotifyLevel) => void;
  mode: CommitMessageMode;
  defaultMessage: string;
  requireConfirm: boolean;
  logContext?: {
    trigger?: "session_start" | "session_switch" | "manual";
    repoRoot?: string;
    repoName?: string;
  };
  getDefaultMessage?: (input: {
    stagedFiles: string[];
    defaultMessage: string;
  }) => Promise<string | null>;
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

type LogLevel = "info" | "warn" | "error";

type LogContext = {
  event: string;
  trigger?: "session_start" | "session_switch" | "manual";
  repoRoot?: string;
  repoName?: string;
  summary?: DirtySummary;
  stage?: string;
  result?: string;
  reason?: string;
  details?: Record<string, unknown>;
};

const DEFAULT_CONFIG: DirtyGitStatusConfig = {
  enabled: true,
  checkOnSessionStart: true,
  timeoutMs: 2000,
  promptFrequency: "once_per_dirty_session",
  commitMessageMode: "auto_with_override",
  defaultCommitMessage: "chore: auto-commit workspace changes",
  aiDefaultCommitMessage: false,
  aiDefaultCommitMessageIncludeDiff: false,
  aiDefaultCommitMessageTimeoutMs: 8000,
  aiDefaultCommitMessageMaxDiffChars: 8000,
  aiDefaultCommitMessageLanguage: "en",
};

const LOG_NAME = "dirty-git-status";
const MANUAL_COMMAND = "commit-now";
const TOGGLE_COMMAND = "dirty-git-status-toggle";

type DirtyGitStatusToggleResult = {
  enabled: boolean;
  path: string;
  scope: "global";
};

type UpdateSettingsFn = typeof updateSettings;

export const DEFAULT_COMMIT_MESSAGE = DEFAULT_CONFIG.defaultCommitMessage;

const stateBySession = new Map<string, SessionState>();
const pendingSessionChecks = new Map<
  string,
  "session_start" | "session_switch"
>();

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const getDirtyGitStatusSettings = (
  settings: Record<string, unknown>,
): Record<string, unknown> => {
  const dirtyGitStatus = settings.dirtyGitStatus;
  return isRecord(dirtyGitStatus) ? dirtyGitStatus : {};
};

const getDirtyGitStatusEnabled = (
  settings: Record<string, unknown>,
): boolean => {
  const dirtyGitStatus = getDirtyGitStatusSettings(settings);
  return normalizeBoolean(dirtyGitStatus.enabled, DEFAULT_CONFIG.enabled);
};

const getSettingsConfig = (cwd: string): DirtyGitStatusConfig => {
  const { merged } = loadSettings(cwd);
  const settings = getDirtyGitStatusSettings(merged) as DirtyGitStatusSettings;
  const config = {
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
    aiDefaultCommitMessage: normalizeBoolean(
      settings.aiDefaultCommitMessage,
      DEFAULT_CONFIG.aiDefaultCommitMessage,
    ),
    aiDefaultCommitMessageIncludeDiff: normalizeBoolean(
      settings.aiDefaultCommitMessageIncludeDiff,
      DEFAULT_CONFIG.aiDefaultCommitMessageIncludeDiff,
    ),
    aiDefaultCommitMessageTimeoutMs: normalizeNumber(
      settings.aiDefaultCommitMessageTimeoutMs,
      DEFAULT_CONFIG.aiDefaultCommitMessageTimeoutMs,
    ),
    aiDefaultCommitMessageMaxDiffChars: normalizeNumber(
      settings.aiDefaultCommitMessageMaxDiffChars,
      DEFAULT_CONFIG.aiDefaultCommitMessageMaxDiffChars,
    ),
    aiDefaultCommitMessageLanguage: normalizeString(
      settings.aiDefaultCommitMessageLanguage,
      DEFAULT_CONFIG.aiDefaultCommitMessageLanguage,
    ),
  };

  logInfo({
    event: "dirty git status config loaded",
    details: {
      cwd,
      enabled: config.enabled,
      checkOnSessionStart: config.checkOnSessionStart,
      timeoutMs: config.timeoutMs,
      promptFrequency: config.promptFrequency,
      commitMessageMode: config.commitMessageMode,
      aiDefaultCommitMessage: config.aiDefaultCommitMessage,
      aiDefaultCommitMessageIncludeDiff:
        config.aiDefaultCommitMessageIncludeDiff,
      aiDefaultCommitMessageTimeoutMs: config.aiDefaultCommitMessageTimeoutMs,
      aiDefaultCommitMessageMaxDiffChars:
        config.aiDefaultCommitMessageMaxDiffChars,
      aiDefaultCommitMessageLanguage: config.aiDefaultCommitMessageLanguage,
    },
  });

  return config;
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

const queueSessionCheck = (
  ctx: ExtensionContext,
  trigger: "session_start" | "session_switch",
): void => {
  const sessionKey = getSessionKey(ctx);
  const previousTrigger = pendingSessionChecks.get(sessionKey) ?? null;
  pendingSessionChecks.set(sessionKey, trigger);
  logInfo({
    event: "session check queued",
    trigger,
    stage: "queue",
    result: previousTrigger ? "replaced" : "queued",
    details: {
      sessionKey,
      previousTrigger,
    },
  });
};

const consumeQueuedSessionCheck = (
  ctx: ExtensionContext,
): "session_start" | "session_switch" | null => {
  const key = getSessionKey(ctx);
  const queued = pendingSessionChecks.get(key);
  if (queued) {
    pendingSessionChecks.delete(key);
    logInfo({
      event: "session check dequeued",
      trigger: queued,
      stage: "queue",
      result: "consumed",
      details: {
        sessionKey: key,
      },
    });
    return queued;
  }

  const fallback = Array.from(pendingSessionChecks.entries()).at(-1);
  if (!fallback) return null;
  const [fallbackSessionKey, fallbackTrigger] = fallback;
  pendingSessionChecks.delete(fallbackSessionKey);
  logWarn({
    event: "session check dequeued",
    trigger: fallbackTrigger,
    stage: "queue",
    result: "consumed_fallback",
    details: {
      sessionKey: key,
      fallbackSessionKey,
    },
  });
  return fallbackTrigger;
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

const normalizeMessage = (value: string | null | undefined): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const toLines = (value: string): string[] =>
  value
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

const containsNothingToCommit = (output: string): boolean =>
  output.toLowerCase().includes("nothing to commit");

const formatSummary = (summary: DirtySummary): string =>
  `staged ${summary.staged}, unstaged ${summary.unstaged}, untracked ${summary.untracked}`;

const MAX_LOG_TEXT = 200;
const UI_INTERACTION_TIMEOUT_MS = 60_000;

const summarizeText = (value: string, max = MAX_LOG_TEXT): string | null => {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max).trimEnd()}…`;
};

const withTimeout = <T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });

const buildGitDetails = (result: StatusOutput): Record<string, unknown> => {
  const stdout = summarizeText(result.stdout);
  const stderr = summarizeText(result.stderr);
  const details: Record<string, unknown> = { exitCode: result.exitCode };
  if (stdout) details.stdout = stdout;
  if (stderr) details.stderr = stderr;
  return details;
};

const logEvent = (level: LogLevel, context: LogContext): void => {
  if (!log) return;
  const { event, details, ...rest } = context;
  const payload = details ? { ...rest, details } : rest;
  if (level === "info") {
    log.info(event, payload);
  } else if (level === "warn") {
    log.warn(event, payload);
  } else {
    log.error(event, payload);
  }
};

const logInfo = (context: LogContext): void => logEvent("info", context);

const logWarn = (context: LogContext): void => logEvent("warn", context);

const logError = (context: LogContext): void => logEvent("error", context);

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

function getPromptDecisionReason(input: {
  dirty: boolean;
  alreadyPrompted: boolean;
}): "clean" | "dirty" | "already_prompted" {
  if (!input.dirty) return "clean";
  if (input.alreadyPrompted) return "already_prompted";
  return "dirty";
}

export const selectCommitMessage = (input: {
  mode: CommitMessageMode;
  hasUI: boolean;
  defaultMessage: string;
  userInput: string | null | undefined;
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
  const baseContext = input.logContext ?? {};

  logInfo({ event: "commit pipeline start", stage: "start", ...baseContext });

  if (input.requireConfirm) {
    logInfo({
      event: "commit confirmation requested",
      stage: "confirm",
      result: "requested",
      ...baseContext,
    });

    let confirmed: boolean;
    try {
      confirmed = await withTimeout(
        Promise.resolve(input.confirmCommit()),
        UI_INTERACTION_TIMEOUT_MS,
        "commit confirmation",
      );
    } catch (error) {
      logWarn({
        event: "commit confirmation failed",
        stage: "confirm",
        result: "failed",
        details: { error: summarizeText(String(error)) },
        ...baseContext,
      });
      input.notify("Failed to open commit confirmation prompt", "warning");
      return { committed: false, reason: "cancelled", message: null };
    }

    logInfo({
      event: "commit confirmation",
      stage: "confirm",
      result: confirmed ? "confirmed" : "cancelled",
      ...baseContext,
    });
    if (!confirmed) {
      input.notify("Commit cancelled", "info");
      return { committed: false, reason: "cancelled", message: null };
    }
  }

  const addResult = await Promise.resolve(input.runGit(["add", "-A"]));
  if (addResult.exitCode !== 0) {
    const error =
      addResult.stderr.trim() || addResult.stdout.trim() || "git add -A failed";
    logError({
      event: "git add failed",
      stage: "add",
      result: "failed",
      details: buildGitDetails(addResult),
      ...baseContext,
    });
    input.notify(error, "error");
    return { committed: false, reason: "add_failed", message: null };
  }
  logInfo({
    event: "git add completed",
    stage: "add",
    result: "ok",
    details: { exitCode: addResult.exitCode },
    ...baseContext,
  });

  const stagedResult = await Promise.resolve(
    input.runGit(["diff", "--cached", "--name-only"]),
  );
  if (stagedResult.exitCode !== 0) {
    const error =
      stagedResult.stderr.trim() ||
      stagedResult.stdout.trim() ||
      "Failed to inspect staged files";
    logError({
      event: "staged files check failed",
      stage: "staged_check",
      result: "failed",
      details: buildGitDetails(stagedResult),
      ...baseContext,
    });
    input.notify(error, "error");
    return {
      committed: false,
      reason: "staged_check_failed",
      message: null,
    };
  }

  if (stagedResult.stdout.trim().length === 0) {
    logInfo({
      event: "no staged changes",
      stage: "staged_check",
      result: "empty",
      details: { exitCode: stagedResult.exitCode },
      ...baseContext,
    });
    input.notify("No staged changes to commit", "info");
    return {
      committed: false,
      reason: "no_staged_changes",
      message: null,
    };
  }

  const stagedFiles = toLines(stagedResult.stdout);
  logInfo({
    event: "staged files detected",
    stage: "staged_check",
    result: "ok",
    details: { count: stagedFiles.length },
    ...baseContext,
  });

  let effectiveDefaultMessage = input.defaultMessage;
  let defaultMessageSource = "configured";
  if (input.getDefaultMessage) {
    try {
      const generated = await input.getDefaultMessage({
        stagedFiles,
        defaultMessage: input.defaultMessage,
      });
      const normalized = normalizeMessage(generated);
      if (normalized) {
        effectiveDefaultMessage = normalized;
        defaultMessageSource = "generated";
      }
    } catch (error) {
      logWarn({
        event: "default commit message generation failed",
        stage: "default_message",
        result: "failed",
        details: { error: summarizeText(String(error)) },
        ...baseContext,
      });
    }
  }

  logInfo({
    event: "default commit message resolved",
    stage: "default_message",
    result: defaultMessageSource,
    details: { message: summarizeText(effectiveDefaultMessage, 120) },
    ...baseContext,
  });

  let userInput: string | null | undefined = null;
  if (
    input.hasUI &&
    (input.mode === "auto_with_override" || input.mode === "ask")
  ) {
    try {
      userInput = await withTimeout(
        Promise.resolve(input.askCommitMessage(effectiveDefaultMessage)),
        UI_INTERACTION_TIMEOUT_MS,
        "commit message input",
      );
    } catch (error) {
      logWarn({
        event: "commit message input failed",
        stage: "message_input",
        result: "failed",
        details: { error: summarizeText(String(error)) },
        ...baseContext,
      });
      userInput = null;
    }
  }

  logInfo({
    event: "commit message input collected",
    stage: "message_input",
    result: normalizeMessage(userInput) ? "provided" : "empty",
    ...baseContext,
  });

  const selected = selectCommitMessage({
    mode: input.mode,
    hasUI: input.hasUI,
    defaultMessage: effectiveDefaultMessage,
    userInput,
  });

  logInfo({
    event: "commit message selected",
    stage: "message_select",
    result: selected.cancelled ? "cancelled" : "ok",
    details: {
      usedDefault: selected.usedDefault,
      message: summarizeText(selected.message ?? "", 120),
    },
    ...baseContext,
  });

  if (selected.cancelled || !selected.message) {
    input.notify("Commit cancelled (message required)", "info");
    return { committed: false, reason: "cancelled", message: null };
  }

  const commitResult = await Promise.resolve(
    input.runGit(["commit", "-m", selected.message]),
  );

  if (commitResult.exitCode === 0) {
    logInfo({
      event: "git commit succeeded",
      stage: "commit",
      result: "ok",
      details: { message: summarizeText(selected.message, 120) },
      ...baseContext,
    });
    input.notify(`Committed: ${selected.message}`, "info");
    return {
      committed: true,
      reason: "committed",
      message: selected.message,
    };
  }

  const rawError = commitResult.stderr.trim() || commitResult.stdout.trim();
  if (containsNothingToCommit(rawError)) {
    logInfo({
      event: "git commit skipped",
      stage: "commit",
      result: "nothing_to_commit",
      details: buildGitDetails(commitResult),
      ...baseContext,
    });
    input.notify("Nothing to commit", "info");
    return {
      committed: false,
      reason: "nothing_to_commit",
      message: null,
    };
  }

  logError({
    event: "git commit failed",
    stage: "commit",
    result: "failed",
    details: buildGitDetails(commitResult),
    ...baseContext,
  });
  input.notify(rawError || "git commit failed", "error");
  return {
    committed: false,
    reason: "commit_failed",
    message: null,
  };
};

const AI_COMMIT_SYSTEM_PROMPT = `You are an expert software engineer writing git commit messages.

Generate a single-line commit message describing the staged changes.

Rules:
- Output ONLY the commit message line, no quotes, no markdown, no extra commentary.
- Use Conventional Commits format: <type>(optional-scope): <description>
- Keep it concise (ideally <= 72 chars), imperative mood.
- If uncertain, prefer "chore:".
- Use the requested language when provided.`;

const stripCodeFences = (text: string): string => {
  const match = text.match(/```(?:\w+)?\s*([\s\S]*?)```/);
  return match ? (match[1] ?? "").trim() : text;
};

const parseAiCommitMessage = (raw: string): string | null => {
  const cleaned = stripCodeFences(raw).trim();
  const firstLine = cleaned.split(/\r?\n/).find((l) => l.trim().length > 0);
  if (!firstLine) return null;

  let msg = firstLine.trim();
  msg = msg
    .replace(/^["'`]+/, "")
    .replace(/["'`]+$/, "")
    .trim();
  if (msg.length === 0) return null;
  if (msg.length > 120) msg = `${msg.slice(0, 120).trimEnd()}…`;
  return msg;
};

const buildAiCommitUserPrompt = (input: {
  stagedFiles: string[];
  diffStat: string;
  diffPatch?: string;
  language: string;
}): string => {
  const files =
    input.stagedFiles.length > 0
      ? input.stagedFiles.map((f) => `- ${f}`).join("\n")
      : "(unknown)";

  const parts: string[] = [];
  parts.push(`Language: ${input.language}`);
  parts.push("");
  parts.push("Staged files:");
  parts.push(files);
  parts.push("");
  parts.push("Diff stat:");
  parts.push(input.diffStat.trim() || "(empty)");
  if (input.diffPatch && input.diffPatch.trim().length > 0) {
    parts.push("");
    parts.push("Diff (patch):");
    parts.push(input.diffPatch);
  }
  return parts.join("\n");
};

const generateAiDefaultCommitMessage = async (input: {
  ctx: ExtensionContext;
  stagedFiles: string[];
  language: string;
  timeoutMs: number;
  diffStat: string;
  diffPatch?: string;
}): Promise<string | null> => {
  const model = input.ctx.model;
  if (!model) return null;

  let mod: unknown;
  try {
    mod = await import("@mariozechner/pi-ai");
  } catch {
    return null;
  }

  if (!isRecord(mod) || typeof mod.complete !== "function") {
    return null;
  }

  const complete = mod.complete as (
    model: unknown,
    request: {
      systemPrompt: string;
      messages: Array<{
        role: "user";
        content: Array<{ type: "text"; text: string }>;
        timestamp: number;
      }>;
    },
    options: {
      apiKey?: string;
      headers?: Record<string, string>;
      signal?: AbortSignal;
      reasoningEffort?: "low" | "medium" | "high";
    },
  ) => Promise<unknown>;

  const auth = await input.ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const prompt = buildAiCommitUserPrompt({
      stagedFiles: input.stagedFiles,
      diffStat: input.diffStat,
      diffPatch: input.diffPatch,
      language: input.language,
    });

    const response = await complete(
      model,
      {
        systemPrompt: AI_COMMIT_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: prompt }],
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        signal: controller.signal,
        reasoningEffort:
          typeof model === "object" &&
          model &&
          "reasoning" in model &&
          (model as unknown as Record<string, unknown>).reasoning
            ? "low"
            : undefined,
      },
    );

    if (!isRecord(response)) return null;
    const content = response.content;
    if (!Array.isArray(content)) return null;
    const text = content
      .filter(
        (c): c is { type: "text"; text: string } =>
          Boolean(c) &&
          typeof c === "object" &&
          "type" in c &&
          (c as { type?: unknown }).type === "text" &&
          "text" in c &&
          typeof (c as { text?: unknown }).text === "string",
      )
      .map((c) => c.text)
      .join("\n");

    return parseAiCommitMessage(text);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
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

function createRepoGitRunner(
  repoRoot: string,
  timeoutMs: number,
): (args: string[]) => StatusOutput {
  return function runRepoGit(args: string[]): StatusOutput {
    return runGit(repoRoot, args, timeoutMs);
  };
}

function getAiCommitDiffDetails(input: {
  runRepoGit: (args: string[]) => StatusOutput;
  config: DirtyGitStatusConfig;
}): { diffStat: string; diffPatch?: string } {
  const diffStatResult = input.runRepoGit([
    "diff",
    "--cached",
    "--stat",
    "--no-color",
  ]);
  const diffStat = diffStatResult.exitCode === 0 ? diffStatResult.stdout : "";

  let diffPatch: string | undefined;
  if (input.config.aiDefaultCommitMessageIncludeDiff) {
    const patchResult = input.runRepoGit(["diff", "--cached", "--no-color"]);
    if (patchResult.exitCode === 0) {
      diffPatch = patchResult.stdout.slice(
        0,
        Math.max(0, input.config.aiDefaultCommitMessageMaxDiffChars),
      );
    }
  }

  return { diffStat, diffPatch };
}

function buildDefaultMessageProvider(input: {
  ctx: ExtensionContext;
  config: DirtyGitStatusConfig;
  runRepoGit: (args: string[]) => StatusOutput;
}): CommitPipelineInput["getDefaultMessage"] | undefined {
  if (!input.config.aiDefaultCommitMessage) {
    return undefined;
  }

  return async ({ stagedFiles, defaultMessage }) => {
    if (!input.ctx.model) return null;

    const { diffStat, diffPatch } = getAiCommitDiffDetails({
      runRepoGit: input.runRepoGit,
      config: input.config,
    });

    const generated = await generateAiDefaultCommitMessage({
      ctx: input.ctx,
      stagedFiles,
      language: input.config.aiDefaultCommitMessageLanguage,
      timeoutMs: input.config.aiDefaultCommitMessageTimeoutMs,
      diffStat,
      diffPatch,
    });

    return generated ?? defaultMessage;
  };
}

function buildCommitPipelineInput(input: {
  ctx: ExtensionContext;
  config: DirtyGitStatusConfig;
  trigger: "session_start" | "session_switch" | "manual";
  repoRoot: string;
  repoName: string;
  summary: DirtySummary;
  confirmTitle: string;
  requireConfirm: boolean;
}): CommitPipelineInput {
  const runRepoGit = createRepoGitRunner(
    input.repoRoot,
    input.config.timeoutMs,
  );
  const confirmMessage = `Dirty repo ${input.repoName}: ${formatSummary(input.summary)}. Commit now?`;

  return {
    runGit: runRepoGit,
    hasUI: input.ctx.hasUI,
    confirmCommit: async () => {
      if (!input.ctx.hasUI) return true;
      return input.ctx.ui.confirm(input.confirmTitle, confirmMessage);
    },
    askCommitMessage: async (defaultMessage) => {
      if (!input.ctx.hasUI) return null;
      return input.ctx.ui.input(
        "Commit message (empty = default)",
        defaultMessage,
      );
    },
    notify: (message, level) => input.ctx.ui.notify(message, level),
    mode: input.config.commitMessageMode,
    defaultMessage: input.config.defaultCommitMessage,
    requireConfirm: input.requireConfirm,
    logContext: {
      trigger: input.trigger,
      repoRoot: input.repoRoot,
      repoName: input.repoName,
    },
    getDefaultMessage: buildDefaultMessageProvider({
      ctx: input.ctx,
      config: input.config,
      runRepoGit,
    }),
  };
}

function getOrCreateRepoState(
  sessionState: SessionState,
  repoRoot: string,
): RepoState {
  const existing = sessionState.get(repoRoot);
  if (existing) return existing;

  const next: RepoState = { prompted: false };
  sessionState.set(repoRoot, next);
  return next;
}

const runManualCommit = async (
  ctx: ExtensionContext,
  config: DirtyGitStatusConfig,
): Promise<void> => {
  const trigger = "manual" as const;
  logInfo({
    event: "manual commit requested",
    trigger,
    details: { cwd: ctx.cwd },
  });

  const repoRoot = getRepoRoot(ctx.cwd, config.timeoutMs);
  if (!repoRoot) {
    logInfo({
      event: "repo root not found",
      trigger,
      result: "missing",
      details: { cwd: ctx.cwd },
    });
    ctx.ui.notify("Not a git repository", "info");
    return;
  }

  const repoName = repoNameFromRoot(repoRoot);
  logInfo({ event: "repo root resolved", trigger, repoRoot, repoName });

  const dirty = checkRepoDirty(repoRoot, config.timeoutMs);
  if (!dirty) {
    logWarn({
      event: "git status check failed",
      trigger,
      repoRoot,
      repoName,
    });
    ctx.ui.notify("Failed to check git status", "warning");
    return;
  }

  logInfo({
    event: "git status checked",
    trigger,
    repoRoot,
    repoName,
    stage: "dirty_check",
    summary: dirty.summary,
  });

  if (!dirty.summary.dirty) {
    logInfo({
      event: "repository clean",
      trigger,
      repoRoot,
      repoName,
      summary: dirty.summary,
    });
    ctx.ui.notify("Repository is clean", "info");
    return;
  }

  const pipelineResult = await runCommitPipeline(
    buildCommitPipelineInput({
      ctx,
      config,
      trigger,
      repoRoot,
      repoName,
      summary: dirty.summary,
      confirmTitle: "Commit now",
      requireConfirm: ctx.hasUI,
    }),
  );

  logInfo({
    event: "manual commit pipeline finished",
    trigger,
    repoRoot,
    repoName,
    result: pipelineResult.committed ? "committed" : "skipped",
    reason: pipelineResult.reason,
    details: { message: summarizeText(pipelineResult.message ?? "", 120) },
  });
};

export const toggleDirtyGitStatus = (
  cwd: string,
  update: UpdateSettingsFn = updateSettings,
): DirtyGitStatusToggleResult => {
  const result = update(cwd, "global", (settings) => {
    const dirtyGitStatus = getDirtyGitStatusSettings(settings);
    return {
      ...settings,
      dirtyGitStatus: {
        ...dirtyGitStatus,
        enabled: !getDirtyGitStatusEnabled(settings),
      },
    };
  });

  return {
    enabled: getDirtyGitStatusEnabled(result.settings),
    path: result.path,
    scope: "global",
  };
};

export const formatDirtyGitStatusToggleMessage = (
  result: DirtyGitStatusToggleResult,
): string =>
  `Dirty git status ${result.enabled ? "enabled" : "disabled"} globally. Updated ${result.path}`;

const handleSessionCheck = async (
  ctx: ExtensionContext,
  trigger: "session_start" | "session_switch",
): Promise<void> => {
  logInfo({
    event: "session check start",
    trigger,
    details: { cwd: ctx.cwd },
  });

  const config = getSettingsConfig(ctx.cwd);
  if (!config.enabled || !config.checkOnSessionStart) {
    logInfo({
      event: "session check skipped",
      trigger,
      result: "disabled",
      details: {
        enabled: config.enabled,
        checkOnSessionStart: config.checkOnSessionStart,
      },
    });
    return;
  }

  const repoRoot = getRepoRoot(ctx.cwd, config.timeoutMs);
  if (!repoRoot) {
    logInfo({
      event: "repo root not found",
      trigger,
      result: "missing",
      details: { cwd: ctx.cwd },
    });
    return;
  }

  const repoName = repoNameFromRoot(repoRoot);
  logInfo({ event: "repo root resolved", trigger, repoRoot, repoName });

  const dirty = checkRepoDirty(repoRoot, config.timeoutMs);
  if (!dirty) {
    ctx.ui.notify("Failed to check git status", "warning");
    logWarn({
      event: "git status check failed",
      trigger,
      repoRoot,
      repoName,
    });
    return;
  }

  logInfo({
    event: "git status checked",
    trigger,
    repoRoot,
    repoName,
    stage: "dirty_check",
    summary: dirty.summary,
  });

  const sessionState = getSessionState(ctx);
  const repoState = getOrCreateRepoState(sessionState, repoRoot);

  const alreadyPrompted = repoState.prompted;
  const decision = shouldPromptForDirtyRepo({
    porcelain: dirty.porcelain,
    alreadyPrompted,
  });

  const decisionReason = getPromptDecisionReason({
    dirty: dirty.summary.dirty,
    alreadyPrompted,
  });

  logInfo({
    event: "prompt decision evaluated",
    trigger,
    repoRoot,
    repoName,
    stage: "prompt_decision",
    summary: dirty.summary,
    details: {
      alreadyPrompted,
      shouldPrompt: decision.shouldPrompt,
      nextPrompted: decision.nextPrompted,
      reason: decisionReason,
    },
  });

  if (!decision.shouldPrompt) {
    repoState.prompted = decision.nextPrompted;
    logInfo({
      event: "prompt skipped",
      trigger,
      repoRoot,
      repoName,
      result: "skip",
      reason: decisionReason,
    });
    return;
  }

  if (!ctx.hasUI) {
    repoState.prompted = false;
    logInfo({
      event: "prompt skipped (no UI)",
      trigger,
      repoRoot,
      repoName,
      summary: dirty.summary,
      result: "no_ui",
    });
    return;
  }

  let pipelineResult: CommitPipelineResult;
  try {
    pipelineResult = await runCommitPipeline(
      buildCommitPipelineInput({
        ctx,
        config,
        trigger,
        repoRoot,
        repoName,
        summary: dirty.summary,
        confirmTitle: "Repository has uncommitted changes",
        requireConfirm: true,
      }),
    );
  } catch (error) {
    repoState.prompted = false;
    logError({
      event: "session commit pipeline crashed",
      trigger,
      repoRoot,
      repoName,
      result: "failed",
      details: { error: summarizeText(String(error)) },
    });
    ctx.ui.notify("Failed to run commit prompt", "warning");
    return;
  }

  repoState.prompted = true;

  logInfo({
    event: "session commit pipeline finished",
    trigger,
    repoRoot,
    repoName,
    result: pipelineResult.committed ? "committed" : "skipped",
    reason: pipelineResult.reason,
    details: { message: summarizeText(pipelineResult.message ?? "", 120) },
  });
};

export default function dirtyGitStatusExtension(pi: ExtensionAPI) {
  log = createLogger(LOG_NAME, { stderr: null });

  pi.registerCommand(TOGGLE_COMMAND, {
    description: "Toggle dirty git status globally",
    handler: async (_args, ctx) => {
      const result = toggleDirtyGitStatus(ctx.cwd);
      ctx.ui.notify(formatDirtyGitStatusToggleMessage(result), "info");
    },
  });

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
    queueSessionCheck(ctx, "session_start");
  });

  pi.on("session_switch", (_event, ctx) => {
    queueSessionCheck(ctx, "session_switch");
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };
    const queuedTrigger = consumeQueuedSessionCheck(ctx);
    if (!queuedTrigger) return { action: "continue" };
    logInfo({
      event: "session check execution requested",
      trigger: queuedTrigger,
      stage: "queue",
      result: "input",
    });
    await handleSessionCheck(ctx, queuedTrigger);
    return { action: "continue" };
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    const queuedTrigger = consumeQueuedSessionCheck(ctx);
    if (!queuedTrigger) return {};
    logInfo({
      event: "session check execution requested",
      trigger: queuedTrigger,
      stage: "queue",
      result: "before_agent_start",
    });
    await handleSessionCheck(ctx, queuedTrigger);
    return {};
  });
}
