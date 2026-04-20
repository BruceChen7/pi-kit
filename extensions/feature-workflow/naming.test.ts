import { describe, expect, it } from "vitest";

import { buildFeatureBranchName, isFeatureSlug } from "./naming.js";

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
  it("builds a slug-only feature branch name", () => {
    expect(
      buildFeatureBranchName({
        slug: "checkout-v2",
      }),
    ).toBe("checkout-v2");
  });

  it("trims surrounding whitespace", () => {
    expect(
      buildFeatureBranchName({
        slug: "  simple-workflow  ",
      }),
    ).toBe("simple-workflow");
  });
});
