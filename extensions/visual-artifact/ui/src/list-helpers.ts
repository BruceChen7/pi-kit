/**
 * Pure presentation helpers for the artifact history list (left column).
 *
 * Kept outside App.svelte so the grouping/typing logic is unit-testable
 * without a DOM (Functional Core: value in → value out).
 */

const TYPE_GROUPS: Record<string, string> = {
  mermaid: "mermaid",
  table: "table",
  "side-by-side": "table",
  "kpi-grid": "kpi",
  accordion: "accordion",
};

const TYPE_ORDER = ["mermaid", "table", "kpi", "accordion", "text"];

/**
 * Normalize a node type to a display bucket: mermaid | table | kpi |
 * accordion | text. Unknown types fall back to "text".
 */
export function typeKey(nodeType: string): string {
  const mapped = TYPE_GROUPS[nodeType];
  return mapped ?? "text";
}

/**
 * Unique display buckets in first-appearance order, capped at `max`
 * (the list row shows at most a handful of type icons).
 */
export function uniqueTypeKeys(nodeTypes: string[], max = 4): string[] {
  const seen: string[] = [];
  for (const nodeType of nodeTypes) {
    const key = typeKey(nodeType);
    if (!seen.includes(key) && seen.length < max) {
      seen.push(key);
    }
  }
  return seen;
}

/**
 * Display locale: follow the browser's language when available (the UI is
 * rendered in a Glimpse window); deterministic "en-US" fallback outside
 * browsers (tests, SSR) so assertions stay stable.
 */
const DISPLAY_LOCALE =
  typeof window !== "undefined" && window.navigator?.language
    ? window.navigator.language
    : "en-US";

/** Ordering weight for type buckets (unused buckets sort last). */
export function typeRank(key: string): number {
  const rank = TYPE_ORDER.indexOf(key);
  return rank === -1 ? TYPE_ORDER.length : rank;
}

/**
 * Day bucket label for a created-at ISO timestamp, relative to `now`:
 * "Today" / "Yesterday" / locale date ("Aug 4, 2026").
 */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Unknown";

  const startOfDay = (d: Date): number =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

  const diffDays = Math.round(
    (startOfDay(now) - startOfDay(date)) / 86_400_000,
  );
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return date.toLocaleDateString(DISPLAY_LOCALE, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Clock time for a created-at ISO timestamp, e.g. "11:31 AM". */
export function timeLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(DISPLAY_LOCALE, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Group artifact summaries into ordered day buckets, preserving the
 * newest-first order within each bucket.
 */
export function groupByDay<T extends { createdAt: string }>(
  artifacts: T[],
  now: Date = new Date(),
): { label: string; items: T[] }[] {
  const order: string[] = [];
  const buckets = new Map<string, T[]>();
  for (const artifact of artifacts) {
    const label = dayLabel(artifact.createdAt, now);
    const bucket = buckets.get(label);
    if (bucket) {
      bucket.push(artifact);
    } else {
      buckets.set(label, [artifact]);
      order.push(label);
    }
  }
  return order.map((label) => ({
    label,
    items: buckets.get(label) ?? [],
  }));
}
