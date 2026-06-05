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
 * Usage:
 * ```ts
 * import { sendTelegramNotification } from "../../shared/telegram.ts";
 * await sendTelegramNotification("📑 X Bookmarks\n\nfetched 50 bookmarks");
 * ```
 */
export async function sendTelegramNotification(
  text: string,
  config?: TelegramConfig,
): Promise<void> {
  const { botToken, chatId } = config ?? loadTelegramConfig();

  const body = {
    chat_id: chatId,
    text: escapeHtml(text),
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
