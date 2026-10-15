/**
 * Desktop Notification Extension
 *
 * Sends a native desktop notification when the agent finishes and is waiting for input.
 * Uses OSC 777 escape sequence - no external dependencies.
 *
 * Supported terminals: Ghostty, iTerm2, WezTerm, rxvt-unicode
 * Not supported: Kitty (uses OSC 99), Terminal.app, Windows Terminal, Alacritty
 * Herdr: uses herdr CLI (herdr notification show) when HERDR_PANE_ID is set.
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
import { uiHostProfile } from "../shared/rich-ui.ts";
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
type NotifyTransportStatus = "sent" | "write-failed" | "failed" | "no-terminal";

/**
 * 浏览器宿主（pi-web）：没有终端可写 OSC 777，改用宿主自己的 toast。
 * 写入 stdout 在这里只会进 server 日志，用户看不到。
 */
const isWebHostContext = (ctx: NotifyRuntimeContext): boolean =>
  typeof ctx.ui?.notify === "function" &&
  uiHostProfile({ hasUI: ctx.hasUI, mode: ctx.mode }).kind === "pi-web";

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
  /** 宿主是否愿意对话、跑在哪个模式（`uiHostProfile` 需要这两项）。 */
  hasUI?: boolean;
  mode?: string;
  /** 浏览器宿主（pi-web）的 toast 通道；终端宿主不填。 */
  ui?: {
    notify?: (message: string, level?: "info" | "warning" | "error") => void;
  };
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

const notify = async (
  title: string,
  body: string,
): Promise<NotifyTransportStatus> => {
  // OSC 777 format: ESC ] 777 ; notify ; title ; body BEL
  const osc777 = `\x1b]777;notify;${title};${body}\x07`;
  const inTmux = Boolean(process.env.TMUX);
  const payload = inTmux ? wrapForTmuxPassthrough(osc777) : osc777;

  log?.debug("writing notification payload", {
    protocol: "OSC777",
    inTmux,
    titleLength: title.length,
    bodyLength: body.length,
    payloadPreview: payload
      .split("\x1b")
      .join("<ESC>")
      .split("\x07")
      .join("<BEL>"),
    term: process.env.TERM,
    termProgram: process.env.TERM_PROGRAM,
    tty: Boolean(process.stdout.isTTY),
  });

  // 明确不是终端（管道/文件）就没有“通知”可发：OSC 777 只会写进日志。
  // 只在 `false` 时短路：`undefined`（测试、嵌入运行时）沿用旧行为继续写。
  if (process.stdout.isTTY === false) {
    return "no-terminal";
  }

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
  options?: { timeout?: number },
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    execFile(file, args, options ?? {}, (error, stdout, stderr) => {
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

const HERDR_NOTIFY_TIMEOUT_MS = 3_000;

const herdrNotify = async (
  title: string,
  body: string,
): Promise<NotifyTransportStatus> => {
  const herdrBin = process.env.HERDR_BIN_PATH ?? "herdr";

  log?.debug("sending herdr notification", {
    herdrBin,
    title,
    bodyPreview: body.slice(0, 120),
    bodyLength: body.length,
  });

  try {
    await execFileAsync(
      herdrBin,
      [
        "notification",
        "show",
        title,
        "--body",
        body,
        "--position",
        "top-right",
        "--sound",
        "request",
      ],
      { timeout: HERDR_NOTIFY_TIMEOUT_MS },
    );
    return "sent";
  } catch (error) {
    log?.warn("herdr notification failed", {
      error: error instanceof Error ? error.message : String(error),
      herdrBin,
    });
    return "failed";
  }
};

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

/** 浏览器宿主：把通知交给宿主 toast（pi-web 的 NoticeShelf）。 */
const panelNotify = async (
  ctx: NotifyRuntimeContext,
  title: string,
  body: string,
): Promise<NotifyTransportStatus> => {
  try {
    ctx.ui?.notify(body ? `${title}: ${body}` : title, "info");
    return "sent";
  } catch (error) {
    log?.warn("panel notification failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return "failed";
  }
};

/**
 * 同一个 `agent_end` dispatch 只处理一次。
 *
 * 同一个扩展文件被两个入口路径加载时（历史上 `extensions/<dir>/notify.ts` 与
 * `extensions/<dir>/notify/index.ts` 两条软链并存），工厂会跑两次，模块作用域
 * 也各有一份，于是每条通知都发两遍、`notify.idle` 也发两遍。
 *
 * pi 的 `ExtensionRunner.emit()` 每次 dispatch 只 `createContext()` 一次，再把
 * 同一个 ctx 交给所有 handler。所以"这个 ctx 已被认领"等价于"这次 dispatch
 * 已被本扩展的另一个实例处理过"，而不同会话、不同轮次、reload 后的 ctx 都是
 * 新对象，不会被误伤。
 *
 * Core：value in → value out，注册表由调用方传入（Shell 负责跨实例共享）。
 * `ctx` 拿不到（老宿主 / 测试桩）时不去重，保持旧行为。
 */
export const claimDispatch = (
  claims: WeakSet<object>,
  ctx: unknown,
): boolean => {
  if (!ctx || typeof ctx !== "object") {
    return true;
  }
  if (claims.has(ctx)) {
    return false;
  }
  claims.add(ctx);
  return true;
};

/**
 * Shell：两个模块实例各有一份模块作用域，只有 globalThis 能共享这份注册表；
 * `Symbol.for` 保证两边取到同一个键。
 */
const DISPATCH_CLAIMS_KEY = Symbol.for("pi-kit:notify:dispatch-claims/v1");

const dispatchClaims = (): WeakSet<object> => {
  const host = globalThis as Record<PropertyKey, unknown>;
  const existing = host[DISPATCH_CLAIMS_KEY];
  if (existing instanceof WeakSet) {
    return existing as WeakSet<object>;
  }
  const claims = new WeakSet<object>();
  host[DISPATCH_CLAIMS_KEY] = claims;
  return claims;
};

let warnedDuplicateDispatch = false;

const warnDuplicateDispatch = (): void => {
  if (warnedDuplicateDispatch) {
    log?.debug("duplicate agent_end dispatch suppressed");
    return;
  }
  warnedDuplicateDispatch = true;
  log?.warn("duplicate agent_end dispatch suppressed", {
    hint: "notify is loaded twice: two extension paths point at the same file. Remove the abandoned `notify.ts` (or `notify/`) symlink from the extensions directory (install-plugins.sh prunes it from now on).",
  });
};

export default async function (pi: ExtensionAPI) {
  await initLogger();

  log?.debug("extension initialized", {
    pid: process.pid,
    term: process.env.TERM,
    termProgram: process.env.TERM_PROGRAM,
    tty: Boolean(process.stdout.isTTY),
  });

  pi.on("agent_end", async (event: AgentEndEvent, ctx: unknown) => {
    if (!claimDispatch(dispatchClaims(), ctx)) {
      warnDuplicateDispatch();
      return;
    }

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

    const safeTitle = sanitizeOscField(resolvedTitle);
    const safeBody = sanitizeOscField(decision.body);
    const inHerdr = Boolean(process.env.HERDR_PANE_ID);
    const transportStatus = isWebHostContext(runtimeCtx)
      ? await panelNotify(runtimeCtx, safeTitle, safeBody)
      : inHerdr
        ? await herdrNotify(safeTitle, safeBody)
        : await notify(safeTitle, safeBody);
    // 只有“写失败”才终止：没有终端（no-terminal）不算失败，否则会连带
    // 吞掉下面的 notify-idle 事件。
    if (transportStatus === "write-failed" || transportStatus === "failed") {
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
