import {
  addToTotals,
  computeCacheHitPercent,
  emptyTotals,
} from "./cache-math.ts";
import type { AssistantUsageMetric, CacheUsageTotals } from "./types.ts";

export type ChartView = "per-turn" | "cumulative-percent" | "cumulative-total";

export type ChartBarPoint = {
  value: number;
  sourceStart: number;
  sourceEnd: number;
};

type PrimaryMetric = {
  label: string;
  value: number;
  unit: "percent" | "tokens";
};

export type ChartBarDetail = {
  repoLabel: string;
  turnLabel: string;
  messageCount: number;
  firstTimestamp: string;
  lastTimestamp: string;
  primaryLabel: string;
  primaryValue: number;
  primaryUnit: "percent" | "tokens";
  aggregationNote: string;
  totals: CacheUsageTotals;
  cacheHitPercent: number;
};

export function buildChartBarDetail(
  point: ChartBarPoint,
  rows: AssistantUsageMetric[],
  view: ChartView,
): ChartBarDetail | null {
  const sourceRows = rows.slice(point.sourceStart, point.sourceEnd + 1);
  const first = sourceRows[0];
  const last = sourceRows[sourceRows.length - 1];
  if (!first || !last) return null;

  const totals = totalsForSourceRows(sourceRows);
  const messageCount = sourceRows.length;
  const primary = primaryMetric(view, point.value);

  return {
    repoLabel: repoLabel(sourceRows),
    turnLabel: turnLabel(first, last),
    messageCount,
    firstTimestamp: first.timestamp,
    lastTimestamp: last.timestamp,
    primaryLabel: primary.label,
    primaryValue: primary.value,
    primaryUnit: primary.unit,
    aggregationNote: aggregationNote(view, messageCount),
    totals,
    cacheHitPercent: computeCacheHitPercent(
      totals.input,
      totals.cacheRead,
      totals.cacheWrite,
    ),
  };
}

function totalsForSourceRows(rows: AssistantUsageMetric[]): CacheUsageTotals {
  const totals = emptyTotals();
  for (const row of rows) {
    addToTotals(totals, row);
  }
  return totals;
}

function repoLabel(rows: AssistantUsageMetric[]): string {
  const repos = new Set(rows.map((row) => row.repoSlug));
  if (repos.size === 1) return rows[0]?.repoSlug ?? "Unknown repo";
  return `${repos.size} repos`;
}

function turnLabel(
  first: AssistantUsageMetric,
  last: AssistantUsageMetric,
): string {
  if (first.entryId === last.entryId) return `Turn ${first.sequence}`;
  return `Turns ${first.sequence}-${last.sequence}`;
}

function primaryMetric(view: ChartView, value: number): PrimaryMetric {
  if (view === "per-turn") {
    return { label: "Average per-turn cache hit", value, unit: "percent" };
  }
  if (view === "cumulative-percent") {
    return {
      label: "Cumulative cache hit at range end",
      value,
      unit: "percent",
    };
  }
  return {
    label: "Cumulative prompt tokens at range end",
    value,
    unit: "tokens",
  };
}

function aggregationNote(view: ChartView, messageCount: number): string {
  if (messageCount === 1) return "Single assistant turn.";
  if (view === "per-turn") {
    return `Aggregated ${messageCount} turns; value is the average hit rate.`;
  }
  return `Aggregated ${messageCount} turns; value is taken at the range end.`;
}
