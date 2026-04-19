import { describe, expect, it } from "vitest";

import { matchFeatureRecord } from "./feature-query.js";
import type { FeatureRecord } from "./storage.js";

const record = (input: { branch: string; slug?: string }): FeatureRecord => {
  const slug = input.slug ?? input.branch;
  return {
    name: slug,
    slug,
    branch: input.branch,
    worktreePath: `/tmp/${slug}`,
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
};

describe("matchFeatureRecord", () => {
  it("matches canonical branch before slug alias", () => {
    const records = [
      record({ branch: "legacy-main--checkout-v2", slug: "checkout-v2" }),
      record({ branch: "checkout-v2", slug: "checkout-v2" }),
    ];

    const result = matchFeatureRecord(records, "checkout-v2");

    expect(result.kind).toBe("matched");
    if (result.kind === "matched") {
      expect(result.record.branch).toBe("checkout-v2");
    }
  });

  it("returns ambiguous-slug when slug maps to multiple distinct branches", () => {
    const records = [
      record({ branch: "main-checkout-v2", slug: "checkout-v2" }),
      record({ branch: "release-checkout-v2", slug: "checkout-v2" }),
    ];

    const result = matchFeatureRecord(records, "checkout-v2");

    expect(result).toEqual({
      kind: "ambiguous-slug",
      value: "checkout-v2",
      branches: ["main-checkout-v2", "release-checkout-v2"],
    });
  });

  it("falls back to unique slug lookup", () => {
    const records = [
      record({ branch: "legacy-main--checkout-v2", slug: "checkout-v2" }),
    ];

    expect(matchFeatureRecord(records, "checkout-v2")).toMatchObject({
      kind: "matched",
      record: { branch: "legacy-main--checkout-v2" },
    });
  });

  it("returns not-found for unknown query", () => {
    const result = matchFeatureRecord(
      [record({ branch: "checkout-v2" })],
      "non-existing",
    );

    expect(result).toEqual({
      kind: "not-found",
      value: "non-existing",
    });
  });
});
