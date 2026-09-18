import { describe, expect, it } from "vitest";
import { DEFAULT_CODEX_WEB_SEARCH_MODEL } from "./constants.js";
import {
  asModel,
  DEFAULT_WEB_SEARCH_SETTINGS,
  formatSettings,
  normalizeSettings,
} from "./settings.js";

describe("asModel", () => {
  it("treats inherit-style values as no override", () => {
    for (const value of [
      "",
      "  ",
      "inherit",
      "Inherit",
      "default",
      "none",
      "off",
    ]) {
      expect(asModel(value)).toBe("");
    }
  });

  it("keeps and trims concrete model names", () => {
    expect(asModel("  llm-gateway--gpt-5.5  ")).toBe("llm-gateway--gpt-5.5");
  });

  it("falls back to the bundled default for unusable values", () => {
    expect(asModel(undefined)).toBe(DEFAULT_CODEX_WEB_SEARCH_MODEL);
    expect(asModel(42)).toBe(DEFAULT_CODEX_WEB_SEARCH_MODEL);
  });
});

describe("normalizeSettings", () => {
  it("defaults the Codex model to the bundled web-search default", () => {
    expect(normalizeSettings({}).codexModel).toBe(
      DEFAULT_WEB_SEARCH_SETTINGS.codexModel,
    );
    expect(DEFAULT_WEB_SEARCH_SETTINGS.codexModel).toBe(
      DEFAULT_CODEX_WEB_SEARCH_MODEL,
    );
  });

  it("persists a configured Codex model", () => {
    expect(
      normalizeSettings({ codexModel: "llm-gateway--glm-5.3" }).codexModel,
    ).toBe("llm-gateway--glm-5.3");
  });

  it("normalizes inherit-style Codex models back to no override", () => {
    expect(normalizeSettings({ codexModel: "inherit" }).codexModel).toBe("");
  });
});

describe("formatSettings", () => {
  it("shows the configured model", () => {
    expect(formatSettings(DEFAULT_WEB_SEARCH_SETTINGS)).toContain(
      `Model: ${DEFAULT_CODEX_WEB_SEARCH_MODEL}`,
    );
  });

  it("shows the inherited model when none is pinned", () => {
    const settings = { ...DEFAULT_WEB_SEARCH_SETTINGS, codexModel: "" };

    expect(formatSettings(settings)).toContain(
      "Model: inherit from Codex config",
    );
  });

  it("shows a pinned model", () => {
    const settings = { ...DEFAULT_WEB_SEARCH_SETTINGS, codexModel: "gpt-5.5" };

    expect(formatSettings(settings)).toContain("Model: gpt-5.5");
  });
});
