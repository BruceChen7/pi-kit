/**
 * Desktop Notification Extension
 *
 * Sends a native desktop notification when the agent finishes and is waiting for input.
 * Uses OSC 777 escape sequence - no external dependencies.
 *
 * Supported terminals: Ghostty, iTerm2, WezTerm, rxvt-unicode
 * Not supported: Kitty (uses OSC 99), Terminal.app, Windows Terminal, Alacritty
 */

import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import {
  createHandledState,
  NOTIFY_IDLE_CHANNEL,
  type PiKitNotifyIdleEvent,
} from "../shared/internal-events.ts";
import { createLogger } from "../shared/logger.ts";
import { loadSettings } from "../shared/settings.ts";

export interface NotifyConfig {
  /** Enable/disable the notification extension (default: true) */
  enabled: boolean;
  /** Send a desktop notification when the turn was explicitly aborted. */
  notifyOnAbort: boolean;
  /** Send a desktop notification when the turn ended with an error. */
  notifyOnFailure: boolean;
  /** Send a desktop notification when the assistant output was truncated. */
  notifyOnTruncation: boolean;
  /** Maximum body length after markdown simplification and whitespace normalization. */
  maxBodyChars: number;
}

export const DEFAULT_CONFIG: NotifyConfig = {
  enabled: true,
  notifyOnAbort: false,
  notifyOnFailure: true,
  notifyOnTruncation: true,
  maxBodyChars: 200,
};

type NotifySettings = Partial<Record<keyof NotifyConfig, unknown>>;
type AgentEndMessage = {
  role?: string;
  content?: unknown;
  stopReason?: unknown;
};
type AgentEndEvent = { messages?: AgentEndMessage[] };
type NotifyTurnStatus = "success" | "aborted" | "error" | "length";
type NotifyTransportStatus = "sent" | "write-failed";

type NotificationDecision = {
  shouldNotify: boolean;
  shouldEmitIdleEvent: boolean;
  title: string;
  body: string;
  status: NotifyTurnStatus;
  skipReason?: string;
};

type NotifyRuntimeContext = {
  cwd?: string;
  signal?: { aborted?: boolean };
};

/**
 * Send a desktop notification via OSC 777 escape sequence.
 */
let log: ReturnType<typeof createLogger> | null = null;

async function initLogger(): Promise<void> {
  log = createLogger("notify", {
    stderr: null,
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const normalizeBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

const normalizePositiveInteger = (value: unknown, fallback: number): number => {
  if (!Number.isInteger(value) || typeof value !== "number" || value <= 0) {
    return fallback;
  }
  return value;
};

export const normalizeNotifyConfig = (value: unknown): NotifyConfig => {
  const settings = isRecord(value) ? (value as NotifySettings) : {};
  return {
    enabled: normalizeBoolean(settings.enabled, DEFAULT_CONFIG.enabled),
    notifyOnAbort: normalizeBoolean(
      settings.notifyOnAbort,
      DEFAULT_CONFIG.notifyOnAbort,
    ),
    notifyOnFailure: normalizeBoolean(
      settings.notifyOnFailure,
      DEFAULT_CONFIG.notifyOnFailure,
    ),
    notifyOnTruncation: normalizeBoolean(
      settings.notifyOnTruncation,
      DEFAULT_CONFIG.notifyOnTruncation,
    ),
    maxBodyChars: normalizePositiveInteger(
      settings.maxBodyChars,
      DEFAULT_CONFIG.maxBodyChars,
    ),
  };
};

const loadNotifyConfig = (cwd: string): NotifyConfig => {
  const { merged } = loadSettings(cwd);
  return normalizeNotifyConfig(merged.notify);
};

const isUnsafeOscCodePoint = (codePoint: number): boolean =>
  codePoint === 0x1b || codePoint === 0x7f || codePoint < 0x20;

const sanitizeOscField = (value: string): string =>
  Array.from(value)
    .filter((char) => !isUnsafeOscCodePoint(char.codePointAt(0) ?? 0))
    .join("");

const wrapForTmuxPassthrough = (payload: string): string => {
  const escaped = payload.split("\x1b").join("\x1b\x1b");
  // tmux DCS passthrough: ESC P tmux; <payload-with-doubled-ESC> ESC \
  return `\x1bPtmux;${escaped}\x1b\\`;
};

const notify = (title: string, body: string): NotifyTransportStatus => {
  const safeTitle = sanitizeOscField(title);
  const safeBody = sanitizeOscField(body);
  // OSC 777 format: ESC ] 777 ; notify ; title ; body BEL
  const osc777 = `\x1b]777;notify;${safeTitle};${safeBody}\x07`;
  const inTmux = Boolean(process.env.TMUX);
  const payload = inTmux ? wrapForTmuxPassthrough(osc777) : osc777;

  log?.debug("writing notification payload", {
    protocol: "OSC777",
    inTmux,
    titleLength: safeTitle.length,
    bodyLength: safeBody.length,
    payloadPreview: payload
      .split("\x1b")
      .join("<ESC>")
      .split("\x07")
      .join("<BEL>"),
    term: process.env.TERM,
    termProgram: process.env.TERM_PROGRAM,
    tty: Boolean(process.stdout.isTTY),
  });

  try {
    process.stdout.write(payload);
    return "sent";
  } catch (error) {
    log?.warn("notification write failed", {
      error: error instanceof Error ? error.message : String(error),
      term: process.env.TERM,
      termProgram: process.env.TERM_PROGRAM,
      tty: Boolean(process.stdout.isTTY),
    });
    return "write-failed";
  }
};

const execFileAsync = (
  file: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    execFile(file, args, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }

      resolve({
        stdout: stdout.toString(),
        stderr: stderr.toString(),
      });
    });
  });

