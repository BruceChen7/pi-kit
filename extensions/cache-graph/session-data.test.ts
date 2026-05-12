import { describe, expect, it } from "vitest";
import { collectCacheSessionMetrics } from "./session-data.ts";

const assistantEntry = (id: string, input: number, cacheRead: number) => ({
  id,
  type: "message" as const,
  timestamp: "2026-05-12T00:00:00.000Z",
  message: {
    role: "assistant" as const,
    provider: "anthropic",
    model: "claude",
    usage: {
      input,
      output: 10,
      cacheRead,
      cacheWrite: 5,
      totalTokens: input + cacheRead + 15,
    },
  },
});

const userEntry = {
  id: "user",
  type: "message" as const,
  timestamp: "2026-05-12T00:00:00.000Z",
  message: { role: "user" as const, content: "hello" },
};

describe("collectCacheSessionMetrics", () => {
  it("collects assistant usage and active branch totals", () => {
    const first = assistantEntry("a1", 100, 50);
    const second = assistantEntry("a2", 40, 0);
    const metrics = collectCacheSessionMetrics({
      getEntries: () => [userEntry, first, second] as never,
      getBranch: () => [userEntry, second] as never,
    });

    expect(metrics.allMessages).toHaveLength(2);
    expect(metrics.activeBranchMessages).toHaveLength(1);
    expect(metrics.activeBranchMessages[0].entryId).toBe("a2");
    expect(metrics.treeTotals.assistantMessages).toBe(2);
    expect(metrics.treeTotals.cacheRead).toBe(50);
    expect(metrics.activeBranchTotals.input).toBe(40);
  });
});
