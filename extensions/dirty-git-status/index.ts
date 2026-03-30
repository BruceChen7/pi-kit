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
  askCommitMessage: (defaultMessage: string) => Promise<string | null>;
  notify: (message: string, level: NotifyLevel) => void;
  mode: CommitMessageMode;
  defaultMessage: string;
  requireConfirm: boolean;
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

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

const toLines = (value: string): string[] =>
  value
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

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

  const stagedFiles = toLines(stagedResult.stdout);

  let effectiveDefaultMessage = input.defaultMessage;
  if (input.getDefaultMessage) {
    try {
      const generated = await input.getDefaultMessage({
        stagedFiles,
        defaultMessage: input.defaultMessage,
      });
      const normalized = normalizeMessage(generated);
      if (normalized) {
        effectiveDefaultMessage = normalized;
      }
    } catch {
      // fallback silently to configured default message
    }
  }

  let userInput: string | null = null;
  if (
    input.hasUI &&
    (input.mode === "auto_with_override" || input.mode === "ask")
  ) {
    userInput = await input.askCommitMessage(effectiveDefaultMessage);
  }

  const selected = selectCommitMessage({
    mode: input.mode,
    hasUI: input.hasUI,
    defaultMessage: effectiveDefaultMessage,
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
          (model as Record<string, unknown>).reasoning
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
    askCommitMessage: async (defaultMessage) => {
      if (!ctx.hasUI) return null;
      return ctx.ui.input("Commit message (empty = default)", defaultMessage);
    },
    notify: (message, level) => ctx.ui.notify(message, level),
    mode: config.commitMessageMode,
    defaultMessage: config.defaultCommitMessage,
    requireConfirm: ctx.hasUI,
    getDefaultMessage: config.aiDefaultCommitMessage
      ? async ({ stagedFiles, defaultMessage }) => {
          if (!ctx.model) return null;

          const diffStatResult = runGit(
            repoRoot,
            ["diff", "--cached", "--stat", "--no-color"],
            config.timeoutMs,
          );
          const diffStat =
            diffStatResult.exitCode === 0 ? diffStatResult.stdout : "";

          let diffPatch: string | undefined;
          if (config.aiDefaultCommitMessageIncludeDiff) {
            const patchResult = runGit(
              repoRoot,
              ["diff", "--cached", "--no-color"],
              config.timeoutMs,
            );
            if (patchResult.exitCode === 0) {
              diffPatch = patchResult.stdout.slice(
                0,
                Math.max(0, config.aiDefaultCommitMessageMaxDiffChars),
              );
            }
          }

          const generated = await generateAiDefaultCommitMessage({
            ctx,
            stagedFiles,
            language: config.aiDefaultCommitMessageLanguage,
            timeoutMs: config.aiDefaultCommitMessageTimeoutMs,
            diffStat,
            diffPatch,
          });
          return generated ?? defaultMessage;
        }
      : undefined,
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
    askCommitMessage: async (defaultMessage) =>
      ctx.ui.input("Commit message (empty = default)", defaultMessage),
    notify: (message, level) => ctx.ui.notify(message, level),
    mode: config.commitMessageMode,
    defaultMessage: config.defaultCommitMessage,
    requireConfirm: true,
    getDefaultMessage: config.aiDefaultCommitMessage
      ? async ({ stagedFiles, defaultMessage }) => {
          if (!ctx.model) return null;

          const diffStatResult = runGit(
            repoRoot,
            ["diff", "--cached", "--stat", "--no-color"],
            config.timeoutMs,
          );
          const diffStat =
            diffStatResult.exitCode === 0 ? diffStatResult.stdout : "";

          let diffPatch: string | undefined;
          if (config.aiDefaultCommitMessageIncludeDiff) {
            const patchResult = runGit(
              repoRoot,
              ["diff", "--cached", "--no-color"],
              config.timeoutMs,
            );
            if (patchResult.exitCode === 0) {
              diffPatch = patchResult.stdout.slice(
                0,
                Math.max(0, config.aiDefaultCommitMessageMaxDiffChars),
              );
            }
          }

          const generated = await generateAiDefaultCommitMessage({
            ctx,
            stagedFiles,
            language: config.aiDefaultCommitMessageLanguage,
            timeoutMs: config.aiDefaultCommitMessageTimeoutMs,
            diffStat,
            diffPatch,
          });
          return generated ?? defaultMessage;
        }
      : undefined,
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
