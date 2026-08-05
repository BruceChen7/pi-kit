/**
 * Marker classes for ordered/unordered list adapters.
 *
 * Tailwind preflight strips list markers (list-style: none on ul/ol), so the
 * markers must be restored explicitly. Pure decision: value in / value out,
 * consumed by list.svelte and covered by behavior tests.
 */
export const listMarkerClasses = (isOrdered: boolean): string =>
  isOrdered ? "list-decimal" : "list-disc";
