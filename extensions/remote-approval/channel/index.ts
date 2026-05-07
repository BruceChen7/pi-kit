import type { RemoteApprovalConfig } from "../config.ts";
import { createTelegramClient } from "./telegram/client.ts";
import type { RemoteChannel, RemoteChannelError } from "./types.ts";

export const createRemoteChannel = (
  config: RemoteApprovalConfig,
): {
  channel: RemoteChannel | null;
  error: RemoteChannelError | null;
} => {
  if (!config.botToken || !config.chatId) {
    return {
      channel: null,
      error: {
        reason: `Telegram config incomplete (botToken ${config.botToken ? "set" : "missing"}, chatId ${config.chatId ? "set" : "missing"})`,
      },
    };
  }

  const requestTtlMs = config.requestTtlSeconds * 1000;

  return {
    channel: createTelegramClient({
      botToken: config.botToken,
      chatId: config.chatId,
      requestTtlMs,
    }),
    error: null,
  };
};
