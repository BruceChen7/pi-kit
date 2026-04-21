import { describe, expect, it, vi } from "vitest";

import {
  canSendTerminalLineInput,
  submitTerminalLineInput,
} from "./line-input";

const runtimeWithSession = {
  cardId: "child-pricing-widget",
  lane: "In Progress",
  session: {
    chatJid: "chat:child-pricing-widget",
    worktreePath: "/tmp/wt/child-pricing-widget",
  },
  execution: {
    status: "running",
    summary: "running",
    requestId: "task-1",
  },
  completion: {
    readyForReview: false,
    completedAt: null,
  },
  terminal: {
    available: true,
    protocol: "sse-text-stream",
    streamUrl: "/kanban/cards/child-pricing-widget/terminal/stream",
  },
} as const;

describe("terminal line input", () => {
  it("allows sending when the card has an active session", () => {
    expect(
      canSendTerminalLineInput({
        cardId: "child-pricing-widget",
        runtimeDetail: runtimeWithSession,
        unavailableMessage: null,
        terminalInput: "continue",
        submittingInput: false,
      }),
    ).toBe(true);
  });

  it("disables sending when there is no active session", () => {
    expect(
      canSendTerminalLineInput({
        cardId: "child-pricing-widget",
        runtimeDetail: {
          ...runtimeWithSession,
          session: null,
        },
        unavailableMessage: null,
        terminalInput: "continue",
        submittingInput: false,
      }),
    ).toBe(false);
  });

  it("blocks duplicate submissions while a line input request is pending", async () => {
    const sendTerminalInput = vi.fn(async () => {
      throw new Error("should not be called while pending");
    });

    await expect(
      submitTerminalLineInput({
        cardId: "child-pricing-widget",
        runtimeDetail: runtimeWithSession,
        unavailableMessage: null,
        terminalInput: "continue",
        submittingInput: true,
        sendTerminalInput,
      }),
    ).resolves.toEqual({
      accepted: false,
      nextValue: "continue",
      error: null,
    });
    expect(sendTerminalInput).not.toHaveBeenCalled();
  });

  it("clears the input after a successful send", async () => {
    const sendTerminalInput = vi.fn(async () => {});

    await expect(
      submitTerminalLineInput({
        cardId: "child-pricing-widget",
        runtimeDetail: runtimeWithSession,
        unavailableMessage: null,
        terminalInput: "continue",
        submittingInput: false,
        sendTerminalInput,
      }),
    ).resolves.toEqual({
      accepted: true,
      nextValue: "",
      error: null,
    });
    expect(sendTerminalInput).toHaveBeenCalledWith(
      "child-pricing-widget",
      "continue",
    );
  });

  it("surfaces send failures without clearing the current input", async () => {
    const sendTerminalInput = vi.fn(async () => {
      throw new Error("send failed");
    });

    await expect(
      submitTerminalLineInput({
        cardId: "child-pricing-widget",
        runtimeDetail: runtimeWithSession,
        unavailableMessage: null,
        terminalInput: "continue",
        submittingInput: false,
        sendTerminalInput,
      }),
    ).resolves.toEqual({
      accepted: false,
      nextValue: "continue",
      error: "send failed",
    });
  });
});
