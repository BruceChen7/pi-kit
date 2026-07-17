import fs from "node:fs";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { runPlannotatorAnnotateCli } from "./cli.ts";
import { extractBashPathCandidates, resolveToolPaths } from "./helpers.ts";
import {
  isHtmlPath,
  isPathWithinCwd,
  isReviewDocumentPath,
  toRepoRelativePath,
} from "./paths.ts";
import type { SessionReviewDocument, SessionRuntimeState } from "./session.ts";
import { getSessionState } from "./session.ts";

const SYNC_ANNOTATE_TIMEOUT_MS = 4 * 60 * 60 * 1_000;
const ANNOTATE_LATEST_DOCUMENT_SHORTCUT = "ctrl+alt+l";

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

  for (const toolPath of resolveToolPaths(args)) {
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

export const registerCodeReviewHandlers = (pi: ExtensionAPI): void => {
  pi.registerCommand("plannotator-review", {
    description:
      "Select and submit a plan/spec document for Plannotator review",
    handler: async (_args, ctx) => {
      const { showPlanFilePicker } = await import("./review-picker.ts");
      await showPlanFilePicker(pi, ctx);
    },
  });

  pi.registerShortcut("ctrl+shift+r", {
    description:
      "Select and submit a plan/spec document for Plannotator review",
    handler: async (ctx) => {
      const { showPlanFilePicker } = await import("./review-picker.ts");
      await showPlanFilePicker(pi, ctx);
    },
  });

  pi.registerShortcut(ANNOTATE_LATEST_DOCUMENT_SHORTCUT, {
    description: "Annotate latest session document (Ctrl+Alt+L)",
    handler: async (ctx) => {
      await annotateLatestReviewDocument(pi, ctx);
    },
  });
};