export const getTmuxWindowName = async (): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync("tmux", [
      "display-message",
      "-p",
      "#W",
    ]);
    const name = stdout.trim();
    const windowName = name ? name : null;
    log?.debug("tmux window name resolved", { windowName });
    return windowName;
  } catch (error) {
    log?.debug("tmux window name lookup failed", {
      error: String(error),
    });
    return null;
  }
};

export const resolveNotificationTitle = async (
  baseTitle: string,
  inTmux: boolean,
): Promise<string> => {
  if (!inTmux) {
    return baseTitle;
  }

  const windowName = await getTmuxWindowName();
  return windowName ? `${windowName} - ${baseTitle}` : baseTitle;
};

const isTextPart = (part: unknown): part is { type: "text"; text: string } =>
  Boolean(
    part &&
      typeof part === "object" &&
      "type" in part &&
      part.type === "text" &&
      "text" in part,
  );

const findLastAssistantMessage = (
  messages: AgentEndMessage[],
): AgentEndMessage | null => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === "assistant") {
      return message;
    }
  }
  return null;
};

const extractLastAssistantText = (
  messages: AgentEndMessage[],
): string | null => {
  const message = findLastAssistantMessage(messages);
  const content = message?.content;
  if (typeof content === "string") {
    return content.trim() || null;
  }

  if (Array.isArray(content)) {
    const text = content
      .filter(isTextPart)
      .map((part) => part.text)
      .join("\n")
      .trim();
    return text || null;
  }

  return null;
};

const extractLastAssistantStopReason = (
  messages: AgentEndMessage[],
): string | null => {
  const stopReason = findLastAssistantMessage(messages)?.stopReason;
  return typeof stopReason === "string" ? stopReason : null;
};

const resolveTurnStatus = (
  event: AgentEndEvent,
  ctx: NotifyRuntimeContext,
): NotifyTurnStatus => {
  const stopReason = extractLastAssistantStopReason(event.messages ?? []);
  if (ctx.signal?.aborted || stopReason === "aborted") {
    return "aborted";
  }
  if (stopReason === "error") {
    return "error";
  }
  if (stopReason === "length") {
    return "length";
  }
  return "success";
};

const plainMarkdownTheme: MarkdownTheme = {
  heading: (text) => text,
  link: (text) => text,
  linkUrl: () => "",
  code: (text) => text,
  codeBlock: (text) => text,
  codeBlockBorder: () => "",
  quote: (text) => text,
  quoteBorder: () => "",
  hr: () => "",
  listBullet: () => "",
  bold: (text) => text,
  italic: (text) => text,
  strikethrough: (text) => text,
  underline: (text) => text,
};

const simpleMarkdown = (text: string, width = 80): string => {
  const markdown = new Markdown(text, 0, 0, plainMarkdownTheme);
  return markdown.render(width).join("\n");
};

const normalizeNotificationBody = (
  text: string | null,
  maxBodyChars: number,
): string => {
  const simplified = text ? simpleMarkdown(text) : "";
  const normalized = sanitizeOscField(simplified.replace(/\s+/g, " ")).trim();
  if (!normalized) {
    return "";
  }
  return normalized.length > maxBodyChars
    ? `${normalized.slice(0, maxBodyChars - 1)}…`
    : normalized;
};

