import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildTelegramUrl,
  createTelegramClient,
  TelegramClientError,
} from "./client.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalFetch) {
    globalThis.fetch = originalFetch;
  }
});

describe("remote-approval telegram client", () => {
  it("builds bot api urls from token and method", () => {
    expect(buildTelegramUrl("123:abc", "sendMessage")).toBe(
      "https://api.telegram.org/bot123:abc/sendMessage",
    );
  });

  it("sends messages and returns the telegram message id", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            result: { message_id: 42 },
          }),
          { status: 200 },
        ),
    ) as typeof fetch;

    const client = createTelegramClient({
      botToken: "123:abc",
      chatId: "1001",
    });

    const messageId = await client.sendMessage({
      text: "hello",
      buttons: [[{ text: "Allow", callback_data: "allow" }]],
    });

    expect(messageId).toBe(42);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.telegram.org/bot123:abc/sendMessage",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: "1001",
          text: "hello",
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [[{ text: "Allow", callback_data: "allow" }]],
          },
        }),
      }),
    );
  });

  it("sends a force-reply prompt anchored to an existing telegram message", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            result: { message_id: 55 },
          }),
          { status: 200 },
        ),
    ) as typeof fetch;

    const client = createTelegramClient({
      botToken: "123:abc",
      chatId: "1001",
    });

    const messageId = await client.sendReplyPrompt(
      42,
      "Reply with your next instruction",
    );

    expect(messageId).toBe(55);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.telegram.org/bot123:abc/sendMessage",
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: "1001",
          text: "Reply with your next instruction",
          parse_mode: "HTML",
          reply_to_message_id: 42,
          reply_markup: {
            force_reply: true,
            selective: true,
          },
        }),
      }),
    );
  });

  it("sends a plain reply anchored to an existing telegram message", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            result: { message_id: 66 },
          }),
          { status: 200 },
        ),
    ) as typeof fetch;

    const client = createTelegramClient({
      botToken: "123:abc",
      chatId: "1001",
    });

    const messageId = await client.sendReply(42, "assistant: detailed context");

    expect(messageId).toBe(66);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.telegram.org/bot123:abc/sendMessage",
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: "1001",
          text: "assistant: detailed context",
          parse_mode: "HTML",
          reply_to_message_id: 42,
        }),
      }),
    );
  });

  it("throws a typed error when telegram returns a failed payload", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ ok: false, description: "Bad Request: broken" }),
          { status: 200 },
        ),
    ) as typeof fetch;

    const client = createTelegramClient({
      botToken: "123:abc",
      chatId: "1001",
    });

    await expect(
      client.editMessage(10, { text: "updated", buttons: [] }),
    ).rejects.toBeInstanceOf(TelegramClientError);
    await expect(
      client.editMessage(10, { text: "updated", buttons: [] }),
    ).rejects.toThrow("editMessageText failed: Bad Request: broken");
  });
});
