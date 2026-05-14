import { addToTotals, emptyTotals } from "./cache-math.ts";
import type { AssistantUsageMetric, CacheUsageTotals } from "./types.ts";

export type ChartRange = "today" | "7d" | "1m";
export type RepoFilter = "all" | string;

export type GraphFilter = {
  repo: RepoFilter;
  anchorDate: string;
  range: ChartRange;
};

export function filterRowsForGraph(
  rows: AssistantUsageMetric[],
  filter: GraphFilter,
): AssistantUsageMetric[] {
  const window = dateWindow(filter.anchorDate, filter.range);
  return rows.filter((row) => {
    if (filter.repo !== "all" && row.repoSlug !== filter.repo) return false;
    const time = Date.parse(row.timestamp);
    return Number.isFinite(time) && time >= window.start && time <= window.end;
  });
}

export function buildRepoOptions(rows: AssistantUsageMetric[]): string[] {
  return Array.from(new Set(rows.map((row) => row.repoSlug))).sort(
    (left, right) => left.localeCompare(right),
  );
}

export function totalsForRows(rows: AssistantUsageMetric[]): CacheUsageTotals {
  const totals = emptyTotals();
  for (const row of rows) {
    addToTotals(totals, row);
  }
  return totals;
}

export function formatDateInputValue(date: Date): string {
  return [
    date.getUTCFullYear(),
    formatDatePart(date.getUTCMonth() + 1),
    formatDatePart(date.getUTCDate()),
  ].join("-");
}

function dateWindow(
  anchorDate: string,
  range: ChartRange,
): { start: number; end: number } {
  const anchor = parseDateInput(anchorDate);
  const endDate = new Date(anchor);
  endDate.setUTCDate(endDate.getUTCDate() + 1);

  const startDate = new Date(anchor);
  if (range === "7d") {
    startDate.setUTCDate(startDate.getUTCDate() - 6);
  } else if (range === "1m") {
    startDate.setUTCMonth(startDate.getUTCMonth() - 1);
    startDate.setUTCDate(startDate.getUTCDate() + 1);
  }

  return { start: startDate.getTime(), end: endDate.getTime() - 1 };
}

function parseDateInput(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return startOfUtcDay(new Date());

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(date.getTime()) ? startOfUtcDay(new Date()) : date;
}

function startOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function formatDatePart(value: number): string {
  return value.toString().padStart(2, "0");
}
