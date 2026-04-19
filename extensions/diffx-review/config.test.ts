import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONFIG,
  expandHomePath,
  normalizeDiffxReviewConfig,
} from "./config.ts";

describe("diffx-review config", () => {
  it("expands home-relative paths", () => {
    expect(expandHomePath("~")).toBe(os.homedir());
    expect(expandHomePath("~/work/diffx")).toBe(
      path.join(os.homedir(), "work", "diffx"),
    );
  });

  it("normalizes known settings and falls back for invalid values", () => {
    const config = normalizeDiffxReviewConfig({
      enabled: false,
      diffxCommand: "npx diffx-cli",
      diffxPath: "~/src/diffx",
      host: "0.0.0.0",
      defaultPort: "3433",
      autoOpen: false,
      startMode: "dev",
      reuseExistingSession: false,
      healthcheckTimeoutMs: -1,
      startupTimeoutMs: 30000,
    });

    expect(config).toEqual({
      enabled: false,
      diffxCommand: "npx diffx-cli",
      diffxPath: path.resolve(os.homedir(), "src", "diffx"),
      host: "0.0.0.0",
      defaultPort: 3433,
      autoOpen: false,
      startMode: "dist",
      reuseExistingSession: false,
      healthcheckTimeoutMs: DEFAULT_CONFIG.healthcheckTimeoutMs,
      startupTimeoutMs: 30000,
    });
  });

  it("uses defaults when settings are missing", () => {
    expect(normalizeDiffxReviewConfig(undefined)).toEqual(DEFAULT_CONFIG);
  });
});
