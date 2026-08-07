import { describe, expect, it } from "vitest";
import { extractAssistantSummary } from "./summary-extractor.ts";

/**
 * Build a minimal `message_end` assistant event for a given text.
 */
function assistantEvent(text: string): string {
  return JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

describe("extractAssistantSummary", () => {
  it("returns the last assistant text from the event stream", () => {
    const stdout = [
      JSON.stringify({ type: "message_start", message: { role: "user" } }),
      assistantEvent("first"),
      assistantEvent("final answer"),
    ].join("\n");

    expect(extractAssistantSummary(stdout)).toBe("final answer");
  });

  it("joins multiple text parts of the same message with newlines", () => {
    const stdout = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "part one" },
          { type: "thinking", thinking: "ignored" },
          { type: "text", text: "part two" },
        ],
      },
    });

    expect(extractAssistantSummary(stdout)).toBe("part one\npart two");
  });

  it("ignores non-assistant events and non-JSON lines", () => {
    const stdout = [
      "not json at all",
      JSON.stringify({ type: "message_end", message: { role: "user" } }),
      JSON.stringify({ type: "tool_use", name: "bash" }),
    ].join("\n");

    expect(extractAssistantSummary(stdout)).toBeUndefined();
  });

  it("skips assistant messages with empty text", () => {
    const stdout = [
      assistantEvent(""),
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [] },
      }),
      assistantEvent("real answer"),
    ].join("\n");

    expect(extractAssistantSummary(stdout)).toBe("real answer");
  });

  it("returns undefined for empty or whitespace-only output", () => {
    expect(extractAssistantSummary("")).toBeUndefined();
    expect(extractAssistantSummary("   \n  ")).toBeUndefined();
  });
});
