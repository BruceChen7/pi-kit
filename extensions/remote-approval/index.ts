import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import {
  AGENT_END_CODE_SIMPLIFIER_APPROVAL_CHANNEL,
  type PiKitAgentEndCodeSimplifierApprovalEvent,
  type PiKitPlannotatorPendingReviewEvent,
  type PiKitSafeDeleteApprovalEvent,
  PLANNOTATOR_PENDING_REVIEW_CHANNEL,
  SAFE_DELETE_APPROVAL_CHANNEL,
} from "../shared/internal-events.ts";
import { createLogger } from "../shared/logger.ts";
import { createRemoteChannel } from "./channel/index.ts";
import { loadRemoteApprovalConfig } from "./config.ts";
import { requestRemoteApproval } from "./flows/approval.ts";
import { runIdleContinueFlow } from "./flows/idle.ts";
import { createAppRuntime } from "./runtime/app-runtime.ts";
import { deriveSessionIdentity } from "./runtime/ids.ts";

type SessionEntry = {
  type?: string;
  customType?: string;
  data?: unknown;
};

type SessionContext = {
  cwd: string;
  hasUI: boolean;
  isIdle: () => boolean;
  ui: {
    custom?: (
      builder: unknown,
      options?: { overlay?: boolean },
    ) => Promise<"allow" | "always" | "deny" | undefined>;
    select?: (title: string, options: string[]) => Promise<string | undefined>;
    notify?: (message: string, level: string) => void;
  };
  sessionManager: {
    getEntries: () => SessionEntry[];
    getSessionFile: () => string | undefined;
    getSessionName?: () => string | undefined;
  };
};

const runtime = createAppRuntime();
const log = createLogger("remote-approval", { stderr: null });

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const ensureSession = (ctx: SessionContext) => {
  const identity = deriveSessionIdentity({
    cwd: ctx.cwd,
    sessionFile: ctx.sessionManager.getSessionFile(),
    sessionName: ctx.sessionManager.getSessionName?.(),
  });
  const existing = runtime.getSession(identity.sessionId);
  if (existing) {
    return existing;
  }

  return runtime.startSession({
    cwd: ctx.cwd,
    sessionFile: ctx.sessionManager.getSessionFile(),
    sessionName: ctx.sessionManager.getSessionName?.(),
    config: loadRemoteApprovalConfig(ctx.cwd),
    entries: ctx.sessionManager.getEntries(),
  });
};

type RemoteContinueEvent = Pick<
  PiKitPlannotatorPendingReviewEvent,
  | "requestId"
  | "title"
  | "body"
  | "contextPreview"
  | "fullContextLines"
  | "continueEnabled"
  | "handled"
  | "ctx"
>;

const handleRemoteContinueEvent = async (
  pi: ExtensionAPI,
  event: RemoteContinueEvent,
) => {
  const ctx = event.ctx as SessionContext;
  const session = ensureSession(ctx);
  if (!session.config.enabled || !session.config.idleEnabled) {
    return;
  }

  await sleep(session.config.approvalTimeoutMs);
  if (event.handled.isHandled()) {
    log.debug("notify_idle_remote_skipped_handled", {
      sessionId: session.identity.sessionId,
      requestId: event.requestId,
    });
    return;
  }

  const remoteChannel = createRemoteChannel(session.config);
  if (!remoteChannel.channel) {
    return;
  }

  log.debug("notify_idle_remote_request_created", {
    sessionId: session.identity.sessionId,
    requestId: event.requestId,
  });
  await runIdleContinueFlow({
    requestStore: session.requestStore,
    channel: remoteChannel.channel,
    pi,
    executionContext: ctx,
    request: {
      requestId: event.requestId,
      sessionId: session.identity.sessionId,
      sessionLabel: session.identity.sessionLabel,
      assistantSummary: event.body || event.title,
      contextPreview: event.contextPreview,
      fullContextLines: event.fullContextLines,
      continueEnabled: event.continueEnabled,
      fullContextAvailable: event.fullContextLines.length > 0,
    },
  });
};

type BooleanRemoteApprovalEvent = Pick<
  PiKitSafeDeleteApprovalEvent,
  | "requestId"
  | "body"
  | "fullContextLines"
  | "localDecision"
  | "attachRemoteDecision"
  | "ctx"
