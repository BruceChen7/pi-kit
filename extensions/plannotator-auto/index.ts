// Re-exported public API for tests and other extensions
export { resolvePlanFileForReview } from "./paths.ts";
export { getSessionKey } from "./session.ts";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createLogger } from "../shared/logger.ts";
import { resolveHtmlReviewDirs } from "../shared/review-targets.ts";
import { findToolAnnotations, isMcpToolName } from "../shared/tool-policy.ts";
import { countTrackedChildren, killTrackedChildren } from "./cli.ts";
import {
  recordSessionReviewDocumentWrites,
  registerReviewHandlers,
} from "./code-review.ts";
import {
  isRecord,
  isReviewTrackedToolCall,
  summarizeToolArgs,
} from "./helpers.ts";
import {
  clearReviewWidget,
  createPendingReviewGateMessage,
  getGateablePendingPlanReviews,
  handleBashPlanFileWrites,
  handlePlanFileWrite,
  notifyPendingReviewGateIfNeeded,
  registerPlanReviewSubmitTool,
  setReviewWidget,
} from "./plan-review.ts";
import {
  clearSessionContext,
  clearSessionState,
  getSessionKey,
  getSessionState,
  setSessionContext,
} from "./session.ts";
import {
  clearLastOpened,
  clearTerminalBrowserCache,
  isTerminalBrowserAvailable,
  nextHostMode,
} from "./terminal-browser.ts";

const REVIEW_TRACKED_BUILTIN_TOOL_NAMES = new Set(["write", "edit", "bash"]);

/**
 * Calls whose arguments the end handler may need: pi's write/edit/bash plus
 * every MCP tool (the annotation check needs the arguments, which the end
 * event does not carry).
 */
const isReviewCandidateToolCall = (toolName: string): boolean =>
  REVIEW_TRACKED_BUILTIN_TOOL_NAMES.has(toolName) || isMcpToolName(toolName);

const isTrackedToolCall = (
  api: ExtensionAPI,
  toolName: string,
  args: unknown,
): boolean =>
  isReviewTrackedToolCall(
    toolName,
    args,
    findToolAnnotations(api.getAllTools?.(), toolName),
  );

const planReviewSubmitToolParameters = Type.Object({
  path: Type.String({ description: "Pending review target path" }),
});

const resolveToolPath = (args: unknown): string | null => {
  if (!isRecord(args)) {
    return null;
  }

  const value = args.path;
  return typeof value === "string" ? value : null;
};

