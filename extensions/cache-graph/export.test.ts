import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCsv, exportStatsCsv, sanitizeFileName } from "./export.ts";
import type { CacheSessionMetrics } from "./types.ts";

const metrics: CacheSessionMetrics = {
  allMessages: [
    {
      sequence: 1,
      activeBranchSequence: 1,
      entryId: "entry,1",
      timestamp: "2026-05-12T00:00:00.000Z",
      provider: "provider",
      model: "model",
      input: 10,
      output: 5,
      cacheRead: 5,
      cacheWrite: 0,
      totalTokens: 20,
      cacheHitPercent: 33.333,
      isOnActiveBranch: true,
    },
  ],
  activeBranchMessages: [],
  treeTotals: {
    input: 10,
    output: 5,
    cacheRead: 5,
    cacheWrite: 0,
    totalTokens: 20,
    assistantMessages: 1,
  },
  activeBranchTotals: {
    input: 10,
    output: 5,
    cacheRead: 5,
    cacheWrite: 0,
    totalTokens: 20,
    assistantMessages: 1,
  },
};

describe("cache CSV export", () => {
  it("sanitizes filenames", () => {
    expect(sanitizeFileName(" hello/world ")).toBe("hello-world");
  });

  it("builds escaped CSV rows", () => {
    const csv = buildCsv(metrics);
    expect(csv).toContain("row_type,scope");
    expect(csv).toContain('"entry,1"');
  });

  it("writes CSV using the session name", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cache-graph-"));
    const filePath = await exportStatsCsv(
      dir,
      {
        getSessionName: () => "My Session",
        getSessionFile: () => null,
      } as never,
      metrics,
    );

    expect(path.basename(filePath)).toBe("My-Session.csv");
    expect(await readFile(filePath, "utf8")).toContain("summary");
  });
});
