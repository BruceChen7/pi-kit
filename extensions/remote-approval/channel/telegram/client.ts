import os from "node:os";
import path from "node:path";

import { createLogger } from "../../../shared/logger.ts";
import { createTelegramPollPaths, pollTelegramUpdates } from "./poll.ts";

export type TelegramInlineButton = {
  text: string;
  callback_data: string;
};

export type TelegramClient = ReturnType<typeof createTelegramClient>;

export class TelegramClientError extends Error {
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
    this.name = "TelegramClientError";
    this.method = details?.method;
    this.status = details?.status;
    this.description = details?.description;
  }
}

type TelegramRequestOptions = {
  botToken: string;
  method: string;
  body: Record<string, unknown>;
};

type SendMessageInput = {
  text: string;
  buttons?: TelegramInlineButton[][];
  parseMode?: string;
};

type TelegramRequestLogData = {
  method: string;
  chatId?: string;
  messageId?: number;
  replyToMessageId?: number;
  parseMode?: string;
  textLength?: number;
  hasReplyMarkup?: boolean;
  buttonRows?: number;
  buttonCount?: number;
  offset?: number;
  allowedUpdatesCount?: number;
  status?: number;
  description?: string;
  resultType?: string;
  acceptedMessageCount?: number;
  error?: string;
};

const log = createLogger("remote-approval", { stderr: null });

const toOptionalString = (value: unknown): string | undefined =>
  typeof value === "string"
    ? value
    : typeof value === "number"
      ? String(value)
      : undefined;

const toOptionalNumber = (value: unknown): number | undefined =>
  typeof value === "number" ? value : undefined;

const summarizeReplyMarkup = (
  value: unknown,
): Pick<
  TelegramRequestLogData,
  "hasReplyMarkup" | "buttonRows" | "buttonCount"
> => {
  if (!value || typeof value !== "object") {
    return {
      hasReplyMarkup: false,
    };
  }

  const inlineKeyboard = (value as { inline_keyboard?: unknown })
    .inline_keyboard;
  if (!Array.isArray(inlineKeyboard)) {
    return {
      hasReplyMarkup: true,
    };
  }

  const buttonRows = inlineKeyboard.length;
  const buttonCount = inlineKeyboard.reduce(
    (count, row) => count + (Array.isArray(row) ? row.length : 0),
    0,
  );

  return {
    hasReplyMarkup: true,
    buttonRows,
    buttonCount,
  };
};

const stripUndefined = <T extends Record<string, unknown>>(data: T): T =>
  Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined),
  ) as T;

const summarizeTelegramBody = (
  method: string,
  body: Record<string, unknown>,
): TelegramRequestLogData =>
  stripUndefined({
    method,
    chatId: toOptionalString(body.chat_id),
    messageId: toOptionalNumber(body.message_id),
    replyToMessageId: toOptionalNumber(body.reply_to_message_id),
    parseMode:
      typeof body.parse_mode === "string" ? body.parse_mode : undefined,
    textLength: typeof body.text === "string" ? body.text.length : undefined,
    offset: toOptionalNumber(body.offset),
    allowedUpdatesCount: Array.isArray(body.allowed_updates)
      ? body.allowed_updates.length
      : undefined,
    ...summarizeReplyMarkup(body.reply_markup),
  });

const escapeTelegramHtml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const formatTelegramText = (text: string, parseMode?: string): string =>
  parseMode === "HTML" ? escapeTelegramHtml(text) : text;

export const buildTelegramUrl = (botToken: string, method: string): string =>
  `https://api.telegram.org/bot${botToken}/${method}`;

