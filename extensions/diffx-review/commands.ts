import path from "node:path";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";

import { getRepoRoot } from "../shared/git.ts";
import { getCommentStats, getComments } from "./client.ts";
import { loadDiffxReviewConfig } from "./config.ts";
import {
  buildFinishReviewPrompt,
  buildNoSessionMessage,
  buildStatusMessage,
  filterComments,
  parseFinishReviewArgs,
  parseStartReviewArgs,
} from "./helpers.ts";
import {
  clearDiffxReviewSession,
  getDiffxReviewSession,
  markSessionHealth,
  startDiffxReviewSession,
  stopDiffxReviewSession,
} from "./runtime.ts";
import type { DiffxReviewComment, DiffxReviewSession } from "./types.ts";

const getRepoRootOrNotify = (ctx: ExtensionCommandContext): string | null => {
  const repoRoot = getRepoRoot(ctx.cwd);
  if (!repoRoot) {
    ctx.ui.notify("diffx-review requires a git repository", "error");
    return null;
  }
  return repoRoot;
};

const getConfigOrNotify = (
  ctx: ExtensionCommandContext,
  repoRoot: string,
): ReturnType<typeof loadDiffxReviewConfig> | null => {
  const config = loadDiffxReviewConfig(repoRoot);
  if (!config.enabled) {
    ctx.ui.notify("diffx-review is disabled in settings", "warning");
    return null;
  }

  return config;
};