>;

const handleBooleanApprovalEvent = (
  event: BooleanRemoteApprovalEvent,
  options: { textPrefix: string; logPrefix: string },
) => {
  const ctx = event.ctx as SessionContext;
  const session = ensureSession(ctx);
  if (!session.config.enabled) {
    return;
  }

  const remoteChannel = createRemoteChannel(session.config);
  if (!remoteChannel.channel) {
    log.debug(`${options.logPrefix}_remote_skipped_no_channel`, {
      sessionId: session.identity.sessionId,
      requestId: event.requestId,
      reason: remoteChannel.error?.reason,
      strictRemote: session.config.strictRemote,
    });
    if (session.config.strictRemote) {
      event.attachRemoteDecision(Promise.resolve(false));
    }
    return;
  }

  const remoteDecision = (async (): Promise<boolean> => {
    const localDecision = event.localDecision;
    let localResolved = false;
    if (localDecision) {
      void localDecision.finally(() => {
        localResolved = true;
      });
    }

    await sleep(session.config.approvalTimeoutMs);
    if (localDecision && localResolved) {
      log.debug(`${options.logPrefix}_remote_skipped_local_resolved`, {
        sessionId: session.identity.sessionId,
        requestId: event.requestId,
      });
      return await localDecision;
    }

    log.debug(`${options.logPrefix}_remote_request_created`, {
      sessionId: session.identity.sessionId,
      requestId: event.requestId,
    });
    try {
      const result = await requestRemoteApproval({
        channel: remoteChannel.channel,
        text: `${options.textPrefix}\n\n${event.body}`,
        includeAlways: false,
        fullContextLines: event.fullContextLines,
      });
      return result.decision === "allow" || result.decision === "always";
    } catch (error) {
      log.warn(`${options.logPrefix}_remote_request_failed`, {
        sessionId: session.identity.sessionId,
        requestId: event.requestId,
        strictRemote: session.config.strictRemote,
        error: error instanceof Error ? error.message : String(error),
      });
      if (session.config.strictRemote) {
        return false;
      }
      return localDecision ? await localDecision : false;
    }
  })();

  event.attachRemoteDecision(remoteDecision);
};

const handleSafeDeleteApprovalEvent = (event: PiKitSafeDeleteApprovalEvent) => {
  handleBooleanApprovalEvent(event, {
    textPrefix: "🔐 Safe delete approval",
    logPrefix: "safe_delete",
  });
};

const handleAgentEndCodeSimplifierApprovalEvent = (
  event: PiKitAgentEndCodeSimplifierApprovalEvent,
) => {
  handleBooleanApprovalEvent(event, {
    textPrefix: "🧹 Code simplifier approval",
    logPrefix: "agent_end_code_simplifier",
  });
};

export default function remoteApprovalExtension(pi: ExtensionAPI) {
  pi.events.on(SAFE_DELETE_APPROVAL_CHANNEL, (event) => {
    handleSafeDeleteApprovalEvent(event as PiKitSafeDeleteApprovalEvent);
  });
  pi.events.on(AGENT_END_CODE_SIMPLIFIER_APPROVAL_CHANNEL, (event) => {
    handleAgentEndCodeSimplifierApprovalEvent(
      event as PiKitAgentEndCodeSimplifierApprovalEvent,
    );
  });
  pi.events.on(PLANNOTATOR_PENDING_REVIEW_CHANNEL, (event) => {
    void handleRemoteContinueEvent(
      pi,
      event as PiKitPlannotatorPendingReviewEvent,
    );
  });

  pi.on("session_start", async (_event, ctx) => {
    const session = ensureSession(ctx as SessionContext);
    log.info("session_start", {
      sessionId: session.identity.sessionId,
      sessionLabel: session.identity.sessionLabel,
    });
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const sessionFile = (ctx as SessionContext).sessionManager.getSessionFile();
    const session = ensureSession(ctx as SessionContext);
    log.info("session_shutdown", {
      sessionId: session.identity.sessionId,
      sessionLabel: session.identity.sessionLabel,
    });
    runtime.shutdownSession(session.identity.sessionId);
    void sessionFile;
  });
}
