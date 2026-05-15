import fs from "node:fs";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  checkRepoDirty,
  DEFAULT_GIT_TIMEOUT_MS,
  getRepoRoot,
} from "../shared/git.ts";
import { createLogger } from "../shared/logger.ts";
import {
  runPlannotatorAnnotateCli,
  runPlannotatorCodeReviewCli,
} from "./cli.ts";
import { isCodeReviewAutoTriggerEnabled } from "./config.ts";
import { extractBashPathCandidates, resolveToolPath } from "./helpers.ts";
import {
  isHtmlPath,
  isPathWithinCwd,
  isReviewDocumentPath,
  toRepoRelativePath,
} from "./paths.ts";
import { isPlanReviewSettled, setReviewWidget } from "./plan-review.ts";
import type { SessionReviewDocument, SessionRuntimeState } from "./session.ts";
import {
  getSessionContextByKey,
  getSessionKey,
  getSessionState,
} from "./session.ts";

const DEFAULT_CODE_REVIEW_RETRY_DELAY_MS = 1_000;
const SYNC_ANNOTATE_TIMEOUT_MS = 4 * 60 * 60 * 1_000;
const SYNC_CODE_REVIEW_TIMEOUT_MS = SYNC_ANNOTATE_TIMEOUT_MS;
const MANUAL_CODE_REVIEW_COMMAND = "plannotator-review";
const MANUAL_CODE_REVIEW_SHORTCUT = "ctrl+shift+r";
const ANNOTATE_LATEST_DOCUMENT_SHORTCUT = "ctrl+alt+l";
const _REVIEW_WIDGET_KEY = "plannotator-auto-review";

type ActiveCodeReview = {
  requestKey: string;
  startedAt: number;
};

type CodeReviewDecision = {
  approved: boolean;
  feedback?: string;
  annotations?: unknown[];
};

const createCodeReviewRequestKey = (): string =>
  `sync:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

const formatCodeReviewMessage = (result: {
  approved: boolean;
  feedback?: string;
  annotations?: unknown[];
}): string | null => {
  if (result.approved) {
    return "# Code Review\n\nCode review completed — no changes requested.";
  }

  if (!result.feedback?.trim()) {
    if ((result.annotations?.length ?? 0) > 0) {
      return "# Code Review\n\nCode review completed with inline annotations. Please address the review comments.";
    }

    return null;
  }

  return `${result.feedback}\n\nPlease address this feedback.`;
};

const formatAnnotationMessage = (options: {
  filePath: string;
  feedback: string;
  annotations?: unknown[];
  isFolder?: boolean;
}): string | null => {
  const feedback = options.feedback.trim();
  const hasAnnotations = (options.annotations?.length ?? 0) > 0;
  if (!feedback && !hasAnnotations) {
    return null;
  }

  const header = options.isFolder
    ? `# Markdown Annotations\n\nFolder: ${options.filePath}`
    : `# Markdown Annotations\n\nFile: ${options.filePath}`;

  const body = feedback
    ? `${feedback}\n\nPlease address the annotation feedback above.`
    : "Annotation completed with inline comments. Please address the annotation feedback above.";

  return `${header}\n\n${body}`;
};

export const recordSessionReviewDocumentPath = (
  ctx: ExtensionContext,
  toolPath: string,
): void => {
  const absolutePath = path.resolve(ctx.cwd, toolPath);
  if (
    !isReviewDocumentPath(absolutePath) ||
    !isPathWithinCwd(ctx, absolutePath)
  ) {
    return;
  }

  let stats: fs.Stats;
  try {
    stats = fs.statSync(absolutePath);
  } catch {
    return;
  }

  if (!stats.isFile()) {
    return;
  }

  getSessionReviewDocuments(getSessionState(ctx), ctx.cwd).set(absolutePath, {
    absolutePath,
    mtimeMs: stats.mtimeMs,
    updatedAt: Date.now(),
  });
};

const getSessionReviewDocuments = (
  state: SessionRuntimeState,
  cwd: string,
): Map<string, SessionReviewDocument> => {
  const existing = state.reviewDocumentsByCwd.get(cwd);
  if (existing) {
    return existing;
  }

  const next = new Map<string, SessionReviewDocument>();
  state.reviewDocumentsByCwd.set(cwd, next);
  return next;
};

