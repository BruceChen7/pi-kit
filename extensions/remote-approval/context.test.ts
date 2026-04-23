import { describe, expect, it } from "vitest";

import {
  extractContextPreview,
  extractFullContext,
  extractLastAssistantSummary,
} from "./context.ts";

const buildMessageEntry = (
  role: "user" | "assistant",
  text: string,
): {
  type: "message";
  message: {
    role: "user" | "assistant";
    stopReason?: string;
    content: Array<{ type: "text"; text: string }>;
  };
} => ({
  type: "message",
  message: {
    role,
    stopReason: role === "assistant" ? "stop" : undefined,
    content: [{ type: "text", text }],
  },
});

describe("remote-approval context", () => {
  it("extracts the latest turns as preview lines", () => {
    const preview = extractContextPreview(
      [
        buildMessageEntry("user", "first"),
        buildMessageEntry("assistant", "second"),
        buildMessageEntry("user", "third"),
        buildMessageEntry("assistant", "fourth"),
      ],
      { maxTurns: 3, maxChars: 10 },
    );

    expect(preview).toEqual([
      "assistant: second",
      "user: third",
      "assistant: fourth",
    ]);
  });

  it("truncates long messages cleanly", () => {
    const preview = extractContextPreview(
      [buildMessageEntry("assistant", "123456789012345")],
      { maxTurns: 1, maxChars: 8 },
    );

    expect(preview).toEqual(["assistant: 1234567…"]);
  });

  it("extracts the latest assistant summary from completed assistant messages", () => {
    const summary = extractLastAssistantSummary([
      buildMessageEntry("user", "question"),
      buildMessageEntry("assistant", "partial"),
      {
        type: "message",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "final answer" }],
        },
      },
    ]);

    expect(summary).toBe("final answer");
  });

  it("extracts full untruncated context turns for reply-thread expansion", () => {
    const fullContext = extractFullContext(
      [
        buildMessageEntry("user", "first question with lots of detail"),
        buildMessageEntry("assistant", "second answer with lots of detail"),
        buildMessageEntry("user", "third follow-up"),
      ],
      { maxTurns: 2 },
    );

    expect(fullContext).toEqual([
      "assistant: second answer with lots of detail",
      "user: third follow-up",
    ]);
  });
});
