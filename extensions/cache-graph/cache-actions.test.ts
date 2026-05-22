import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { collectAllRepoCacheMetricsWithArchive } from "./archive-metrics.ts";
import { createCacheStatsActions } from "./cache-actions.ts";
import type { CacheSessionMetrics } from "./types.ts";

const metrics: CacheSessionMetrics = {
  allMessages: [],
  activeBranchMessages: [],
  treeTotals: {
    input: 10,
    output: 2,
    cacheRead: 5,
    cacheWrite: 0,
    totalTokens: 17,
    assistantMessages: 1,
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

vi.mock("./archive-metrics.ts", () => ({
  collectAllRepoCacheMetricsWithArchive: vi.fn(async () => ({
    metrics,
    diagnostics: {
      filesScanned: 0,
      entriesParsed: 0,
      metricsLoadedFromArchive: 1,
      metricsParsedFromSessions: 0,
      sessionFilesLoadedFromArchive: 1,
      sessionFilesParsed: 0,
      sessionFilesRebuilt: 0,
      sessionFilesSkipped: 0,
    },
  })),
}));

describe("createCacheStatsActions", () => {
  it("uses the incremental archive provider for metrics and export", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cache-actions-"));
    const actions = createCacheStatsActions({
      cwd: dir,
      sessionManager: {
        getSessionName: () => "Session",
        getSessionFile: () => undefined,
      },
    });

    await expect(actions.getMetrics()).resolves.toEqual(metrics);
    const filePath = await actions.exportCsv();
    const csv = await readFile(filePath, "utf8");

    expect(collectAllRepoCacheMetricsWithArchive).toHaveBeenCalledTimes(2);
    expect(csv).toContain("whole_tree");
    expect(csv).toContain("17");
  });
});
