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

export function formatShortTimestamp(timestamp: string): string {
  const date = parseDateOrNull(timestamp);
  if (!date) return fallbackTimestampLabel(timestamp);
  return formatShortTimestampFromDate(date);
}

export function formatShortTimeRange(start: string, end: string): string {
  const startDate = parseDateOrNull(start);
  const endDate = parseDateOrNull(end);
  const startLabel = formatShortTimestamp(start);
  const endLabel = formatShortTimestamp(end);

  if (startLabel === endLabel) return startLabel;
  if (!startDate || !endDate) return `${startLabel} – ${endLabel}`;
  if (isSameDay(startDate, endDate)) {
    return `${startLabel}–${formatDatePart(endDate.getHours())}:${formatDatePart(
      endDate.getMinutes(),
    )}`;
  }
  return `${startLabel} – ${endLabel}`;
}

function parseDateOrNull(timestamp: string): Date | null {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date;
}

function fallbackTimestampLabel(timestamp: string): string {
  return timestamp.slice(0, 16).replace("T", " ").trim();
}

function formatShortTimestampFromDate(date: Date): string {
  return `${formatDatePart(date.getMonth() + 1)}-${formatDatePart(
    date.getDate(),
  )} ${formatDatePart(date.getHours())}:${formatDatePart(date.getMinutes())}`;
}

function isSameDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function formatDatePart(value: number): string {
  return value.toString().padStart(2, "0");
}