export const requestTelegram = async <T>({
  botToken,
  method,
  body,
}: TelegramRequestOptions): Promise<T> => {
  const logData = summarizeTelegramBody(method, body);
  log.debug("telegram_api_request_started", logData);

  let response: Response;
  try {
    response = await fetch(buildTelegramUrl(botToken, method), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    log.error("telegram_api_request_failed", {
      ...logData,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  if (!response.ok) {
    log.warn("telegram_api_http_error", {
      ...logData,
      status: response.status,
    });
    throw new TelegramClientError(
      `${method} failed: ${response.status} ${response.statusText}`,
      {
        method,
        status: response.status,
        description: response.statusText,
      },
    );
  }

  const payload = (await response.json()) as {
    ok?: boolean;
    result?: T;
    description?: string;
  };

  if (!payload.ok || payload.result === undefined) {
    const description = payload.description ?? "Unknown Telegram error";
    log.warn("telegram_api_request_rejected", {
      ...logData,
      description,
    });
    throw new TelegramClientError(`${method} failed: ${description}`, {
      method,
      description,
    });
  }

  log.debug("telegram_api_request_succeeded", {
    ...logData,
    status: response.status,
    resultType: typeof payload.result,
  });

  return payload.result;
};

export const createTelegramClient = (input: {
  botToken: string;
  chatId: string;
}) => {
  const buildReplyMarkup = (buttons?: TelegramInlineButton[][]) =>
    buttons && buttons.length > 0
      ? {
          inline_keyboard: buttons,
        }
      : undefined;

  const pollPaths = createTelegramPollPaths(
    path.join(os.tmpdir(), "pi-kit", "remote-approval", "telegram"),
  );

  const sendTextMessage = async (
    body: Record<string, unknown>,
  ): Promise<number> => {
    const result = await requestTelegram<{ message_id?: number }>({
      botToken: input.botToken,
      method: "sendMessage",
      body,
    });

    if (typeof result.message_id !== "number") {
      throw new TelegramClientError(
        "sendMessage failed: Telegram response missing message_id",
      );
    }
    return result.message_id;
  };

  return {
    async sendMessage({
      text,
      buttons,
      parseMode = "HTML",
    }: SendMessageInput): Promise<number> {
      const body = {
        chat_id: input.chatId,
        text: formatTelegramText(text, parseMode),
        parse_mode: parseMode,
        reply_markup: buildReplyMarkup(buttons),
      };
      log.debug(
        "telegram_client_send_message",
        summarizeTelegramBody("sendMessage", body),
      );
      return sendTextMessage(body);
    },

    async editMessage(
      messageId: number,
      { text, buttons, parseMode = "HTML" }: SendMessageInput,
    ): Promise<void> {
      const body = {
        chat_id: input.chatId,
        message_id: messageId,
        text: formatTelegramText(text, parseMode),
        parse_mode: parseMode,
        reply_markup: buildReplyMarkup(buttons),
      };
      log.debug(
        "telegram_client_edit_message",
        summarizeTelegramBody("editMessageText", body),
      );
      await requestTelegram({
        botToken: input.botToken,
        method: "editMessageText",
        body,
      });
    },

    async sendReplyPrompt(messageId: number, text: string): Promise<number> {
      const body = {
        chat_id: input.chatId,
        text: formatTelegramText(text, "HTML"),
        parse_mode: "HTML",
        reply_to_message_id: messageId,
        reply_markup: {
          force_reply: true,
          selective: true,
        },
      };
      log.debug(
        "telegram_client_send_reply_prompt",
        summarizeTelegramBody("sendMessage", body),
      );
      return sendTextMessage(body);
    },

    async sendReply(
      messageId: number,
      text: string,
      parseMode = "HTML",
    ): Promise<number> {
      const body = {
        chat_id: input.chatId,
        text: formatTelegramText(text, parseMode),
        parse_mode: parseMode,
        reply_to_message_id: messageId,
      };
      log.debug(
        "telegram_client_send_reply",
        summarizeTelegramBody("sendMessage", body),
      );
      return sendTextMessage(body);
    },

    async poll(acceptedMessageIds: Iterable<number>) {
      const acceptedIds = Array.from(acceptedMessageIds);
      log.debug("telegram_client_poll", {
        acceptedMessageCount: acceptedIds.length,
      });
      return pollTelegramUpdates({
        paths: pollPaths,
        acceptedMessageIds: acceptedIds,
        acceptedChatId: input.chatId,
        ttlMs: 10 * 60 * 1000,
        requestUpdates: async (offset) => {
          try {
            const result = await requestTelegram<Array<Record<string, unknown>>>(
              {
                botToken: input.botToken,
                method: "getUpdates",
                body: {
                  offset,
                  timeout: 0,
                  allowed_updates: ["callback_query", "message"],
                },
              },
            );
            return result;
          } catch (error) {
            if (
              error instanceof TelegramClientError &&
              error.method === "getUpdates" &&
              error.status === 409
            ) {
              log.warn("telegram_client_poll_conflict", {
                offset,
                acceptedMessageCount: acceptedIds.length,
                status: error.status,
                description: error.description,
              });
              return [];
            }
            throw error;
          }
        },
      });
    },
  };
};
