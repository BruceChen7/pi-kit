import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, normalizeDiffxReviewConfig } from "./config.ts";

describe("diffx-review config", () => {
  it("normalizes known settings and falls back for invalid values", () => {
    const config = normalizeDiffxReviewConfig({
      enabled: false,
      diffxCommand: "npx diffx-cli",
      host: "0.0.0.0",
      defaultPort: "3433",
      reuseExistingSession: false,
      healthcheckTimeoutMs: -1,
      startupTimeoutMs: 30000,
    });

    expect(config).toEqual({
      enabled: false,
      diffxCommand: "npx diffx-cli",
      host: "0.0.0.0",
      defaultPort: 3433,
      reuseExistingSession: false,
      healthcheckTimeoutMs: DEFAULT_CONFIG.healthcheckTimeoutMs,
      startupTimeoutMs: 30000,
    });
  });

  it("uses defaults when settings are missing", () => {
    expect(normalizeDiffxReviewConfig(undefined)).toEqual(DEFAULT_CONFIG);
  });

  it("falls back to the default command when diffxCommand is null or empty", () => {
    expect(
      normalizeDiffxReviewConfig({
        diffxCommand: null,
      }).diffxCommand,
    ).toBe(DEFAULT_CONFIG.diffxCommand);

    expect(
      normalizeDiffxReviewConfig({
        diffxCommand: "",
      }).diffxCommand,
    ).toBe(DEFAULT_CONFIG.diffxCommand);
  });
});
