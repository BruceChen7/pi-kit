import { computeCacheHitPercent } from "./cache-math.ts";
import type { CacheUsageTotals } from "./types.ts";

export function formatInt(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(Math.round(value));
}

export function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

export function shortModelName(provider: string, model: string): string {
  return `${provider}/${model}`;
}

export function summarizeHitPercent(totals: CacheUsageTotals): number {
  return computeCacheHitPercent(
    totals.input,
    totals.cacheRead,
    totals.cacheWrite,
  );
}
