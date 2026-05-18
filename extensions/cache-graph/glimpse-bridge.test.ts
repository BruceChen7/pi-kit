import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { GlimpseWindow } from "../shared/glimpse-window.ts";
import { attachCacheGraphBridge } from "./glimpse-bridge.ts";
import type { CacheSessionMetrics } from "./types.ts";

class FakeGlimpseWindow extends EventEmitter implements GlimpseWindow {
  sent: string[] = [];

  send(js: string): void {
    this.sent.push(js);
  }

  emitMessage(message: unknown): void {
    this.emit("message", message);
  }
}

const waitForBridge = () => new Promise((resolve) => setImmediate(resolve));

const emptyMetrics: CacheSessionMetrics = {
  allMessages: [],
  activeBranchMessages: [],
  treeTotals: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    assistantMessages: 0,
  },
  activeBranchTotals: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    assistantMessages: 0,
  },
};

describe("attachCacheGraphBridge", () => {
  it("sends refreshed metrics to the Glimpse page", async () => {
    const window = new FakeGlimpseWindow();
    attachCacheGraphBridge({
      window,
      getMetrics: () => emptyMetrics,
      exportCsv: vi.fn(),
    });

    window.emitMessage({ type: "refresh" });
    await waitForBridge();

    expect(window.sent[0]).toContain('"type":"metrics"');
    expect(window.sent[0]).toContain("cache-graph:metrics");
  });

  it("reports export failures without throwing to the host", async () => {
    const window = new FakeGlimpseWindow();
    attachCacheGraphBridge({
      window,
      getMetrics: () => emptyMetrics,
      exportCsv: async () => {
        throw new Error("disk full");
      },
    });

    window.emitMessage({ type: "export" });
    await waitForBridge();

    expect(window.sent[0]).toContain("cache-graph:error");
    expect(window.sent[0]).toContain("disk full");
  });

  it("sends the shared export success message", async () => {
    const window = new FakeGlimpseWindow();
    attachCacheGraphBridge({
      window,
      getMetrics: () => emptyMetrics,
      exportCsv: async () => "/tmp/session.csv",
    });

    window.emitMessage({ type: "export" });
    await waitForBridge();

    expect(window.sent[0]).toContain("cache-graph:export-result");
    expect(window.sent[0]).toContain(
      "Exported cache stats CSV to /tmp/session.csv",
    );
  });
});
