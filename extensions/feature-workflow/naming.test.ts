import { describe, expect, it } from "vitest";

import {
  buildFeatureBranchName,
  buildFeatureId,
  parseFeatureBranchName,
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
  it("includes base in the branch path", () => {
    expect(
      buildFeatureBranchName({
        type: "feat",
        base: "main",
        slug: "checkout-v2",
      }),
    ).toBe("feat/main/checkout-v2");
  });

  it("supports nested base branches", () => {
    expect(
      buildFeatureBranchName({
        type: "fix",
        base: "release/2026-q2",
        slug: "login-timeout",
      }),
    ).toBe("fix/release/2026-q2/login-timeout");
  });
});

describe("parseFeatureBranchName", () => {
  it("parses branches that embed base", () => {
    expect(parseFeatureBranchName("feat/main/checkout-v2")).toEqual({
      type: "feat",
      base: "main",
      slug: "checkout-v2",
    });
  });

  it("keeps compatibility with legacy type/slug branches", () => {
    expect(parseFeatureBranchName("feat/checkout-v2")).toEqual({
      type: "feat",
      base: "",
      slug: "checkout-v2",
    });
  });

  it("returns null for invalid branch names", () => {
    expect(parseFeatureBranchName("feature/main/checkout-v2")).toBeNull();
    expect(parseFeatureBranchName("feat/main/")).toBeNull();
  });
});

describe("buildFeatureId", () => {
  it("includes base in id when base exists", () => {
    expect(
      buildFeatureId({ type: "feat", base: "main", slug: "checkout-v2" }),
    ).toBe("feat-main-checkout-v2");
  });

  it("normalizes nested base names", () => {
    expect(
      buildFeatureId({
        type: "fix",
        base: "release/2026-q2",
        slug: "login-timeout",
      }),
    ).toBe("fix-release-2026-q2-login-timeout");
  });

  it("keeps legacy shape when base is empty", () => {
    expect(
      buildFeatureId({ type: "feat", base: "", slug: "checkout-v2" }),
    ).toBe("feat-checkout-v2");
  });
});
