import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { createLogger } from "../shared/logger.ts";
import { createRemoteChannel } from "./channel/index.ts";
import { loadRemoteApprovalConfig } from "./config.ts";
import {
  extractContextPreview,
  extractFullContext,
  extractLastAssistantSummary,
} from "./context.ts";
import {
  deriveAllowRule,
  requestRemoteApproval,
  runApprovalRace,
} from "./flows/approval.ts";
import { runIdleContinueFlow } from "./flows/idle.ts";
import { requestLocalApproval } from "./flows/local-approval.ts";
import { createAppRuntime } from "./runtime/app-runtime.ts";
import { deriveSessionIdentity } from "./runtime/ids.ts";
import { persistAllowRule } from "./runtime/persistence.ts";

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

type ToolCallEvent = {
  toolName?: string;
  input?: Record<string, unknown>;
};

const runtime = createAppRuntime();
const log = createLogger("remote-approval", { stderr: null });

const normalizeToolName = (toolName: unknown): string | null =>
  typeof toolName === "string" && toolName.trim().length > 0
    ? toolName.trim()
    : null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

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

const isInterceptedTool = (
  toolName: string,
  interceptedTools: string[],
): boolean => interceptedTools.includes(toolName);

const buildInterceptedTools = (
  baseTools: string[],
  extraTools: string[],
): string[] => {
  const tools = new Set<string>();
  for (const tool of [...baseTools, ...extraTools]) {
    if (tool.trim()) {
      tools.add(tool.trim());
    }
  }
  return [...tools];
};

const buildPromptTitle = (
  toolName: string,
  toolInput: Record<string, unknown>,
) => {
  const preview =
    typeof toolInput.command === "string"
      ? toolInput.command
      : typeof toolInput.filePath === "string"
        ? toolInput.filePath
        : typeof toolInput.file_path === "string"
          ? toolInput.file_path
          : toolName;
  return `Approve ${toolName}: ${preview}`;
};

export default function remoteApprovalExtension(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const session = ensureSession(ctx as SessionContext);
    log.info("session_start", {
      sessionId: session.identity.sessionId,
      sessionLabel: session.identity.sessionLabel,
    });
  });

  pi.on("tool_call", async (event, ctx) => {
    const session = ensureSession(ctx as SessionContext);
    const toolName = normalizeToolName((event as ToolCallEvent).toolName);
    const toolInput = isRecord((event as ToolCallEvent).input)
      ? ((event as ToolCallEvent).input as Record<string, unknown>)
      : null;

    if (!toolName || !toolInput || !session.config.enabled) {
      return undefined;
    }

    const interceptedTools = buildInterceptedTools(
      session.config.interceptTools,
      session.config.extraInterceptTools,
    );
    if (!isInterceptedTool(toolName, interceptedTools)) {
      return undefined;
    }

    if (session.sessionState.findMatchingAllowRule(toolName, toolInput)) {
      log.debug("approval_skipped_allow_rule", {
        sessionId: session.identity.sessionId,
        toolName,
      });
      return undefined;
    }

    const remoteChannel = createRemoteChannel(session.config);
    const entries = ctx.sessionManager.getEntries();
    const contextPreview = extractContextPreview(entries, {
      maxTurns: session.config.contextTurns,
      maxChars: session.config.contextMaxChars,
    });
    const fullContextLines = extractFullContext(entries, {
      maxTurns: session.config.contextTurns,
    });
    const promptTitle = buildPromptTitle(toolName, toolInput);
    const hasLocalUi = ctx.hasUI && typeof ctx.ui.select === "function";

    if (!remoteChannel.channel) {
      log.warn("approval_unavailable", {
        sessionId: session.identity.sessionId,
        toolName,
        strictRemote: session.config.strictRemote,
      });
      if (session.config.strictRemote) {
        return {
          block: true,
          reason: "Remote approval required but unavailable",
        };
      }
      if (!hasLocalUi) {
        return undefined;
      }
    }

    let decision: "allow" | "always" | "deny";
    let resolvedBy: "local" | "remote" = "local";

    if (hasLocalUi && remoteChannel.channel) {
      const requestId = `apr_${session.identity.sessionId}_${Date.now()}`;
      session.requestStore.create({
        requestId,
        kind: "approval",
        sessionId: session.identity.sessionId,
        sessionLabel: session.identity.sessionLabel,
        toolName,
        toolInputPreview: promptTitle,
        contextPreview,
        fullContextAvailable: fullContextLines.length > 0,
      });
      const raced = await runApprovalRace({
        requestId,
        requestStore: session.requestStore,
        localApproval: requestLocalApproval(ctx as SessionContext, {
          toolName,
          title: promptTitle,
          preview: promptTitle,
          contextPreview,
        }),
        remoteApproval: requestRemoteApproval({
          channel: remoteChannel.channel,
          text: `🔐 Approval request\n\n${promptTitle}`,
          includeAlways: true,
          fullContextLines,
        }).then((result) => result.decision),
        toolName,
        toolInput,
      });
      decision = raced.decision;
      resolvedBy = raced.resolvedBy;
    } else if (hasLocalUi) {
      decision = await requestLocalApproval(ctx as SessionContext, {
        toolName,
        title: promptTitle,
        preview: promptTitle,
        contextPreview,
      });
    } else if (remoteChannel.channel) {
      decision = (
        await requestRemoteApproval({
          channel: remoteChannel.channel,
          text: `🔐 Approval request\n\n${promptTitle}`,
          includeAlways: true,
          fullContextLines,
        })
      ).decision;
      resolvedBy = "remote";
    } else {
      return undefined;
    }

    log.info("approval_resolved", {
      sessionId: session.identity.sessionId,
      toolName,
      decision,
      resolvedBy,
    });

    if (decision === "deny") {
      return {
        block: true,
        reason:
          resolvedBy === "remote"
            ? "Blocked by user via remote approval"
            : "Blocked by user via local approval",
      };
    }

    if (decision === "always") {
      const rule = deriveAllowRule(toolName, toolInput, Date.now());
      if (rule) {
        session.sessionState.addAllowRule(rule);
        persistAllowRule(pi, rule);
        log.info("allow_rule_persisted", {
          sessionId: session.identity.sessionId,
          toolName,
          scope: rule.scope,
        });
      }
    }

    return undefined;
  });

  pi.on("agent_end", async (_event, ctx) => {
    const session = ensureSession(ctx as SessionContext);
    if (!session.config.enabled || !session.config.idleEnabled) {
      return;
    }

    const remoteChannel = createRemoteChannel(session.config);
    if (!remoteChannel.channel) {
      return;
    }

    const entries = (ctx as SessionContext).sessionManager.getEntries();
    const contextPreview = extractContextPreview(entries, {
      maxTurns: session.config.contextTurns,
      maxChars: session.config.contextMaxChars,
    });
    const fullContextLines = extractFullContext(entries, {
      maxTurns: session.config.contextTurns,
    });
    const requestId = `idle_${session.identity.sessionId}_${Date.now()}`;
    log.debug("idle_request_created", {
      sessionId: session.identity.sessionId,
      requestId,
    });
    void runIdleContinueFlow({
      requestStore: session.requestStore,
      channel: remoteChannel.channel,
      pi,
      executionContext: ctx as SessionContext,
      request: {
        requestId,
        sessionId: session.identity.sessionId,
        sessionLabel: session.identity.sessionLabel,
        assistantSummary: extractLastAssistantSummary(entries),
        contextPreview,
        fullContextLines,
        continueEnabled: session.config.continueEnabled,
        fullContextAvailable: fullContextLines.length > 0,
      },
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
