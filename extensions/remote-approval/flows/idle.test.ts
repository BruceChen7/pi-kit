import { describe, expect, it, vi } from "vitest";

import { createRequestStore } from "../runtime/request-store.ts";
import { runIdleContinueFlow } from "./idle.ts";

describe("remote-approval idle flow", () => {
  it("continues a remote idle request by prompting for reply text and injecting a new user message", async () => {
    const requestStore = createRequestStore(() => 100);
    const sendMessage = vi.fn(async () => 41);
    const sendReplyPrompt = vi.fn(async () => 55);
    const editMessage = vi.fn(async () => undefined);
    const poll = vi
      .fn()
      .mockResolvedValueOnce({ type: "callback", data: "idle:continue" })
      .mockResolvedValueOnce({ type: "text", text: "continue with deploy" });
    const sendUserMessage = vi.fn();

    const result = await runIdleContinueFlow({
      requestStore,
      channel: {
        sendMessage,
        sendReplyPrompt,
        editMessage,
        poll,
      },
      pi: {
        sendUserMessage,
      },
      executionContext: {
        isIdle: () => true,
      },
      request: {
        requestId: "idle_1",
        sessionId: "session-1",
        sessionLabel: "pi-kit · session-1",
        assistantSummary: "Work finished.",
        contextPreview: ["assistant: Work finished."],
        continueEnabled: true,
        fullContextAvailable: false,
      },
      sleep: async () => undefined,
    });

    expect(result).toMatchObject({
      requestId: "idle_1",
      status: "continued",
      resolutionSource: "remote",
      messageId: 41,
      replyPromptMessageId: 55,
      continueResult: "started",
    });
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("💤 Agent idle"),
        buttons: expect.arrayContaining([
          expect.arrayContaining([
            expect.objectContaining({ callback_data: "idle:continue" }),
            expect.objectContaining({ callback_data: "idle:dismiss" }),
          ]),
        ]),
      }),
    );
    expect(sendReplyPrompt).toHaveBeenCalledWith(
      41,
      expect.stringContaining("Reply with your next instruction"),
    );
    expect(poll).toHaveBeenNthCalledWith(1, [41]);
    expect(poll).toHaveBeenNthCalledWith(2, [41, 55]);
    expect(sendUserMessage).toHaveBeenCalledWith("continue with deploy");
    expect(editMessage).toHaveBeenLastCalledWith(
      41,
      expect.objectContaining({
        text: expect.stringContaining("✅ Resumed"),
        buttons: [],
      }),
    );
    expect(requestStore.get("idle_1")?.status).toBe("continued");
  });

  it("dismisses a remote idle request without injecting a follow-up instruction", async () => {
    const requestStore = createRequestStore(() => 100);
    const sendMessage = vi.fn(async () => 42);
    const editMessage = vi.fn(async () => undefined);
    const poll = vi.fn().mockResolvedValueOnce({
      type: "callback",
      data: "idle:dismiss",
    });
    const sendUserMessage = vi.fn();

    const result = await runIdleContinueFlow({
      requestStore,
      channel: {
        sendMessage,
        sendReply: vi.fn(async () => 0),
        sendReplyPrompt: vi.fn(async () => 0),
        editMessage,
        poll,
      },
      pi: {
        sendUserMessage,
      },
      executionContext: {
        isIdle: () => true,
      },
      request: {
        requestId: "idle_2",
        sessionId: "session-1",
        sessionLabel: "pi-kit · session-1",
        assistantSummary: "Done.",
        contextPreview: [],
        continueEnabled: true,
        fullContextAvailable: false,
      },
      sleep: async () => undefined,
    });

    expect(result).toMatchObject({
      requestId: "idle_2",
      status: "dismissed",
      resolutionSource: "remote",
      messageId: 42,
      continueResult: null,
    });
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(editMessage).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        text: expect.stringContaining("❌ Dismissed"),
        buttons: [],
      }),
    );
    expect(requestStore.get("idle_2")?.status).toBe("dismissed");
  });

  it("expands full context from the idle message before continuing to wait for dismiss or continue", async () => {
    const requestStore = createRequestStore(() => 100);
    const sendReply = vi.fn(async () => 60);
    const sendMessage = vi.fn(async () => 42);
    const editMessage = vi.fn(async () => undefined);
    const poll = vi
      .fn()
      .mockResolvedValueOnce({ type: "callback", data: "idle:more" })
      .mockResolvedValueOnce({ type: "callback", data: "idle:dismiss" });

    const result = await runIdleContinueFlow({
      requestStore,
      channel: {
        sendMessage,
        sendReply,
        sendReplyPrompt: vi.fn(async () => 0),
        editMessage,
        poll,
      },
      pi: {
        sendUserMessage: vi.fn(),
      },
      executionContext: {
        isIdle: () => true,
      },
      request: {
        requestId: "idle_3",
        sessionId: "session-1",
        sessionLabel: "pi-kit · session-1",
        assistantSummary: "Done.",
        contextPreview: [],
        fullContextLines: ["assistant: line 1", "user: line 2"],
        continueEnabled: true,
        fullContextAvailable: true,
      },
      sleep: async () => undefined,
    });

    expect(result.status).toBe("dismissed");
    expect(sendReply).toHaveBeenCalledTimes(2);
    expect(sendReply).toHaveBeenNthCalledWith(1, 42, "assistant: line 1");
    expect(sendReply).toHaveBeenNthCalledWith(2, 42, "user: line 2");
  });
});
