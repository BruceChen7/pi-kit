import os from "node:os";
import path from "node:path";

import { createTelegramPollPaths, pollTelegramUpdates } from "./poll.ts";

export type TelegramInlineButton = {
  text: string;
  callback_data: string;
};

export type TelegramClient = ReturnType<typeof createTelegramClient>;

export class TelegramClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramClientError";
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

export const buildTelegramUrl = (botToken: string, method: string): string =>
  `https://api.telegram.org/bot${botToken}/${method}`;

export const requestTelegram = async <T>({
  botToken,
  method,
  body,
}: TelegramRequestOptions): Promise<T> => {
  const response = await fetch(buildTelegramUrl(botToken, method), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new TelegramClientError(
      `${method} failed: ${response.status} ${response.statusText}`,
    );
  }

  const payload = (await response.json()) as {
    ok?: boolean;
    result?: T;
    description?: string;
  };

  if (!payload.ok || payload.result === undefined) {
    throw new TelegramClientError(
      `${method} failed: ${payload.description ?? "Unknown Telegram error"}`,
    );
  }

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
      return sendTextMessage({
        chat_id: input.chatId,
        text,
        parse_mode: parseMode,
        reply_markup: buildReplyMarkup(buttons),
      });
    },

    async editMessage(
      messageId: number,
      { text, buttons, parseMode = "HTML" }: SendMessageInput,
    ): Promise<void> {
      await requestTelegram({
        botToken: input.botToken,
        method: "editMessageText",
        body: {
          chat_id: input.chatId,
          message_id: messageId,
          text,
          parse_mode: parseMode,
          reply_markup: buildReplyMarkup(buttons),
        },
      });
    },

    async sendReplyPrompt(messageId: number, text: string): Promise<number> {
      return sendTextMessage({
        chat_id: input.chatId,
        text,
        parse_mode: "HTML",
        reply_to_message_id: messageId,
        reply_markup: {
          force_reply: true,
          selective: true,
        },
      });
    },

    async sendReply(
      messageId: number,
      text: string,
      parseMode = "HTML",
    ): Promise<number> {
      return sendTextMessage({
        chat_id: input.chatId,
        text,
        parse_mode: parseMode,
        reply_to_message_id: messageId,
      });
    },

    async poll(acceptedMessageIds: Iterable<number>) {
      return pollTelegramUpdates({
        paths: pollPaths,
        acceptedMessageIds,
        acceptedChatId: input.chatId,
        ttlMs: 10 * 60 * 1000,
        requestUpdates: async (offset) => {
          const result = await requestTelegram<Array<Record<string, unknown>>>({
            botToken: input.botToken,
            method: "getUpdates",
            body: {
              offset,
              timeout: 0,
              allowed_updates: ["callback_query", "message"],
            },
          });
          return result;
        },
      });
    },
  };
};
