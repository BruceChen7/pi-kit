/**
 * Shared helpers for the visual-artifact tool (`create_visual_artifact`):
 * slug normalization and tool-result envelopes. Pure functions — no IO.
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
