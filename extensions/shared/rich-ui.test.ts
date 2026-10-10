import { describe, expect, it } from "vitest";
import { hasRichUi } from "./rich-ui.js";

describe("hasRichUi", () => {
  it("answers yes for the terminal UI", () => {
    expect(hasRichUi({ hasUI: true, mode: "tui" })).toBe(true);
  });

  it("answers no for the RPC transport, where custom() resolves to undefined", () => {
    // The trap this helper exists for: hasUI is true there, and a
    // `typeof ctx.ui.custom !== "function"` guard would pass.
    expect(hasRichUi({ hasUI: true, mode: "rpc" })).toBe(false);
  });

  it("answers no for headless modes", () => {
    expect(hasRichUi({ hasUI: false, mode: "json" })).toBe(false);
    expect(hasRichUi({ hasUI: true, mode: "print" })).toBe(false);
    expect(hasRichUi({ hasUI: false })).toBe(false);
  });

  it("assumes the terminal when the capability fields are absent", () => {
    // Embedders and tests drive extensions directly and omit both fields;
    // their previous behaviour was to attempt custom().
    expect(hasRichUi({ hasUI: true })).toBe(true);
    expect(hasRichUi({})).toBe(true);
  });
});