export const recordSessionReviewDocumentWrites = (
  ctx: ExtensionContext,
  toolName: string,
  args: unknown,
): void => {
  if (toolName === "bash") {
    for (const toolPath of extractBashPathCandidates(args)) {
      recordSessionReviewDocumentPath(ctx, toolPath);
    }
    return;
  }

  const toolPath = resolveToolPath(args);
  if (toolPath) {
    recordSessionReviewDocumentPath(ctx, toolPath);
  }
};

const findLatestSessionReviewDocument = (
  ctx: ExtensionContext,
): {
  absolutePath: string;
  repoRelativePath: string;
} | null => {
  const documents = getSessionState(ctx).reviewDocumentsByCwd.get(ctx.cwd);
  if (!documents || documents.size === 0) {
    return null;
  }

  let latest: SessionReviewDocument | null = null;
  for (const [absolutePath, candidate] of documents) {
    if (
      !isReviewDocumentPath(absolutePath) ||
      !isPathWithinCwd(ctx, absolutePath)
    ) {
      documents.delete(absolutePath);
      continue;
    }

    let stats: fs.Stats;
    try {
      stats = fs.statSync(absolutePath);
    } catch {
      documents.delete(absolutePath);
      continue;
    }

    if (!stats.isFile()) {
      documents.delete(absolutePath);
      continue;
    }

    const refreshed = {
      ...candidate,
      mtimeMs: stats.mtimeMs,
    };
    documents.set(absolutePath, refreshed);

    if (
      !latest ||
      refreshed.mtimeMs > latest.mtimeMs ||
      (refreshed.mtimeMs === latest.mtimeMs &&
        refreshed.updatedAt >= latest.updatedAt)
    ) {
      latest = refreshed;
    }
  }

  if (!latest) {
    return null;
  }

  return {
    absolutePath: latest.absolutePath,
    repoRelativePath: toRepoRelativePath(ctx, latest.absolutePath),
  };
};

