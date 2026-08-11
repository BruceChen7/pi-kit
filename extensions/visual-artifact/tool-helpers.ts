/**
 * Shared helpers for the visual-artifact tools (`create_visual_artifact`,
 * `create_calldiff_artifact`): slug normalization and tool-result envelopes.
 * Pure functions — no IO.
 */

export const normalizeSlug = (input: string): string =>
  input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");

export const result = (text: string) => ({
  content: [{ type: "text" as const, text }],
  details: {},
  isError: false,
});

export const errorResult = (text: string) => ({
  content: [{ type: "text" as const, text }],
  details: {},
  isError: true,
});

/* ------------------------------------------------------------------ */
/*  Param sanitizers (shared tool/params → node props normalization)   */
/* ------------------------------------------------------------------ */

/**
 * Normalize `entry`-style params: a non-empty string or a list of non-empty
 * strings becomes a trimmed string array; anything else is `undefined`.
 * Shared by the calldiff tool (tool params → node props) and the
 * `calldiff-callflow` resolver (node props → run options) so both sides of
 * the param mapping can't drift apart.
 */
export const toEntries = (value: unknown): string[] | undefined => {
  if (typeof value === "string") {
    return value.trim().length > 0 ? [value.trim()] : undefined;
  }
  if (Array.isArray(value)) {
    const entries = value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    return entries.length > 0 ? entries : undefined;
  }
  return undefined;
};

export const toStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : undefined;
};

export const toOptionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
