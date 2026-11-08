/**
 * Desktop Notification Extension
 *
 * Sends a native desktop notification once the run settles (`agent_settled`) and Pi is
 * waiting for input. `agent_end` is not the idle signal: retries, compaction recovery,
 * and queued follow-ups keep running after it.
 *
 * The channel follows the host profile (`shared/ui-host.ts` → `notifications`), never the
 * environment: a terminal host writes OSC 777 (no external dependencies); a host-ui host
 * (pi-web, the nsh clients) gets `ctx.ui.notify` instead, because its stdout is not a
 * terminal anyone reads. Headless hosts get nothing.
 *
 * Supported terminals: Ghostty, iTerm2, WezTerm, rxvt-unicode
 * Not supported: Kitty (uses OSC 99), Terminal.app, Windows Terminal, Alacritty
 * Herdr: uses herdr CLI (herdr notification show) when HERDR_PANE_ID is set.
 */

import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  type MarkdownTheme,
  stripTerminalSequences,
} from "@earendil-works/pi-tui";
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
type RunMessage = {
  role?: string;
  content?: unknown;
  stopReason?: unknown;
};
type AgentSettledEvent = { aborted?: boolean };
type NotifyTurnStatus = "success" | "aborted" | "error" | "length";
type NotifyTransportStatus = "sent" | "write-failed" | "failed" | "no-terminal";

/**
 * 通知往哪送：宿主档案说了算（`ctx.ui.notify` = 宿主 toast；`terminal` = OSC 777）。
 *
 * 不能嗅探终端：pi-clients 的 worker 跑在 macOS 终端里，子进程继承了
 * `HERDR_PANE_ID` / `TMUX` / `TERM_PROGRAM`，而且它的 stdout 并不是用户看的终端
 * —— 写进去只会落到 worker 日志。同理 "android" / "generic-rpc" 这些宿主也不该
 * 被当成 pi-web 的别名。
 */
const resolveNotificationTransport = (
  ctx: NotifyRuntimeContext,
): "panel" | "herdr" | "osc" | "none" => {
  const surface = uiHostProfile({
    hasUI: ctx.hasUI,
    mode: ctx.mode,
  }).notifications;
  if (surface === "host-ui") {
    return typeof ctx.ui?.notify === "function" ? "panel" : "none";
  }
  if (surface === "none") {
    return "none";
  }
  return process.env.HERDR_PANE_ID ? "herdr" : "osc";
};

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
  /** 宿主是否愿意对话、跑在哪个模式（`uiHostProfile` 需要这两项）。 */
  hasUI?: boolean;
  mode?: string;
  sessionManager?: {
    getBranch?: () => readonly unknown[];
    getEntries?: () => readonly unknown[];
  };
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
  messages: RunMessage[],
): RunMessage | null => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === "assistant") {
      return message;
    }
  }
  return null;
};

const extractLastAssistantText = (messages: RunMessage[]): string | null => {
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
  messages: RunMessage[],
): string | null => {
  const stopReason = findLastAssistantMessage(messages)?.stopReason;
  return typeof stopReason === "string" ? stopReason : null;
};

const messageOfEntry = (entry: unknown): RunMessage | null => {
  if (!isRecord(entry) || entry.type !== "message") {
    return null;
  }
  return isRecord(entry.message) ? (entry.message as RunMessage) : null;
};

/**
 * 本轮（一次 settle 覆盖的所有低层 run）产生的消息：从最后一条 user 消息之后
 * 开始。自动重试、压缩重试、排队 follow-up 都不会再插一条 user 消息，所以这段
 * 就是用户正在等的那一轮；更早的轮次不会混进通知正文。
 */
export const runMessagesFromEntries = (
  entries: readonly unknown[],
): RunMessage[] => {
  const messages: RunMessage[] = [];
  for (const entry of entries) {
    const message = messageOfEntry(entry);
    if (message) {
      messages.push(message);
    }
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      return messages.slice(i + 1);
    }
  }
  return messages;
};

