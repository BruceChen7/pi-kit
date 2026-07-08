import { createLogger } from "./logger.ts";
import { loadSettings } from "./settings.ts";

/** Logger shared across all Telegram notification callers. */
const log = createLogger("telegram", { stderr: null });

/**
 * Minimal Telegram notification helper.
 * Only used for sending messages (not polling, replies, or inline keyboards).
 */
export class TelegramError extends Error {
  readonly method?: string;
  readonly status?: number;
  readonly description?: string;

  constructor(
    message: string,
    details?: {
      method?: string;
      status?: number;
      description?: string;
    },
  ) {
    super(message);
    this.name = "TelegramError";
    this.method = details?.method;
    this.status = details?.status;
    this.description = details?.description;
  }
}

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

const buildTelegramUrl = (botToken: string, method: string): string =>
  `https://api.telegram.org/bot${botToken}/${method}`;

const escapeHtml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/**
 * Convert a subset of Markdown to Telegram-compatible HTML.
 *
 * Supported conversions:
 * - `[text](url)` → `<a href="url">text</a>`
 * - `**bold**` → `<b>bold</b>`
 * - `` `code` `` → `<code>code</code>`
 * - `#/##/### heading` → `<b>heading</b>`
 *
 * Headings are wrapped in <b> to approximate visual weight.
 * Bold markers **…** inside heading content are stripped (not converted to nested <b>)
 * because Telegram rejects nested <b> tags with 400 Bad Request.
 *
 * Inline code content is preserved as-is (no HTML escaping).
 * All other text is HTML-escaped to prevent broken markup.
 */
