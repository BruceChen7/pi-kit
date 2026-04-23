import type { TelegramInlineButton } from "./telegram/client.ts";

export type RemoteChannelError = {
  reason: string;
};

export type RemoteChannel = {
  sendMessage(input: {
    text: string;
    buttons?: TelegramInlineButton[][];
    parseMode?: string;
  }): Promise<number>;
  editMessage(
    messageId: number,
    input: {
      text: string;
      buttons?: TelegramInlineButton[][];
      parseMode?: string;
    },
  ): Promise<void>;
  sendReplyPrompt(messageId: number, text: string): Promise<number>;
  sendReply(
    messageId: number,
    text: string,
    parseMode?: string,
  ): Promise<number>;
  poll(acceptedMessageIds: Iterable<number>): Promise<
    | {
        type: "callback";
        data: string;
        update: Record<string, unknown>;
      }
    | {
        type: "text";
        text: string;
        update: Record<string, unknown>;
      }
    | null
  >;
};