const fallbackBodyForStatus = (status: NotifyTurnStatus): string => {
  switch (status) {
    case "aborted":
      return "Agent run was stopped.";
    case "error":
      return "Agent ended with an error.";
    case "length":
      return "Output was truncated.";
    case "success":
      return "";
  }
};

const titleForStatus = (status: NotifyTurnStatus, hasBody: boolean): string => {
  switch (status) {
    case "aborted":
      return "π stopped";
    case "error":
      return "π failed";
    case "length":
      return "π output truncated";
    case "success":
      return hasBody ? "π" : "Ready for input";
  }
};

const shouldNotifyStatus = (
  status: NotifyTurnStatus,
  config: NotifyConfig,
): boolean => {
  switch (status) {
    case "aborted":
      return config.notifyOnAbort;
    case "error":
      return config.notifyOnFailure;
    case "length":
      return config.notifyOnTruncation;
    case "success":
      return true;
  }
};

const buildNotificationDecision = (input: {
  event: AgentEndEvent;
  ctx: NotifyRuntimeContext;
  config: NotifyConfig;
  lastText: string | null;
}): NotificationDecision => {
  const status = resolveTurnStatus(input.event, input.ctx);
  const body =
    normalizeNotificationBody(input.lastText, input.config.maxBodyChars) ||
    fallbackBodyForStatus(status);
  const title = titleForStatus(status, Boolean(body));

  if (!input.config.enabled) {
    return {
      shouldNotify: false,
      shouldEmitIdleEvent: false,
      title,
      body,
      status,
      skipReason: "disabled",
    };
  }

  if (!shouldNotifyStatus(status, input.config)) {
    return {
      shouldNotify: false,
      shouldEmitIdleEvent: false,
      title,
      body,
      status,
      skipReason: `status-${status}-disabled`,
    };
  }

  return {
    shouldNotify: true,
    shouldEmitIdleEvent: status === "success",
    title,
    body,
    status,
  };
};

const createNotifyIdleEvent = (input: {
  title: string;
  body: string;
  ctx: unknown;
}): PiKitNotifyIdleEvent => ({
  type: "notify.idle",
  requestId: `notify_${Date.now()}`,
  createdAt: Date.now(),
  title: input.title,
  body: input.body,
  contextPreview: input.body ? [`assistant: ${input.body}`] : [],
  fullContextLines: input.body ? [`assistant: ${input.body}`] : [],
  continueEnabled: true,
  handled: createHandledState(),
  ctx: input.ctx,
});

export default async function (pi: ExtensionAPI) {
  await initLogger();

  log?.debug("extension initialized", {
    pid: process.pid,
    term: process.env.TERM,
    termProgram: process.env.TERM_PROGRAM,
    tty: Boolean(process.stdout.isTTY),
  });

  pi.on("agent_end", async (event: AgentEndEvent, ctx: unknown) => {
    const messages = event.messages ?? [];
    const last = messages.at(-1);
    const lastContentType =
      last && "content" in last
        ? Array.isArray(last.content)
          ? "array"
          : typeof last.content
        : null;
    log?.debug("agent_end received", {
      messageCount: messages.length,
      lastRole: last?.role ?? null,
      lastContentType,
    });

    const lastText = extractLastAssistantText(messages);
    log?.debug("assistant text extracted", {
      hasText: Boolean(lastText),
      preview: lastText ? lastText.slice(0, 120) : null,
    });

    const runtimeCtx = isRecord(ctx) ? (ctx as NotifyRuntimeContext) : {};
    const config = loadNotifyConfig(runtimeCtx.cwd ?? process.cwd());
    const decision = buildNotificationDecision({
      event,
      ctx: runtimeCtx,
      config,
      lastText,
    });
    if (!decision.shouldNotify) {
      log?.debug("notification skipped", {
        status: decision.status,
        skipReason: decision.skipReason,
      });
      return;
    }

    const inTmux = Boolean(process.env.TMUX);
    const resolvedTitle = await resolveNotificationTitle(
      decision.title,
      inTmux,
    );
    log?.debug("notification formatted", {
      title: resolvedTitle,
      bodyPreview: decision.body.slice(0, 120),
      bodyLength: decision.body.length,
      status: decision.status,
      inTmux,
    });

    const transportStatus = notify(resolvedTitle, decision.body);
    if (transportStatus !== "sent") {
      return;
    }

    if (decision.shouldEmitIdleEvent) {
      pi.events.emit(
        NOTIFY_IDLE_CHANNEL,
        createNotifyIdleEvent({
          title: resolvedTitle,
          body: decision.body,
          ctx,
        }),
      );
    }
  });
}