export default function plannotatorAuto(pi: ExtensionAPI) {
  const log = createLogger("plannotator-auto", { stderr: null });

  registerPlanReviewSubmitTool(pi, planReviewSubmitToolParameters);
  registerReviewHandlers(pi);

  pi.registerCommand("plannotator-review-host", {
    description: "切换 Markdown 评审托管: 浏览器(默认) ⇄ herdr 面板(临时)",
    handler: async (_args, ctx) => {
      const state = getSessionState(ctx);
      const available = await isTerminalBrowserAvailable(getSessionKey(ctx));
      const { next, ok } = nextHostMode(
        state.reviewHostMode,
        process.env,
        available,
      );
      if (!ok) {
        ctx.ui.notify(
          "无法切换到 herdr 面板: 需要 Herdr 环境(HERDR_ENV=1 + HERDR_PANE_ID)且已安装 terminal-browser。当前保持 浏览器(默认)。",
          "warning",
        );
        return;
      }
      state.reviewHostMode = next;
      ctx.ui.notify(
        `MD 评审托管已切换: ${
          next === "herdr-panel" ? "herdr 面板" : "浏览器(默认)"
        }`,
        "info",
      );
    },
  });

  pi.on("session_start", (_event, ctx) => {
    const sessionKey = getSessionKey(ctx);
    setSessionContext(sessionKey, ctx);
    getSessionState(ctx);
    setReviewWidget(ctx);

    log.debug("plannotator-auto session started", {
      cwd: ctx.cwd,
      sessionKey,
    });
  });

  pi.on("session_shutdown", (_event, ctx) => {
    const sessionKey = getSessionKey(ctx);
    log.debug("plannotator-auto session shutdown", {
      cwd: ctx.cwd,
      sessionKey,
    });

    // Kill any orphan plannotator child processes left hanging when the user
    // closed the browser tab without completing the review.
    const count = countTrackedChildren(sessionKey);
    killTrackedChildren(sessionKey);
    if (count > 0) {
      log.info("cleaned up orphan plannotator processes", {
        cwd: ctx.cwd,
        sessionKey,
        count,
      });
    }

    clearTerminalBrowserCache(sessionKey);
    clearLastOpened(sessionKey);

    clearReviewWidget(ctx);
    clearSessionContext(sessionKey);
    clearSessionState(sessionKey);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    const pendingReviewGateMessage = createPendingReviewGateMessage(ctx);
    if (!pendingReviewGateMessage) {
      return;
    }

    return pendingReviewGateMessage;
  });

  pi.on("tool_execution_start", (event, ctx) => {
    setSessionContext(getSessionKey(ctx), ctx);

    if (!isReviewCandidateToolCall(event.toolName)) {
      return;
    }

    log.debug("plannotator-auto captured tool args", {
      cwd: ctx.cwd,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      sessionKey: getSessionKey(ctx),
    });

    getSessionState(ctx).toolArgsByCallId.set(event.toolCallId, event.args);
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    setSessionContext(getSessionKey(ctx), ctx);

    if (!isReviewCandidateToolCall(event.toolName)) {
      return;
    }

    const state = getSessionState(ctx);
    const args = state.toolArgsByCallId.get(event.toolCallId);
    state.toolArgsByCallId.delete(event.toolCallId);
    if (args === undefined) {
      log.debug(
        "plannotator-auto missing stored tool args on tool_execution_end",
        {
          cwd: ctx.cwd,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          sessionKey: getSessionKey(ctx),
        },
      );
      return;
    }

    if (!isTrackedToolCall(pi, event.toolName, args)) {
      return;
    }

    if (event.isError) {
      log.debug(
        "plannotator-auto skipping review queue after failed tool execution",
        {
          cwd: ctx.cwd,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          sessionKey: getSessionKey(ctx),
        },
      );
      return;
    }

    recordSessionReviewDocumentWrites(ctx, event.toolName, args);

    const htmlDirs = resolveHtmlReviewDirs(ctx.cwd);
    const toolPath = resolveToolPath(args);
    if (toolPath) {
      log.debug("plannotator-auto captured tool path for review gating", {
        cwd: ctx.cwd,
        toolName: event.toolName,
        toolPath,
        htmlDirs,
        sessionKey: getSessionKey(ctx),
      });
    } else if (event.toolName !== "bash") {
      log.debug("plannotator-auto tool args missing path for review gating", {
        cwd: ctx.cwd,
        toolName: event.toolName,
        ...summarizeToolArgs(args),
        sessionKey: getSessionKey(ctx),
      });
    }

    const queuedPlanReview =
      event.toolName === "bash"
        ? handleBashPlanFileWrites(ctx, args, htmlDirs)
        : handlePlanFileWrite(ctx, args, htmlDirs);

    notifyPendingReviewGateIfNeeded(pi, ctx, state, queuedPlanReview);
    setReviewWidget(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    setSessionContext(getSessionKey(ctx), ctx);

    log.debug("plannotator-auto handling agent_end", {
      cwd: ctx.cwd,
      sessionKey: getSessionKey(ctx),
    });

    const state = getSessionState(ctx);
    const gateable = getGateablePendingPlanReviews(state, ctx.cwd);
    if (gateable.length > 0) {
      notifyPendingReviewGateIfNeeded(pi, ctx, state, true);
      setReviewWidget(ctx);
      return;
    }

    setReviewWidget(ctx);
  });
}
