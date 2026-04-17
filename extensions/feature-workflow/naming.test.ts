import { describe, expect, it } from "vitest";

import {
  buildFeatureBranchName,
  buildFeatureId,
  slugifyFeatureName,
} from "./naming.js";

describe("slugifyFeatureName", () => {
  it("slugifies common names", () => {
    expect(slugifyFeatureName("Checkout V2")).toBe("checkout-v2");
    expect(slugifyFeatureName("Fix: login (OAuth)")).toBe("fix-login-oauth");
  });

  it("trims and collapses separators", () => {
    expect(slugifyFeatureName("  Hello   world__x  ")).toBe("hello-world-x");
  });
});

describe("buildFeatureBranchName", () => {
  it("uses type as prefix", () => {
    expect(buildFeatureBranchName({ type: "feat", slug: "checkout-v2" })).toBe(
      "feat/checkout-v2",
    );
  });
});

describe("buildFeatureId", () => {
  it("uses dashed id", () => {
    expect(buildFeatureId({ type: "feat", slug: "checkout-v2" })).toBe(
      "feat-checkout-v2",
    );
  });
});