const getHealthySession = async (
  repoRoot: string,
  timeoutMs: number,
): Promise<{
  session: DiffxReviewSession | null;
  comments: DiffxReviewComment[] | null;
  error: string | null;
}> => {
  const active = getDiffxReviewSession(repoRoot);
  if (!active) {
    return {
      session: null,
      comments: null,
      error: null,
    };
  }

  try {
    const comments = await getComments(active, timeoutMs);
    const session = markSessionHealth(repoRoot, true);
    return {
      session: session ?? active,
      comments,
      error: null,
    };
  } catch (error) {
    markSessionHealth(repoRoot, false);
    clearDiffxReviewSession(repoRoot);
    return {
      session: null,
      comments: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const notifyActiveStatus = (
  ctx: ExtensionCommandContext,
  session: DiffxReviewSession,
  comments: DiffxReviewComment[],
  healthy: boolean,
) => {
  const stats = getCommentStats(comments);
  ctx.ui.notify(buildStatusMessage({ session, stats, healthy }), "info");
};

const handleStartReview = async (
  pi: ExtensionAPI,
  rawArgs: string,
  ctx: ExtensionCommandContext,
): Promise<void> => {
  const repoRoot = getRepoRootOrNotify(ctx);
  if (!repoRoot) {
    return;
  }

  const parsed = parseStartReviewArgs(rawArgs);
  if (!parsed.value) {
    ctx.ui.notify(parsed.error ?? "Invalid arguments", "error");
    return;
  }

  const config = getConfigOrNotify(ctx, repoRoot);
  if (!config) {
    return;
  }

  const existing = await getHealthySession(
    repoRoot,
    config.healthcheckTimeoutMs,
  );
  if (existing.session && existing.comments) {
    if (config.reuseExistingSession) {
      notifyActiveStatus(ctx, existing.session, existing.comments, true);
      return;
    }

    await stopDiffxReviewSession(repoRoot);
    ctx.ui.notify(
      "Stopped existing diffx session before starting a fresh one",
      "info",
    );
  } else if (existing.error) {
    ctx.ui.notify(
      `Removed stale diffx session and starting a new one: ${existing.error}`,
      "warning",
    );
  }

  const startInput = {
    repoRoot,
    diffxCommand: config.diffxCommand,
    diffxPath: config.diffxPath,
    host: parsed.value.host ?? config.host,
    port: parsed.value.port ?? config.defaultPort,
    openInBrowser: parsed.value.noOpen ? false : config.autoOpen,
    diffArgs: parsed.value.diffArgs,
    startupTimeoutMs: config.startupTimeoutMs,
  };

  const notifyStarted = (session: DiffxReviewSession) => {
    ctx.ui.notify(
      `Started diffx review for ${path.basename(repoRoot)} at ${session.url}`,
      "info",
    );
    pi.sendMessage(
      {
        customType: "diffx-review",
        content: `diffx review started: ${session.url}`,
        display: true,
        details: {
          repoRoot,
          url: session.url,
          diffArgs: session.diffArgs,
        },
      },
      { deliverAs: "nextTurn" },
    );
  };

  try {
    const session = await startDiffxReviewSession(startInput);
    notifyStarted(session);
  } catch (error) {
    ctx.ui.notify(
      `Failed to start diffx review: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
};

const handleReviewStatus = async (
  ctx: ExtensionCommandContext,
): Promise<void> => {
  const repoRoot = getRepoRootOrNotify(ctx);
  if (!repoRoot) {
    return;
  }

  const config = loadDiffxReviewConfig(repoRoot);
  const active = await getHealthySession(repoRoot, config.healthcheckTimeoutMs);
  if (!active.session || !active.comments) {
    ctx.ui.notify(buildNoSessionMessage(repoRoot), "info");
    return;
  }

  notifyActiveStatus(ctx, active.session, active.comments, true);
};

const handleFinishReview = async (
  pi: ExtensionAPI,
  rawArgs: string,
  ctx: ExtensionCommandContext,
): Promise<void> => {
  const repoRoot = getRepoRootOrNotify(ctx);
  if (!repoRoot) {
    return;
  }

  const parsed = parseFinishReviewArgs(rawArgs);
  if (!parsed.value) {
    ctx.ui.notify(parsed.error ?? "Invalid arguments", "error");
    return;
  }

  const config = loadDiffxReviewConfig(repoRoot);
  const active = await getHealthySession(repoRoot, config.healthcheckTimeoutMs);
  if (!active.session || !active.comments) {
    ctx.ui.notify(buildNoSessionMessage(repoRoot), "info");
    return;
  }

  const openComments = filterComments(active.comments, "open");
  if (openComments.length === 0) {
    ctx.ui.notify("No open diffx review comments found", "info");
    return;
  }

  const prompt = buildFinishReviewPrompt({
    repoRoot,
    session: active.session,
    comments: openComments,
    resolveAfterReply: parsed.value.resolveAfterReply,
  });

  pi.sendUserMessage(prompt);
  ctx.ui.notify(
    `Queued ${openComments.length} diffx review comment(s) for the agent`,
    "info",
  );
};

const handleStopReview = async (
  ctx: ExtensionCommandContext,
): Promise<void> => {
  const repoRoot = getRepoRootOrNotify(ctx);
  if (!repoRoot) {
    return;
  }

  const result = await stopDiffxReviewSession(repoRoot);
  if (!result.stopped) {
    ctx.ui.notify(buildNoSessionMessage(repoRoot), "info");
    return;
  }

  ctx.ui.notify(
    `Stopped diffx review for ${path.basename(repoRoot)} (${result.reason})`,
    "info",
  );
};

export const registerDiffxReviewCommands = (pi: ExtensionAPI): void => {
  pi.registerCommand("diffx-start-review", {
    description:
      "Start or reuse a diffx review session for the current git repository",
    handler: async (args, ctx) => {
      await handleStartReview(pi, args, ctx);
    },
  });

  pi.registerCommand("diffx-review-status", {
    description: "Show diffx review status for the current repository",
    handler: async (_args, ctx) => {
      await handleReviewStatus(ctx);
    },
  });

  pi.registerCommand("diffx-finish-review", {
    description:
      "Load open diffx review comments into the current agent session",
    handler: async (args, ctx) => {
      await handleFinishReview(pi, args, ctx);
    },
  });

  pi.registerCommand("diffx-stop-review", {
    description: "Stop the active diffx review session for the current repo",
    handler: async (_args, ctx) => {
      await handleStopReview(ctx);
    },
  });
};
