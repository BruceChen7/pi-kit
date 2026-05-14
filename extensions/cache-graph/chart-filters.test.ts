import { describe, expect, it } from "vitest";
import { filterRowsForGraph } from "./chart-filters.ts";
import type { AssistantUsageMetric } from "./types.ts";

function metric(
  repoSlug: string,
  timestamp: string,
  sequence: number,
): AssistantUsageMetric {
  return {
    sequence,
    activeBranchSequence: undefined,
    entryId: `${repoSlug}-${sequence}`,
    repoSlug,
    timestamp,
    provider: "anthropic",
    model: "claude",
    input: 10,
    output: 5,
    cacheRead: 20,
    cacheWrite: 0,
    totalTokens: 35,
    cacheHitPercent: 66.7,
    isOnActiveBranch: false,
  };
}

describe("filterRowsForGraph", () => {
  it("filters all-repo metrics by repo and anchored date range", () => {
    const rows = [
      metric("repo-a", "2026-05-07T23:59:59.000Z", 1),
      metric("repo-a", "2026-05-08T00:00:00.000Z", 2),
      metric("repo-b", "2026-05-10T12:00:00.000Z", 3),
      metric("repo-a", "2026-05-14T23:59:59.000Z", 4),
      metric("repo-a", "2026-05-15T00:00:00.000Z", 5),
    ];

    const filtered = filterRowsForGraph(rows, {
      repo: "repo-a",
      anchorDate: "2026-05-14",
      range: "7d",
    });

    expect(filtered.map((row) => row.entryId)).toEqual([
      "repo-a-2",
      "repo-a-4",
    ]);
  });

  it("treats today as the selected calendar day", () => {
    const rows = [
      metric("repo-a", "2026-05-13T23:59:59.000Z", 1),
      metric("repo-b", "2026-05-14T12:00:00.000Z", 2),
      metric("repo-a", "2026-05-15T00:00:00.000Z", 3),
    ];

    const filtered = filterRowsForGraph(rows, {
      repo: "all",
      anchorDate: "2026-05-14",
      range: "today",
    });

    expect(filtered.map((row) => row.entryId)).toEqual(["repo-b-2"]);
  });
});
