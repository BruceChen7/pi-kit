import { computeCacheHitPercent } from "./cache-math.ts";
import type { AssistantUsageMetric } from "./types.ts";

export interface CumulativeSeries {
  cumInput: number[];
  cumCacheRead: number[];
  cumCacheWrite: number[];
  cumHitPercent: number[];
}

export function computeCumulativeSeries(
  messages: AssistantUsageMetric[],
): CumulativeSeries {
  const cumInput: number[] = [];
  const cumCacheRead: number[] = [];
  const cumCacheWrite: number[] = [];
  const cumHitPercent: number[] = [];

  let sumInput = 0;
  let sumCacheRead = 0;
  let sumCacheWrite = 0;

  for (const message of messages) {
    sumInput += message.input;
    sumCacheRead += message.cacheRead;
    sumCacheWrite += message.cacheWrite;
    cumInput.push(sumInput);
    cumCacheRead.push(sumCacheRead);
    cumCacheWrite.push(sumCacheWrite);
    cumHitPercent.push(
      computeCacheHitPercent(sumInput, sumCacheRead, sumCacheWrite),
    );
  }

  return { cumInput, cumCacheRead, cumCacheWrite, cumHitPercent };
}
