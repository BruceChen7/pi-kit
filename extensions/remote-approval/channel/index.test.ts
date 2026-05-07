import { describe, expect, it, vi } from "vitest";

import type { RemoteApprovalConfig } from "../config.ts";
import { createRemoteChannel } from "./index.ts";
import { createTelegramClient } from "./telegram/client.ts";

vi.mock("./telegram/client.ts", () => ({
  createTelegramClient: vi.fn(() => ({
    sendMessage: vi.fn(async () => 42),
    editMessage: vi.fn(async () => undefined),
  })),
}));

describe("remote-approval channel factory", () => {
  const baseConfig: RemoteApprovalConfig = {
    enabled: true,
    channelType: "telegram",
    botToken: "token",
    chatId: "chat",
    strictRemote: false,
    interceptTools: ["bash", "write", "edit"],
    extraInterceptTools: [],
    idleEnabled: true,
    continueEnabled: true,
    contextTurns: 3,
    contextMaxChars: 200,
    approvalTimeoutMs: 0,
    requestTtlSeconds: 600,
  };

  it("returns a telegram-backed channel when credentials are available", () => {
    const result = createRemoteChannel(baseConfig);

    expect(result.error).toBeNull();
    expect(result.channel).not.toBeNull();
  });

  it("passes configured request TTL to the telegram client", () => {
    createRemoteChannel({
      ...baseConfig,
      requestTtlSeconds: 123,
    });

    expect(createTelegramClient).toHaveBeenCalledWith({
      botToken: "token",
      chatId: "chat",
      requestTtlMs: 123_000,
    });
  });

  it("returns a typed error when telegram credentials are missing", () => {
    const result = createRemoteChannel({
      ...baseConfig,
      botToken: null,
      chatId: null,
    });

    expect(result.channel).toBeNull();
    expect(result.error).toMatchObject({
      reason: "Telegram config incomplete (botToken missing, chatId missing)",
    });
  });
});
