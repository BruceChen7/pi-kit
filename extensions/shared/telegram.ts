import { loadSettings } from "./settings.ts";

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

  // 4. Convert headings (most # first to avoid partial matches)
  processed = processed.replace(/^### (.+)$/gm, "<b>$1</b>");
  processed = processed.replace(/^## (.+)$/gm, "<b>$1</b>");
  processed = processed.replace(/^# (.+)$/gm, "<b>$1</b>");

  // 5. Convert bold
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
 */
export function loadTelegramConfig(): TelegramConfig {
  const { global } = loadSettings(process.cwd());
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

  const body = {
    chat_id: chatId,
    text: rawHtml ? text : escapeHtml(text),
    parse_mode: "HTML",
  };

  const response = await fetch(buildTelegramUrl(botToken, "sendMessage"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new TelegramError(
      `sendMessage failed: ${response.status} ${response.statusText}`,
      { method: "sendMessage", status: response.status },
    );
  }

  const payload = (await response.json()) as {
    ok?: boolean;
    description?: string;
  };

  if (!payload.ok) {
    throw new TelegramError(
      `sendMessage rejected: ${payload.description ?? "unknown"}`,
      { method: "sendMessage", description: payload.description },
    );
  }
}
