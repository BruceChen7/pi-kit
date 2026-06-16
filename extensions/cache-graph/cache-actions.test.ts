import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { collectAllRepoCacheMetricsWithArchive } from "./archive-metrics.ts";
import {
  createCacheStatsActions,
  deriveDefaultRepoSlug,
} from "./cache-actions.ts";
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

describe("deriveDefaultRepoSlug", () => {
  it("returns slug from a macOS session file path with wrapping hyphens", () => {
    const slug = deriveDefaultRepoSlug(
      "/Users/ming/.pi/agent/sessions/--Users-ming-work-pi-kit--/current.jsonl",
    );
    expect(slug).toBe("work-pi-kit");
  });

  it("returns slug from a macOS session file path without wrapping hyphens", () => {
    const slug = deriveDefaultRepoSlug(
      "/Users/ming/.pi/agent/sessions/Users-ming-work-pi-kit/current.jsonl",
    );
    expect(slug).toBe("work-pi-kit");
  });

  it("returns slug from a Linux-style session file path", () => {
    const slug = deriveDefaultRepoSlug(
      "/home/ming/.pi/agent/sessions/--home-ming-work-pi-kit--/current.jsonl",
    );
    expect(slug).toBe("work-pi-kit");
  });

  it("returns undefined for null session file", () => {
    expect(deriveDefaultRepoSlug(null)).toBeUndefined();
  });

  it("returns undefined for undefined session file", () => {
    expect(deriveDefaultRepoSlug(undefined)).toBeUndefined();
  });

  it("returns the directory name when it does not match a home-directory pattern", () => {
    const slug = deriveDefaultRepoSlug(
      "/tmp/sessions/my-custom-repo/session.jsonl",
    );
    expect(slug).toBe("my-custom-repo");
  });
});

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
