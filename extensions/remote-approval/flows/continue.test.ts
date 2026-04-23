import { describe, expect, it, vi } from "vitest";

import { queueRemoteInstruction } from "./continue.ts";

describe("remote-approval continue flow", () => {
  it("starts a new turn immediately when pi is idle", () => {
    const sendUserMessage = vi.fn();

    const result = queueRemoteInstruction(
      { sendUserMessage },
      {
        isIdle: () => true,
      },
      "continue with deploy",
    );

    expect(result).toBe("started");
    expect(sendUserMessage).toHaveBeenCalledWith("continue with deploy");
  });

  it("queues a follow-up when pi is already busy", () => {
    const sendUserMessage = vi.fn();

    const result = queueRemoteInstruction(
      { sendUserMessage },
      {
        isIdle: () => false,
      },
      "continue with deploy",
    );

    expect(result).toBe("queued");
    expect(sendUserMessage).toHaveBeenCalledWith("continue with deploy", {
      deliverAs: "followUp",
    });
  });
});