const annotateLatestReviewDocument = async (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> => {
  const log = createLogger("plannotator-auto", { stderr: null });
  if (!ctx.hasUI) {
    ctx.ui.notify("Latest document annotation requires UI mode.", "warning");
    return;
  }

  const latestDocument = findLatestSessionReviewDocument(ctx);
  if (!latestDocument) {
    ctx.ui.notify(
      "No Markdown or HTML files have been modified in this session.",
      "warning",
    );
    return;
  }

  const renderHtml = isHtmlPath(latestDocument.absolutePath);

  log.info("plannotator-auto annotating latest session document", {
    cwd: ctx.cwd,
    documentFile: latestDocument.repoRelativePath,
    renderHtml,
    sessionKey: getSessionKey(ctx),
    shortcut: ANNOTATE_LATEST_DOCUMENT_SHORTCUT,
  });

  try {
    const response = await runPlannotatorAnnotateCli(
      ctx,
      latestDocument.absolutePath,
      {
        renderHtml,
        signal: ctx.signal,
        timeoutMs: SYNC_ANNOTATE_TIMEOUT_MS,
      },
    );

    if (response.status === "handled") {
      const message = formatAnnotationMessage({
        filePath: latestDocument.repoRelativePath,
        feedback: response.result.feedback ?? "",
      });

      if (message) {
        pi.sendUserMessage(message, { deliverAs: "followUp" });
      } else {
        ctx.ui.notify("Document annotation closed (no feedback).", "info");
      }
      return;
    }

    if (response.status === "aborted") {
      ctx.ui.notify("Plannotator annotation interrupted.", "info");
      return;
    }

    ctx.ui.notify(response.error, "warning");
  } catch (error) {
    ctx.ui.notify(
      error instanceof Error
        ? error.message
        : "Plannotator annotation request failed.",
      "warning",
    );
  }
};

export const markReviewPending = (ctx: ExtensionContext): void => {
  const state = getSessionState(ctx);
  state.pendingReviewByCwd.add(ctx.cwd);
};

const clearReviewPending = (ctx: ExtensionContext): void => {
  getSessionState(ctx).pendingReviewByCwd.delete(ctx.cwd);
};

const notifyCodeReviewUnavailable = (
  ctx: ExtensionContext,
  state: SessionRuntimeState,
  log: ReturnType<typeof createLogger>,
  message: string,
): void => {
  if (state.plannotatorUnavailableNotified) {
    log.debug(
      "plannotator-auto suppressed duplicate unavailable notification",
      {
        cwd: ctx.cwd,
        sessionKey: getSessionKey(ctx),
        message,
      },
    );
    return;
  }

  state.plannotatorUnavailableNotified = true;
  log.warn("plannotator-auto notified plannotator unavailable", {
    cwd: ctx.cwd,
    sessionKey: getSessionKey(ctx),
    message,
  });
  ctx.ui.notify(message, "warning");
};

const handleCodeReviewCompletion = (
  pi: ExtensionAPI,
  ctx: Pick<ExtensionContext, "cwd"> & {
    ui?: Pick<ExtensionContext["ui"], "notify">;
  },
  state: SessionRuntimeState,
  active: ActiveCodeReview,
  result: CodeReviewDecision,
  log: ReturnType<typeof createLogger>,
  onStateChanged?: () => void,
): void => {
  const superseded = state.pendingReviewByCwd.has(ctx.cwd);

  state.activeCodeReviewByCwd.delete(ctx.cwd);
  state.plannotatorUnavailableNotified = false;
  onStateChanged?.();

  if (superseded) {
    log.info("plannotator-auto suppressed stale code-review completion", {
      cwd: ctx.cwd,
      requestKey: active.requestKey,
      approved: result.approved,
    });
    return;
  }

  const message = formatCodeReviewMessage(result);
  if (message) {
    pi.sendUserMessage(message, { deliverAs: "followUp" });
    return;
  }

  ctx.ui?.notify("Code review closed (no feedback).", "info");
};

const clearActiveCodeReview = (
  ctx: Pick<ExtensionContext, "cwd">,
  state: SessionRuntimeState,
  onStateChanged?: () => void,
): void => {
  if (state.activeCodeReviewByCwd.delete(ctx.cwd)) {
    onStateChanged?.();
  }
};

const maybeStartCodeReview = async (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  reason: string,
  log: ReturnType<typeof createLogger>,
  options: { force?: boolean } = {},
): Promise<void> => {
  const state = getSessionState(ctx);
  const hasPending = state.pendingReviewByCwd.has(ctx.cwd);
  const active = state.activeCodeReviewByCwd.get(ctx.cwd);
  const isManualReview = options.force === true;
  const codeReviewAutoTriggerEnabled = isCodeReviewAutoTriggerEnabled(ctx);

  if (!isManualReview && !codeReviewAutoTriggerEnabled && !active) {
    if (hasPending) {
      log.debug(
        "plannotator-auto skipped review (code-review auto trigger disabled)",
        {
          cwd: ctx.cwd,
          reason,
          sessionKey: getSessionKey(ctx),
        },
      );
      clearReviewPending(ctx);
    }
    return;
  }

  const hasReviewCandidate = isManualReview || hasPending || Boolean(active);
  if (!hasReviewCandidate || state.reviewInFlight) {
    return;
  }

  if (!ctx.hasUI) {
    log.debug("plannotator-auto skipped review (no UI)", {
      cwd: ctx.cwd,
      reason,
      sessionKey: getSessionKey(ctx),
    });
    clearReviewPending(ctx);
    return;
  }

  if (!ctx.isIdle()) {
    scheduleReviewRetry(pi, ctx, "busy-review", log);
    return;
  }

  if (!isPlanReviewSettled(state, ctx.cwd)) {
    log.debug(
      "plannotator-auto deferring code review until plan review settles",
      {
        cwd: ctx.cwd,
        reason,
        sessionKey: getSessionKey(ctx),
      },
    );
    scheduleReviewRetry(pi, ctx, "review-after-plan-review", log);
    return;
  }

  const repoRoot = getRepoRoot(ctx.cwd, DEFAULT_GIT_TIMEOUT_MS);
  if (!repoRoot) {
    log.debug("plannotator-auto skipped review (not a git repo)", {
      cwd: ctx.cwd,
      reason,
      sessionKey: getSessionKey(ctx),
    });
    clearReviewPending(ctx);
    return;
  }

  const dirty = checkRepoDirty(repoRoot, DEFAULT_GIT_TIMEOUT_MS);
  if (!dirty) {
    log.warn("plannotator-auto failed to check git status", {
      cwd: ctx.cwd,
      repoRoot,
      reason,
      sessionKey: getSessionKey(ctx),
    });
    clearReviewPending(ctx);
    return;
  }

  if (!dirty.summary.dirty) {
    log.debug("plannotator-auto skipped review (repo clean)", {
      cwd: ctx.cwd,
      repoRoot,
      summary: dirty.summary,
      reason,
      sessionKey: getSessionKey(ctx),
    });
    clearReviewPending(ctx);
    if (isManualReview) {
      ctx.ui.notify("No uncommitted changes to review.", "info");
    }
    return;
  }

  state.reviewInFlight = true;
  const activeReview: ActiveCodeReview = {
    requestKey: createCodeReviewRequestKey(),
    startedAt: Date.now(),
  };
  state.activeCodeReviewByCwd.set(ctx.cwd, activeReview);
  setReviewWidget(ctx);

  try {
    log.info("plannotator-auto starting code review via CLI", {
      cwd: ctx.cwd,
      repoRoot,
      reason,
      sessionKey: getSessionKey(ctx),
    });

    const response = await runPlannotatorCodeReviewCli(
      ctx,
      SYNC_CODE_REVIEW_TIMEOUT_MS,
    );
    if (response.status === "error") {
      clearActiveCodeReview(ctx, state, () => setReviewWidget(ctx));
      notifyCodeReviewUnavailable(ctx, state, log, response.error);
      return;
    }
    if (response.status === "aborted") {
      clearActiveCodeReview(ctx, state, () => setReviewWidget(ctx));
      return;
    }

    clearReviewPending(ctx);
    state.plannotatorUnavailableNotified = false;
    handleCodeReviewCompletion(
      pi,
      ctx,
      state,
      activeReview,
      response.result,
      log,
      () => setReviewWidget(ctx),
    );
  } finally {
    state.reviewInFlight = false;
    setReviewWidget(ctx);
  }
};

const scheduleReviewRetry = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  reason: string,
  log: ReturnType<typeof createLogger>,
  delayMs = DEFAULT_CODE_REVIEW_RETRY_DELAY_MS,
): void => {
  const sessionKey = getSessionKey(ctx);
  const state = getSessionState(ctx);
  if (state.pendingReviewRetry) {
    return;
  }

  state.pendingReviewRetry = setTimeout(() => {
    const currentState = getSessionState(ctx);
    const ctxMap =
      getSessionContextByKey<
        Pick<ExtensionContext, "cwd" | "hasUI" | "isIdle" | "signal" | "ui">
      >();
    const currentCtx = ctxMap.get(sessionKey);
    if (!currentState || !currentCtx) {
      return;
    }

    currentState.pendingReviewRetry = null;
    void maybeStartCodeReview(pi, currentCtx as ExtensionContext, reason, log);
  }, delayMs);
};

