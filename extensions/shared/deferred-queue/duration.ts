import type { Duration } from "./types.ts";

/**
 * Parse a Duration string to milliseconds.
 *
 * Examples:
 *   parseDuration("30m")  => 1_800_000
 *   parseDuration("2h")   => 7_200_000
 *   parseDuration("7d")   => 604_800_000
 */
export function parseDuration(d: Duration): number {
  const unit = d[d.length - 1];
  const value = Number.parseInt(d.slice(0, -1), 10);

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `Invalid duration: ${d}. Must be a positive number followed by m/h/d.`,
    );
  }

  switch (unit) {
    case "m":
      return value * 60_000;
    case "h":
      return value * 3_600_000;
    case "d":
      return value * 86_400_000;
    default:
      throw new Error(
        `Unsupported duration unit: ${unit}. Use m (minutes), h (hours), or d (days).`,
      );
  }
}
