import { describe, expect, it } from "vitest";
import { buildChartBarDetail, type ChartBarPoint } from "./chart-details.ts";
import type { AssistantUsageMetric } from "./types.ts";

function metric(
  repoSlug: string,
  sequence: number,
  timestamp: string,
  cacheHitPercent: number,
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  },
): AssistantUsageMetric {
  return {
    sequence,
    activeBranchSequence: undefined,
    entryId: `${repoSlug}-${sequence}`,
    repoSlug,
    timestamp,
    provider: "anthropic",
    model: "claude",
    input: tokens.input,
    output: tokens.output,
    cacheRead: tokens.cacheRead,
    cacheWrite: tokens.cacheWrite,
    totalTokens:
      tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
    cacheHitPercent,
    isOnActiveBranch: false,
  };
}

function point(
  sourceStart: number,
  sourceEnd: number,
  value: number,
): ChartBarPoint {
  return { sourceStart, sourceEnd, value };
}

describe("buildChartBarDetail", () => {
  it("builds exact details for one selected turn", () => {
    const rows = [
      metric("repo-a", 7, "2026-05-22T10:00:00.000Z", 75, {
        input: 10,
        output: 5,
        cacheRead: 30,
        cacheWrite: 0,
      }),
    ];

    const detail = buildChartBarDetail(point(0, 0, 75), rows, "per-turn");

    expect(detail).toMatchObject({
      repoLabel: "repo-a",
      turnLabel: "Turn 7",
      messageCount: 1,
      primaryLabel: "Average per-turn cache hit",
      primaryValue: 75,
      primaryUnit: "percent",
      aggregationNote: "Single assistant turn.",
      cacheHitPercent: 75,
    });
    expect(detail?.totals).toMatchObject({
      input: 10,
      output: 5,
      cacheRead: 30,
      cacheWrite: 0,
      totalTokens: 45,
      assistantMessages: 1,
    });
  });

  it("describes averaged per-turn values for aggregated bars", () => {
    const rows = [
      metric("repo-a", 1, "2026-05-22T10:00:00.000Z", 20, {
        input: 20,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
      }),
      metric("repo-a", 2, "2026-05-22T10:01:00.000Z", 60, {
        input: 10,
        output: 5,
        cacheRead: 30,
        cacheWrite: 10,
      }),
    ];

    const detail = buildChartBarDetail(point(0, 1, 40), rows, "per-turn");

    expect(detail).toMatchObject({
      repoLabel: "repo-a",
      turnLabel: "Turns 1-2",
      messageCount: 2,
      primaryValue: 40,
      aggregationNote: "Aggregated 2 turns; value is the average hit rate.",
    });
    expect(detail?.totals.totalTokens).toBe(80);
    expect(detail?.cacheHitPercent).toBeCloseTo(42.86, 2);
  });

  it("uses the range-end value for cumulative charts", () => {
    const rows = [
      metric("repo-a", 1, "2026-05-22T10:00:00.000Z", 20, {
        input: 20,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
      }),
      metric("repo-b", 2, "2026-05-22T10:01:00.000Z", 60, {
        input: 10,
        output: 5,
        cacheRead: 30,
        cacheWrite: 10,
      }),
    ];

    const percentDetail = buildChartBarDetail(
      point(0, 1, 62.5),
      rows,
      "cumulative-percent",
    );
    const tokenDetail = buildChartBarDetail(
      point(0, 1, 70),
      rows,
      "cumulative-total",
    );

    expect(percentDetail).toMatchObject({
      repoLabel: "2 repos",
      primaryLabel: "Cumulative cache hit at range end",
      primaryValue: 62.5,
      aggregationNote: "Aggregated 2 turns; value is taken at the range end.",
    });
    expect(tokenDetail).toMatchObject({
      primaryLabel: "Cumulative prompt tokens at range end",
      primaryValue: 70,
      primaryUnit: "tokens",
    });
  });

  it("returns null when the selected point has no source rows", () => {
    expect(buildChartBarDetail(point(3, 4, 0), [], "per-turn")).toBeNull();
  });
});
