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
  it("builds a flat branch name from base + slug", () => {
    expect(
      buildFeatureBranchName({
        base: "main",
        slug: "checkout-v2",
      }),
    ).toBe("main--checkout-v2");
  });

  it("encodes nested base branches safely", () => {
    expect(
      buildFeatureBranchName({
        base: "release/2026-q2",
        slug: "login-timeout",
      }),
    ).toBe("release%2F2026-q2--login-timeout");
  });

  it("avoids colliding with a leaf base branch like master", () => {
    expect(
      buildFeatureBranchName({
        base: "master",
        slug: "simple-workflow",
      }),
    ).toBe("master--simple-workflow");
  });
});

describe("parseFeatureBranchName", () => {
  it("parses flat branch names", () => {
    expect(parseFeatureBranchName("main--checkout-v2")).toEqual({
      base: "main",
      slug: "checkout-v2",
    });
  });

  it("decodes nested base branches from flat names", () => {
    expect(
      parseFeatureBranchName("release%2F2026-q2--login-timeout"),
    ).toEqual({
      base: "release/2026-q2",
      slug: "login-timeout",
    });
  });

  it("keeps parsing legacy base-first branch names for compatibility", () => {
    expect(parseFeatureBranchName("main/checkout-v2")).toEqual({
      base: "main",
      slug: "checkout-v2",
    });
  });

  it("returns null for invalid branch names", () => {
    expect(parseFeatureBranchName("checkout-v2")).toBeNull();
    expect(parseFeatureBranchName("main/")).toBeNull();
    expect(parseFeatureBranchName("main/Checkout-V2")).toBeNull();
    expect(parseFeatureBranchName("main--Checkout-V2")).toBeNull();
    expect(parseFeatureBranchName("release%2F2026-q2--")).toBeNull();
  });
});
