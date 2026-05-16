// Re-exported public API for tests and other extensions
export {
  getPlanFileConfig,
  resolvePlanFileForReview,
  shouldQueueReviewForToolPath,
} from "./paths.ts";
export { getSessionKey } from "./session.ts";

import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../shared/logger.ts";
import {
  recordSessionReviewDocumentWrites,
  registerCodeReviewHandlers,
} from "./code-review.ts";
import { isRecord, summarizeToolArgs } from "./helpers.ts";
import { getPlanFileConfig } from "./paths.ts";
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

const isReviewTrackedToolName = (toolName: string): boolean =>
  toolName === "write" || toolName === "edit" || toolName === "bash";

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
  registerCodeReviewHandlers(pi, log);

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

    if (!isReviewTrackedToolName(event.toolName)) {
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

    if (!isReviewTrackedToolName(event.toolName)) {
      return;
    }

    const state = getSessionState(ctx);
    const args = state.toolArgsByCallId.get(event.toolCallId);
    state.toolArgsByCallId.delete(event.toolCallId);
    if (!args) {
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

    const planConfig = getPlanFileConfig(ctx);
    const toolPath = resolveToolPath(args);
    if (toolPath) {
      log.debug("plannotator-auto captured tool path for review gating", {
        cwd: ctx.cwd,
        toolName: event.toolName,
        toolPath,
        configuredPlanPath: planConfig?.resolvedPlanPath ?? null,
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
        ? handleBashPlanFileWrites(ctx, args, planConfig)
        : handlePlanFileWrite(ctx, args, planConfig);

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
