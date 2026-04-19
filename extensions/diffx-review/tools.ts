import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { getRepoRoot } from "../shared/git.ts";
import {
  addReply,
  getCommentStats,
  getComments,
  resolveComment,
} from "./client.ts";
import { loadDiffxReviewConfig } from "./config.ts";
import {
  buildNoSessionMessage,
  buildStatusMessage,
  filterComments,
  summarizeCommentsBlock,
} from "./helpers.ts";
import {
  clearDiffxReviewSession,
  getDiffxReviewSession,
  markSessionHealth,
} from "./runtime.ts";
import type { DiffxReviewComment, DiffxReviewSession } from "./types.ts";

const resolveRepoRootOrThrow = (ctx: ExtensionContext): string => {
  const repoRoot = getRepoRoot(ctx.cwd);
  if (!repoRoot) {
    throw new Error("diffx-review requires a git repository");
  }
  return repoRoot;
};

const getHealthySessionOrThrow = async (
  ctx: ExtensionContext,
): Promise<{ session: DiffxReviewSession; comments: DiffxReviewComment[] }> => {
  const repoRoot = resolveRepoRootOrThrow(ctx);
  const config = loadDiffxReviewConfig(repoRoot);
  const session = getDiffxReviewSession(repoRoot);
  if (!session) {
    throw new Error(buildNoSessionMessage(repoRoot));
  }

  try {
    const comments = await getComments(session, config.healthcheckTimeoutMs);
    const publicSession = markSessionHealth(repoRoot, true) ?? session;
    return {
      session: publicSession,
      comments,
    };
  } catch (error) {
    markSessionHealth(repoRoot, false);
    clearDiffxReviewSession(repoRoot);
    throw new Error(
      `diffx review session is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

export const registerDiffxReviewTools = (pi: ExtensionAPI): void => {
  pi.registerTool({
    name: "diffx_list_comments",
    label: "List diffx Comments",
    description: "List comments from the active diffx review session",
    promptSnippet: "Inspect comments from the active diffx review session",
    promptGuidelines: [
      "Use this tool when handling diffx review feedback before making changes.",
      "After fixing a reviewed issue, use diffx_reply_comment and diffx_resolve_comment to update the diffx UI.",
    ],
    parameters: Type.Object({
      status: Type.Optional(
        Type.Union([
          Type.Literal("open"),
          Type.Literal("resolved"),
          Type.Literal("all"),
        ]),
      ),
      filePath: Type.Optional(
        Type.String({ description: "Optional file path filter" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { session, comments } = await getHealthySessionOrThrow(ctx);
      const filtered = filterComments(
        comments,
        params.status ?? "open",
        params.filePath,
      );
      const stats = getCommentStats(filtered);
      const summary =
        filtered.length > 0
          ? summarizeCommentsBlock(filtered)
          : "(no matching comments)";

      return {
        content: [
          {
            type: "text",
            text: `diffx comments from ${session.url}: ${stats.total} returned\n${summary}`,
          },
        ],
        details: {
          active: true,
          session,
          stats,
          comments: filtered,
        },
      };
    },
  });

  pi.registerTool({
    name: "diffx_reply_comment",
    label: "Reply to diffx Comment",
    description: "Add a reply to a diffx review comment",
    promptSnippet: "Reply to a diffx review comment after making code changes",
    parameters: Type.Object({
      commentId: Type.String({ description: "Comment id" }),
      body: Type.String({ description: "Reply text" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const repoRoot = resolveRepoRootOrThrow(ctx);
      const config = loadDiffxReviewConfig(repoRoot);
      const session = getDiffxReviewSession(repoRoot);
      if (!session) {
        throw new Error(buildNoSessionMessage(repoRoot));
      }

      let updated: DiffxReviewComment;
      try {
        updated = await addReply(
          session,
          params.commentId,
          params.body,
          config.healthcheckTimeoutMs,
        );
      } catch (error) {
        clearDiffxReviewSession(repoRoot);
        throw new Error(
          `Failed to reply to diffx comment: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      return {
        content: [
          {
            type: "text",
            text: `Added diffx reply to ${params.commentId}`,
          },
        ],
        details: {
          comment: updated,
        },
      };
    },
  });

  pi.registerTool({
    name: "diffx_resolve_comment",
    label: "Resolve diffx Comment",
    description: "Mark a diffx review comment as resolved",
    promptSnippet:
      "Resolve a diffx review comment when the issue is fully addressed",
    parameters: Type.Object({
      commentId: Type.String({ description: "Comment id" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const repoRoot = resolveRepoRootOrThrow(ctx);
      const config = loadDiffxReviewConfig(repoRoot);
      const session = getDiffxReviewSession(repoRoot);
      if (!session) {
        throw new Error(buildNoSessionMessage(repoRoot));
      }

      let updated: DiffxReviewComment;
      try {
        updated = await resolveComment(
          session,
          params.commentId,
          config.healthcheckTimeoutMs,
        );
      } catch (error) {
        clearDiffxReviewSession(repoRoot);
        throw new Error(
          `Failed to resolve diffx comment: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      return {
        content: [
          {
            type: "text",
            text: `Resolved diffx comment ${params.commentId}`,
          },
        ],
        details: {
          comment: updated,
        },
      };
    },
  });

  pi.registerTool({
    name: "diffx_review_status",
    label: "diffx Review Status",
    description: "Read the status of the active diffx review session",
    promptSnippet:
      "Check whether a diffx review session is active and how many comments remain",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const repoRoot = getRepoRoot(ctx.cwd);
      if (!repoRoot) {
        return {
          content: [
            {
              type: "text",
              text: "No git repository detected for diffx review status.",
            },
          ],
          details: {
            active: false,
            repoRoot: null,
          },
        };
      }

      const config = loadDiffxReviewConfig(repoRoot);
      const session = getDiffxReviewSession(repoRoot);
      if (!session) {
        return {
          content: [
            {
              type: "text",
              text: buildNoSessionMessage(repoRoot),
            },
          ],
          details: {
            active: false,
            repoRoot,
          },
        };
      }

      try {
        const comments = await getComments(
          session,
          config.healthcheckTimeoutMs,
        );
        const publicSession = markSessionHealth(repoRoot, true) ?? session;
        const stats = getCommentStats(comments);
        return {
          content: [
            {
              type: "text",
              text: buildStatusMessage({
                session: publicSession,
                stats,
                healthy: true,
              }),
            },
          ],
          details: {
            active: true,
            session: publicSession,
            stats,
            comments,
          },
        };
      } catch (error) {
        markSessionHealth(repoRoot, false);
        clearDiffxReviewSession(repoRoot);
        return {
          content: [
            {
              type: "text",
              text: `diffx review session became unavailable: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          details: {
            active: false,
            repoRoot,
          },
        };
      }
    },
  });
};
