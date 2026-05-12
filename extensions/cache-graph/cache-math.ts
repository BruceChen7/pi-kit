import type { AssistantUsageMetric, CacheUsageTotals } from "./types.ts";

export function computeCacheHitPercent(
  input: number,
  cacheRead: number,
  cacheWrite: number,
): number {
  const denominator = input + cacheRead + cacheWrite;
  if (denominator <= 0) return 0;
  return (cacheRead / denominator) * 100;
}

export function emptyTotals(): CacheUsageTotals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    assistantMessages: 0,
  };
}

export function addToTotals(
  totals: CacheUsageTotals,
  message: AssistantUsageMetric,
): void {
  totals.input += message.input;
  totals.output += message.output;
  totals.cacheRead += message.cacheRead;
  totals.cacheWrite += message.cacheWrite;
  totals.totalTokens += message.totalTokens;
  totals.assistantMessages += 1;
}
