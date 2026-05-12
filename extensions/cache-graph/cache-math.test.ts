import { describe, expect, it } from "vitest";
import { computeCacheHitPercent } from "./cache-math.ts";
import { computeCumulativeSeries } from "./cumulative.ts";

const message = (input: number, cacheRead: number, cacheWrite: number) => ({
  sequence: 1,
  entryId: "entry",
  timestamp: "2026-05-12T00:00:00.000Z",
  provider: "provider",
  model: "model",
  input,
  output: 10,
  cacheRead,
  cacheWrite,
  totalTokens: input + cacheRead + cacheWrite + 10,
  cacheHitPercent: computeCacheHitPercent(input, cacheRead, cacheWrite),
  isOnActiveBranch: true,
});

describe("cache math", () => {
  it("computes hit percent over full prompt tokens", () => {
    expect(computeCacheHitPercent(50, 25, 25)).toBe(25);
    expect(computeCacheHitPercent(0, 0, 0)).toBe(0);
  });

  it("computes cumulative cache series", () => {
    const series = computeCumulativeSeries([
      message(50, 25, 25),
      message(20, 30, 0),
    ]);

    expect(series.cumInput).toEqual([50, 70]);
    expect(series.cumCacheRead).toEqual([25, 55]);
    expect(series.cumCacheWrite).toEqual([25, 25]);
    expect(series.cumHitPercent).toEqual([25, (55 / 150) * 100]);
  });
});
