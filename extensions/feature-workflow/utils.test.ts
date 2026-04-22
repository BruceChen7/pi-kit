import { describe, expect, it } from "vitest";

import { isRecord, trimToNull } from "./utils.js";

describe("feature-workflow utils", () => {
  it("trims non-empty strings to values and returns null for empty input", () => {
    expect(trimToNull("  hello  ")).toBe("hello");
    expect(trimToNull("   ")).toBeNull();
    expect(trimToNull(null)).toBeNull();
    expect(trimToNull(undefined)).toBeNull();
  });

  it("detects plain object records", () => {
    expect(isRecord({ branch: "checkout-v2" })).toBe(true);
    expect(isRecord(["checkout-v2"])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("checkout-v2")).toBe(false);
  });
});
