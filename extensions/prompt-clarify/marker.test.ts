import { describe, expect, it } from "vitest";
import {
  CLARIFY_MARKER_RE,
  hasClarifyMarker,
  stripClarifyMarker,
} from "./marker.ts";

describe("hasClarifyMarker", () => {
  it("detects -clarify at start, middle, and end", () => {
    expect(hasClarifyMarker("-clarify make cards smooth")).toBe(true);
    expect(hasClarifyMarker("make cards smooth -clarify")).toBe(true);
    expect(hasClarifyMarker("please -clarify this request")).toBe(true);
    expect(hasClarifyMarker("-clarify")).toBe(true);
  });

  it("detects -prompt-clarify alias", () => {
    expect(hasClarifyMarker("-prompt-clarify make cards smooth")).toBe(true);
    expect(hasClarifyMarker("make cards smooth -prompt-clarify")).toBe(true);
    expect(hasClarifyMarker("please -prompt-clarify this")).toBe(true);
    expect(hasClarifyMarker("-prompt-clarify")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(hasClarifyMarker("-Clarify make")).toBe(true);
    expect(hasClarifyMarker("-PROMPT-clarify make")).toBe(true);
    expect(hasClarifyMarker("make -CLARIFY")).toBe(true);
  });

  it("ignores lookalike words and normal text", () => {
    expect(hasClarifyMarker("pre-clarify this later")).toBe(false);
    expect(hasClarifyMarker("please clarify this request")).toBe(false);
    expect(hasClarifyMarker("make cards smooth")).toBe(false);
    expect(hasClarifyMarker("")).toBe(false);
  });

  it("detects marker before punctuation", () => {
    expect(hasClarifyMarker("make cards smooth -clarify.")).toBe(true);
    expect(hasClarifyMarker("make -prompt-clarify, please")).toBe(true);
  });

  it("exports a global regex that can be re-tested", () => {
    // ensure lastIndex is reset inside helper
    CLARIFY_MARKER_RE.lastIndex = 999;
    expect(hasClarifyMarker("a -clarify b")).toBe(true);
    expect(hasClarifyMarker("a -clarify b")).toBe(true);
  });
});

describe("stripClarifyMarker", () => {
  it("strips markers and keeps the remaining prompt", () => {
    expect(stripClarifyMarker("make cards smooth -clarify")).toBe(
      "make cards smooth",
    );
    expect(stripClarifyMarker("-clarify make cards smooth")).toBe(
      "make cards smooth",
    );
    expect(stripClarifyMarker("please -clarify this now")).toBe(
      "please this now",
    );
    expect(stripClarifyMarker("make cards smooth -clarify.")).toBe(
      "make cards smooth.",
    );
    expect(stripClarifyMarker("-clarify")).toBe("");
  });

  it("strips -prompt-clarify alias", () => {
    expect(stripClarifyMarker("make -prompt-clarify smooth")).toBe(
      "make smooth",
    );
    expect(stripClarifyMarker("-prompt-clarify make cards")).toBe("make cards");
    expect(stripClarifyMarker("a -prompt-clarify b")).toBe("a b");
  });

  it("strips repeated markers", () => {
    expect(stripClarifyMarker("-clarify make cards smooth -clarify")).toBe(
      "make cards smooth",
    );
    expect(stripClarifyMarker("-clarify a -prompt-clarify b -clarify")).toBe(
      "a b",
    );
  });

  it("handles punctuation and extra whitespace", () => {
    expect(stripClarifyMarker("a -clarify , b")).toBe("a, b");
    expect(stripClarifyMarker("a  -clarify   b")).toBe("a b");
  });
});