export function convertMarkdownToTelegramHtml(text: string): string {
  // 1. Protect inline code — preserve raw content, no HTML escaping
  const codes: string[] = [];
  let processed = text.replace(/`([^`]+)`/g, (_, code: string) => {
    codes.push(code);
    return `\x00CODE_${codes.length - 1}\x00`;
  });

  // 2. Protect markdown links [text](url)
  interface LinkPlaceholder {
    text: string;
    url: string;
  }
  const links: LinkPlaceholder[] = [];
  processed = processed.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_, linkText: string, url: string) => {
      links.push({ text: linkText, url });
      return `\x00LINK_${links.length - 1}\x00`;
    },
  );

  // 3. HTML-escape remaining text
  processed = escapeHtml(processed);

  // 4. Convert headings — strip **bold** markers inside headings to prevent
  //    nested <b> tags (Telegram rejects them with 400 Bad Request).
  //    The heading is already wrapped in <b>, so inner bold is visually redundant.
  processed = processed.replace(/^### (.+)$/gm, (_, content: string) => {
    const clean = content.replace(/\*\*(.+?)\*\*/g, "$1");
    return `<b>${clean}</b>`;
  });
  processed = processed.replace(/^## (.+)$/gm, (_, content: string) => {
    const clean = content.replace(/\*\*(.+?)\*\*/g, "$1");
    return `<b>${clean}</b>`;
  });
  processed = processed.replace(/^# (.+)$/gm, (_, content: string) => {
    const clean = content.replace(/\*\*(.+?)\*\*/g, "$1");
    return `<b>${clean}</b>`;
  });

  // 5. Convert bold (non-heading text only, since heading bold was already
  //    stripped in step 4 to prevent <b> nesting)
  processed = processed.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

  // 6. Restore links (escape URL quotes and text HTML entities)
  // Iterate in reverse so index-based placeholders remain valid
  for (let i = links.length - 1; i >= 0; i--) {
    const link = links[i];
    const escapedUrl = link.url.replace(/"/g, "&quot;");
    const escapedText = link.text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    processed = processed.replace(
      `\x00LINK_${i}\x00`,
      `<a href="${escapedUrl}">${escapedText}</a>`,
    );
  }

  // 7. Restore code (raw content, no further escaping)
  for (let i = codes.length - 1; i >= 0; i--) {
    processed = processed.replace(
      `\x00CODE_${i}\x00`,
      `<code>${codes[i]}</code>`,
    );
  }

  return processed;
}

/**
 * Load Telegram config from global settings (remoteApproval.botToken / remoteApproval.chatId).
 *
 * IO function: reads settings from disk.
 *
 * @param cwd - Working directory for resolving project-level settings.
 *              Defaults to process.cwd(). Pass explicitly to avoid implicit
 *              dependency when called from non-session contexts.
 */
export function loadTelegramConfig(cwd?: string): TelegramConfig {
  const { global } = loadSettings(cwd ?? process.cwd());
  const remoteApproval = global.remoteApproval as
    | Record<string, unknown>
    | undefined;

  const botToken =
    typeof remoteApproval?.botToken === "string"
      ? remoteApproval.botToken
      : null;
  const chatId =
    typeof remoteApproval?.chatId === "string" ? remoteApproval.chatId : null;

  if (!botToken || !chatId) {
    throw new TelegramError(
      "Telegram not configured: missing botToken or chatId in global settings",
    );
  }

  return { botToken, chatId };
}

/**
 * Check whether Telegram is configured (botToken + chatId present in settings).
 *
 * Pure semantic wrapper around loadTelegramConfig() — callers don't need to
 * know the config path or field names. Returns false when not configured
 * instead of throwing.
 *
 * @param cwd - Working directory for resolving project-level settings.
 *              Defaults to process.cwd(). Pass explicitly when calling from
 *              non-session contexts to avoid implicit cwd dependency.
 */
export function isTelegramConfigured(cwd?: string): boolean {
  try {
    loadTelegramConfig(cwd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Send a text message to a Telegram chat.
 *
 * When `config` is omitted, loads from global settings automatically
 * (convenience for simple callers).
 *
 * By default the text is HTML-escaped before sending.
 * Pass `rawHtml: true` to skip escaping — useful when passing
 * pre-converted Markdown (e.g. via `convertMarkdownToTelegramHtml()`).
 *
 * Usage:
 * ```ts
 * import { sendTelegramNotification } from "../../shared/telegram.ts";
 * await sendTelegramNotification("📑 X Bookmarks\n\nfetched 50 bookmarks");
 * // With pre-converted HTML:
 * await sendTelegramNotification(html, undefined, true);
 * ```
 */
export async function sendTelegramNotification(
  text: string,
  config?: TelegramConfig,
  rawHtml?: boolean,
): Promise<void> {
  const { botToken, chatId } = config ?? loadTelegramConfig();

  // Log key content for debugging
  const textPreview =
    text.length > 300
      ? `${text.slice(0, 300)}… (${text.length - 300} more chars)`
      : text;
  log.debug("sending telegram notification", {
    textLength: text.length,
    rawHtml,
    chatId: `${chatId.slice(0, 4)}…`,
    textPreview,
  });

  const body = {
    chat_id: chatId,
    text: rawHtml ? text : escapeHtml(text),
    parse_mode: "HTML",
  };

  const url = buildTelegramUrl(botToken, "sendMessage");
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  // Try to extract the response body for diagnostics, even on error
  let responseBody: {
    ok?: boolean;
    description?: string;
    error_code?: number;
  } | null = null;
  try {
    responseBody = (await response.json()) as {
      ok?: boolean;
      description?: string;
      error_code?: number;
    };
  } catch {
    // Response body is not JSON — use status text only
  }

  if (!response.ok) {
    const description = responseBody?.description
      ? `: ${responseBody.description}`
      : "";
    // Log the error with full response details
    log.warn("telegram sendMessage HTTP error", {
      status: response.status,
      statusText: response.statusText,
      description: responseBody?.description,
      textLength: text.length,
      textPreview,
    });
    throw new TelegramError(
      `sendMessage failed: ${response.status} ${response.statusText}${description}`,
      {
        method: "sendMessage",
        status: response.status,
        description: responseBody?.description,
      },
    );
  }

  if (!responseBody?.ok) {
    log.warn("telegram sendMessage API rejected", {
      description: responseBody?.description,
      textLength: text.length,
      textPreview,
    });
    throw new TelegramError(
      `sendMessage rejected: ${responseBody?.description ?? "unknown"}`,
      { method: "sendMessage", description: responseBody?.description },
    );
  }

  log.debug("telegram notification sent", {
    textLength: text.length,
    ok: responseBody?.ok,
  });
}
