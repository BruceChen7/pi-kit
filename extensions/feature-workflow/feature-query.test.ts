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
  it("matches by branch name", () => {
    expect(
      matchFeatureRecord([record({ branch: "checkout-v2" })], "checkout-v2"),
    ).toMatchObject({
      kind: "matched",
      record: { branch: "checkout-v2" },
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

  it("does not match slug aliases when branch differs", () => {
    const result = matchFeatureRecord(
      [record({ branch: "legacy-main--checkout-v2", slug: "checkout-v2" })],
      "checkout-v2",
    );

    expect(result).toEqual({
      kind: "not-found",
      value: "checkout-v2",
    });
  });
});
