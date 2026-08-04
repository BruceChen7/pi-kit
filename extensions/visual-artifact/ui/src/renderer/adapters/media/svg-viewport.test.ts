import { describe, expect, it } from "vitest";
import {
  clampZoom,
  computeView,
  exceedsDragThreshold,
  fitBoundsToContainer,
  MAX_ZOOM,
  MIN_ZOOM,
  normalizeSvgMarkup,
  parseViewBoxFromMarkup,
  stepZoom,
  ZOOM_STEP,
} from "./svg-viewport.ts";

describe("parseViewBoxFromMarkup", () => {
  it("parses a space-separated viewBox attribute", () => {
    expect(parseViewBoxFromMarkup('<svg viewBox="0 0 100 50">')).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 50,
    });
  });

  it("parses a comma-separated viewBox with a non-zero origin", () => {
    expect(parseViewBoxFromMarkup('<svg viewBox="10,20,100,50">')).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 50,
    });
  });

  it("falls back to width/height attributes when viewBox is missing", () => {
    expect(parseViewBoxFromMarkup('<svg width="200" height="100">')).toEqual({
      x: 0,
      y: 0,
      width: 200,
      height: 100,
    });
  });

  it("accepts px-suffixed width/height", () => {
    expect(
      parseViewBoxFromMarkup('<svg width="200px" height="100px">'),
    ).toEqual({
      x: 0,
      y: 0,
      width: 200,
      height: 100,
    });
  });

  it("returns null for a malformed viewBox without width/height fallback", () => {
    expect(parseViewBoxFromMarkup('<svg viewBox="0 0 100">')).toBeNull();
  });

  it("returns null for non-positive dimensions", () => {
    expect(parseViewBoxFromMarkup('<svg viewBox="0 0 0 100">')).toBeNull();
    expect(parseViewBoxFromMarkup('<svg width="200" height="-1">')).toBeNull();
  });

  it("returns null when no sizing information exists", () => {
    expect(parseViewBoxFromMarkup("<svg><g/></svg>")).toBeNull();
  });
});

describe("computeView", () => {
  const base = { x: 0, y: 0, width: 100, height: 100 };

  it("returns the base viewBox at zoom 1 with no pan", () => {
    expect(computeView(base, 1, { x: 0, y: 0 })).toEqual(base);
  });

  it("zooms around the base center", () => {
    expect(computeView(base, 2, { x: 0, y: 0 })).toEqual({
      x: 25,
      y: 25,
      width: 50,
      height: 50,
    });
  });

  it("applies pan in viewBox units after zooming", () => {
    expect(computeView(base, 2, { x: 10, y: -5 })).toEqual({
      x: 35,
      y: 20,
      width: 50,
      height: 50,
    });
  });

  it("respects a non-zero base origin", () => {
    const offsetBase = { x: 10, y: 20, width: 100, height: 50 };
    expect(computeView(offsetBase, 1, { x: 0, y: 0 })).toEqual(offsetBase);
  });
});

describe("fitBoundsToContainer", () => {
  it("pads height when content is wider than the container", () => {
    expect(
      fitBoundsToContainer({ x: 0, y: 0, width: 200, height: 100 }, 100, 100),
    ).toEqual({
      x: 0,
      y: -50,
      width: 200,
      height: 200,
    });
  });

  it("pads width when content is taller than the container", () => {
    expect(
      fitBoundsToContainer({ x: 0, y: 0, width: 100, height: 200 }, 200, 100),
    ).toEqual({
      x: -150,
      y: 0,
      width: 400,
      height: 200,
    });
  });

  it("returns bounds unchanged when ratios already match", () => {
    const bounds = { x: 5, y: 10, width: 200, height: 100 };
    expect(fitBoundsToContainer(bounds, 400, 200)).toEqual(bounds);
  });

  it("clamps zero container dimensions to 1 instead of dividing by zero", () => {
    const fitted = fitBoundsToContainer(
      { x: 0, y: 0, width: 100, height: 100 },
      0,
      0,
    );
    expect(fitted.width).toBeGreaterThan(0);
    expect(fitted.height).toBeGreaterThan(0);
    expect(Number.isFinite(fitted.x)).toBe(true);
    expect(Number.isFinite(fitted.y)).toBe(true);
  });
});

describe("clampZoom / stepZoom", () => {
  it("clamps below MIN_ZOOM and above MAX_ZOOM", () => {
    expect(clampZoom(0.1)).toBe(MIN_ZOOM);
    expect(clampZoom(10)).toBe(MAX_ZOOM);
    expect(clampZoom(1)).toBe(1);
  });

  it("steps by ZOOM_STEP in both directions", () => {
    expect(stepZoom(1, 1)).toBeCloseTo(1 + ZOOM_STEP);
    expect(stepZoom(1, -1)).toBeCloseTo(1 - ZOOM_STEP);
  });

  it("does not step past the bounds", () => {
    expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
    expect(stepZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
  });
});

describe("exceedsDragThreshold", () => {
  it("treats movement within the threshold as a click", () => {
    expect(exceedsDragThreshold(3, 3)).toBe(false);
  });

  it("treats movement beyond the threshold as a drag", () => {
    expect(exceedsDragThreshold(4, 4)).toBe(true);
    expect(exceedsDragThreshold(6, 0)).toBe(true);
  });

  it("uses Euclidean distance, not per-axis distance", () => {
    // hypot(3, 4) === 5, exactly at the default threshold → not a drag
    expect(exceedsDragThreshold(3, 4)).toBe(false);
  });

  it("supports a custom threshold, strictly greater than", () => {
    expect(exceedsDragThreshold(5, 0, 5)).toBe(false);
    expect(exceedsDragThreshold(5.1, 0, 5)).toBe(true);
  });
});

describe("normalizeSvgMarkup", () => {
  it("injects style, preserveAspectRatio, and height when missing", () => {
    expect(normalizeSvgMarkup('<svg viewBox="0 0 10 10">')).toBe(
      '<svg viewBox="0 0 10 10" style="max-width: none" preserveAspectRatio="xMidYMid meet" height="100%">',
    );
  });

  it("replaces an existing max-width rule and keeps other rules", () => {
    expect(
      normalizeSvgMarkup('<svg style="max-width: 100%; background: white;">'),
    ).toBe(
      '<svg style="background: white; max-width: none" preserveAspectRatio="xMidYMid meet" height="100%">',
    );
  });

  it("keeps an existing preserveAspectRatio and height", () => {
    expect(
      normalizeSvgMarkup('<svg preserveAspectRatio="none" height="42">'),
    ).toBe(
      '<svg preserveAspectRatio="none" height="42" style="max-width: none">',
    );
  });

  it("is idempotent", () => {
    const once = normalizeSvgMarkup(
      '<svg viewBox="0 0 10 10" style="max-width: 100%;">',
    );
    expect(normalizeSvgMarkup(once)).toBe(once);
  });

  it("leaves non-svg markup untouched", () => {
    expect(normalizeSvgMarkup("<div>not svg</div>")).toBe("<div>not svg</div>");
  });
});
