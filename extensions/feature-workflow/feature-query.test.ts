import { describe, expect, it } from "vitest";

import { matchFeatureRecord } from "./feature-query.js";
import type { FeatureRecord } from "./storage.js";

const record = (overrides: Partial<FeatureRecord> = {}): FeatureRecord => {
  const branch = overrides.branch ?? "checkout-v2";

  return {
    slug: branch,
    branch,
    worktreePath: `/tmp/${branch}`,
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
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