export const registerCodeReviewHandlers = (
  pi: ExtensionAPI,
  log: ReturnType<typeof createLogger>,
): void => {
  const runManualCodeReview = async (
    ctx: ExtensionContext,
    reason: string,
  ): Promise<void> => {
    await maybeStartCodeReview(pi, ctx, reason, log, { force: true });
  };

  pi.registerCommand(MANUAL_CODE_REVIEW_COMMAND, {
    description: "Run plannotator CLI review for uncommitted changes",
    handler: async (_args, ctx) => {
      await runManualCodeReview(ctx, "manual-command");
    },
  });

  pi.registerShortcut(MANUAL_CODE_REVIEW_SHORTCUT, {
    description: "Run plannotator CLI review for uncommitted changes",
    handler: async (ctx) => {
      await runManualCodeReview(ctx, "manual-shortcut");
    },
  });

  pi.registerShortcut(ANNOTATE_LATEST_DOCUMENT_SHORTCUT, {
    description: "Annotate latest session document (Ctrl+Alt+L)",
    handler: async (ctx) => {
      await annotateLatestReviewDocument(pi, ctx);
    },
  });
};

export const maybeStartCodeReviewOnAgentEnd = async (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  log: ReturnType<typeof createLogger>,
): Promise<void> => {
  await maybeStartCodeReview(pi, ctx, "agent_end", log);
};