const sessionEntries = (ctx: NotifyRuntimeContext): readonly unknown[] => {
  const manager = ctx.sessionManager;
  if (!manager) {
    return [];
  }
  try {
    const entries =
      typeof manager.getBranch === "function"
        ? manager.getBranch()
        : manager.getEntries?.();
    return Array.isArray(entries) ? entries : [];
  } catch (error) {
    log?.warn("session entries read failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
};

const resolveTurnStatus = (input: {
  aborted: boolean;
  stopReason: string | null;
}): NotifyTurnStatus => {
  if (input.aborted || input.stopReason === "aborted") {
    return "aborted";
  }
  if (input.stopReason === "error") {
    return "error";
  }
  if (input.stopReason === "length") {
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

/**
 * Markdown → **纯文本**：主题已经把所有装饰换成恒等函数，但 pi-tui 仍会给链接包一层
 * OSC 8 超链接（`theme.link` 只改可见文字，管不到外面那层），粗体之类也留着 SGR。
 *
 * 那层转义必须整段剥掉，不能只靠后面的 `sanitizeOscField`：它只删 ESC 这一个字符，
 * 序列的骨架会留在正文里 —— `]8;;https://…\`、`[1m`。客户端拿到的是「一句话」，
 * 不是终端；它照着 `https?://` 抽链接时会把 `\` 和 `]8;;` 一起吞进 URL，点开就是
 * 一个不存在的地址（真机症状，见 pi-clients #31）。
 */
const simpleMarkdown = (text: string, width = 80): string => {
  const markdown = new Markdown(text, 0, 0, plainMarkdownTheme);
  return stripTerminalSequences(markdown.render(width).join("\n"));
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
  aborted: boolean;
  stopReason: string | null;
  config: NotifyConfig;
  lastText: string | null;
}): NotificationDecision => {
  const status = resolveTurnStatus({
    aborted: input.aborted,
    stopReason: input.stopReason,
  });
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
    ctx.ui?.notify?.(body ? `${title}: ${body}` : title, "info");
    return "sent";
  } catch (error) {
    log?.warn("panel notification failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return "failed";
  }
};

/**
 * 同一个 `agent_settled` dispatch 只处理一次：同一个扩展文件被两条入口路径加载时
 * （`foo.ts` 与 `foo/index.ts` 软链并存），工厂跑两次、模块作用域各一份，通知
 * 会发两遍。pi 每次 dispatch 只 `createContext()` 一次并把同一个 ctx 交给所有
 * handler，所以"这个 ctx 已被认领"等于"这次 dispatch 已被另一个实例处理过"；
 * 不同会话、轮次、reload 后的 ctx 都是新对象。
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

/** 两个模块实例各有一份作用域，只有 globalThis 能共享注册表。 */
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
    log?.debug("duplicate agent_settled dispatch suppressed");
    return;
  }
  warnedDuplicateDispatch = true;
  log?.warn("duplicate agent_settled dispatch suppressed", {
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

  pi.on("agent_settled", async (event: AgentSettledEvent, ctx: unknown) => {
    if (!claimDispatch(dispatchClaims(), ctx)) {
      warnDuplicateDispatch();
      return;
    }

    const runtimeCtx = isRecord(ctx) ? (ctx as NotifyRuntimeContext) : {};
    const messages = runMessagesFromEntries(sessionEntries(runtimeCtx));
    const last = messages.at(-1);
    const lastContentType =
      last && "content" in last
        ? Array.isArray(last.content)
          ? "array"
          : typeof last.content
        : null;
    log?.debug("agent_settled received", {
      aborted: Boolean(event.aborted),
      messageCount: messages.length,
      lastRole: last?.role ?? null,
      lastContentType,
    });

    const lastText = extractLastAssistantText(messages);
    log?.debug("assistant text extracted", {
      hasText: Boolean(lastText),
      preview: lastText ? lastText.slice(0, 120) : null,
    });

    const config = loadNotifyConfig(runtimeCtx.cwd ?? process.cwd());
    const decision = buildNotificationDecision({
      aborted: Boolean(event.aborted),
      stopReason: extractLastAssistantStopReason(messages),
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
    const transport = resolveNotificationTransport(runtimeCtx);
    const transportStatus =
      transport === "panel"
        ? await panelNotify(runtimeCtx, safeTitle, safeBody)
        : transport === "herdr"
          ? await herdrNotify(safeTitle, safeBody)
          : transport === "osc"
            ? await notify(safeTitle, safeBody)
            : ("no-terminal" as const);
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
