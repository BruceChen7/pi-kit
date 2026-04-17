import { describe, expect, it } from "vitest";

import { matchFeatureRecord } from "./feature-query.js";
import type { FeatureRecord } from "./storage.js";

const normalizeBaseForId = (base: string): string =>
  base
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");

const record = (input: {
  branch: string;
  base?: string;
  slug?: string;
  id?: string;
}): FeatureRecord => {
  const slug = input.slug ?? input.branch.split("/").at(-1) ?? "unknown";
  const base = input.base ?? "main";
  const normalizedBase = normalizeBaseForId(base);
  const id =
    input.id ??
    (normalizedBase ? `feat-${normalizedBase}-${slug}` : `feat-${slug}`);
  return {
    id,
    name: slug,
    type: "feat",
    slug,
    branch: input.branch,
    base,
    worktreePath: `/tmp/${slug}`,
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
};

describe("matchFeatureRecord", () => {
  it("matches canonical branch before alias fields", () => {
    const records = [
      record({
        branch: "feat/release/2026-q2/checkout-v2",
        base: "release/2026-q2",
        slug: "checkout-v2",
      }),
      record({ branch: "feat/main/checkout-v2", slug: "checkout-v2" }),
    ];

    const result = matchFeatureRecord(records, "feat/main/checkout-v2");

    expect(result.kind).toBe("matched");
    if (result.kind === "matched") {
      expect(result.record.branch).toBe("feat/main/checkout-v2");
    }
  });

  it("returns ambiguous-id when alias maps to multiple branches", () => {
    const records = [
      record({
        branch: "feat/release/2026-q2/checkout-v2",
        base: "release/2026-q2",
        slug: "checkout-v2",
        id: "feat-release-2026-q2-checkout-v2",
      }),
      record({
        branch: "feat/release-2026-q2/checkout-v2",
        base: "release-2026-q2",
        slug: "checkout-v2",
        id: "feat-release-2026-q2-checkout-v2",
      }),
    ];

    const result = matchFeatureRecord(
      records,
      "feat-release-2026-q2-checkout-v2",
    );

    expect(result).toEqual({
      kind: "ambiguous-id",
      value: "feat-release-2026-q2-checkout-v2",
      branches: [
        "feat/release/2026-q2/checkout-v2",
        "feat/release-2026-q2/checkout-v2",
      ],
    });
  });

  it("returns ambiguous-slug when slug maps to multiple branches", () => {
    const records = [
      record({ branch: "feat/main/checkout-v2", slug: "checkout-v2" }),
      record({
        branch: "feat/release/2026-q2/checkout-v2",
        base: "release/2026-q2",
        slug: "checkout-v2",
      }),
    ];

    const result = matchFeatureRecord(records, "checkout-v2");

    expect(result).toEqual({
      kind: "ambiguous-slug",
      value: "checkout-v2",
      branches: ["feat/main/checkout-v2", "feat/release/2026-q2/checkout-v2"],
    });
  });

  it("falls back to unique id and slug lookups", () => {
    const records = [record({ branch: "feat/main/checkout-v2" })];

    expect(matchFeatureRecord(records, "feat-main-checkout-v2")).toMatchObject({
      kind: "matched",
      record: { branch: "feat/main/checkout-v2" },
    });

    expect(matchFeatureRecord(records, "checkout-v2")).toMatchObject({
      kind: "matched",
      record: { branch: "feat/main/checkout-v2" },
    });
  });

  it("returns not-found for unknown query", () => {
    const result = matchFeatureRecord(
      [record({ branch: "feat/main/checkout-v2" })],
      "feat/main/non-existing",
    );

    expect(result).toEqual({
      kind: "not-found",
      value: "feat/main/non-existing",
    });
  });
});
