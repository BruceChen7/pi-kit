import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import {
  NOTIFY_IDLE_CHANNEL,
  type PiKitNotifyIdleEvent,
  type PiKitSafeDeleteApprovalEvent,
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

const handleNotifyIdleEvent = async (
  pi: ExtensionAPI,
  event: PiKitNotifyIdleEvent,
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

const handleSafeDeleteApprovalEvent = (event: PiKitSafeDeleteApprovalEvent) => {
  const ctx = event.ctx as SessionContext;
  const session = ensureSession(ctx);
  if (!session.config.enabled) {
    return;
  }

  const remoteDecision = (async (): Promise<boolean> => {
    let localResolved = false;
    void event.localDecision.finally(() => {
      localResolved = true;
    });

    await sleep(session.config.approvalTimeoutMs);
    if (localResolved) {
      log.debug("safe_delete_remote_skipped_local_resolved", {
        sessionId: session.identity.sessionId,
        requestId: event.requestId,
      });
      return await event.localDecision;
    }

    const remoteChannel = createRemoteChannel(session.config);
    if (!remoteChannel.channel) {
      if (session.config.strictRemote) {
        return false;
      }
      return await event.localDecision;
    }

    const result = await requestRemoteApproval({
      channel: remoteChannel.channel,
      text: `🔐 Safe delete approval\n\n${event.body}`,
      includeAlways: false,
      fullContextLines: event.fullContextLines,
    });
    return result.decision === "allow" || result.decision === "always";
  })();

  event.attachRemoteDecision(remoteDecision);
};

export default function remoteApprovalExtension(pi: ExtensionAPI) {
  pi.events.on(NOTIFY_IDLE_CHANNEL, (event) => {
    void handleNotifyIdleEvent(pi, event as PiKitNotifyIdleEvent);
  });
  pi.events.on(SAFE_DELETE_APPROVAL_CHANNEL, (event) => {
    handleSafeDeleteApprovalEvent(event as PiKitSafeDeleteApprovalEvent);
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
