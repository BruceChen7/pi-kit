import { describe, expect, it } from "vitest";

import {
  buildFeatureBranchName,
  isFeatureSlug,
  parseFeatureBranchName,
} from "./naming.js";

describe("isFeatureSlug", () => {
  it("accepts lowercase slugs with dashes", () => {
    expect(isFeatureSlug("checkout-v2")).toBe(true);
    expect(isFeatureSlug("login2")).toBe(true);
  });

  it("rejects empty or non-normalized values", () => {
    expect(isFeatureSlug("")).toBe(false);
    expect(isFeatureSlug("Checkout-V2")).toBe(false);
    expect(isFeatureSlug("checkout_v2")).toBe(false);
    expect(isFeatureSlug("checkout/v2")).toBe(false);
  });
});

describe("buildFeatureBranchName", () => {
  it("includes base in the branch path", () => {
    expect(
      buildFeatureBranchName({
        base: "main",
        slug: "checkout-v2",
      }),
    ).toBe("main/checkout-v2");
  });

  it("supports nested base branches", () => {
    expect(
      buildFeatureBranchName({
        base: "release/2026-q2",
        slug: "login-timeout",
      }),
    ).toBe("release/2026-q2/login-timeout");
  });
});

describe("parseFeatureBranchName", () => {
  it("parses branches that embed base", () => {
    expect(parseFeatureBranchName("main/checkout-v2")).toEqual({
      base: "main",
      slug: "checkout-v2",
    });
  });

  it("supports nested base branches", () => {
    expect(parseFeatureBranchName("release/2026-q2/login-timeout")).toEqual({
      base: "release/2026-q2",
      slug: "login-timeout",
    });
  });

  it("returns null for invalid branch names", () => {
    expect(parseFeatureBranchName("checkout-v2")).toBeNull();
    expect(parseFeatureBranchName("main/")).toBeNull();
    expect(parseFeatureBranchName("main/Checkout-V2")).toBeNull();
  });
});
