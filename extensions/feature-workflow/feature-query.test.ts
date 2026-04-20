import { describe, expect, it } from "vitest";

import { matchFeatureRecord } from "./feature-query.js";
import type { FeatureRecord } from "./storage.js";

const record = (branch: string): FeatureRecord => ({
  slug: branch,
  branch,
  worktreePath: `/tmp/${branch}`,
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("matchFeatureRecord", () => {
  it("matches by branch name", () => {
    const result = matchFeatureRecord(
      [record("checkout-v2"), record("login-timeout")],
      "checkout-v2",
    );

    expect(result).toEqual({
      kind: "matched",
      record: expect.objectContaining({ branch: "checkout-v2" }),
    });
  });

  it("returns not-found for unknown query", () => {
    const result = matchFeatureRecord([record("checkout-v2")], "non-existing");

    expect(result).toEqual({
      kind: "not-found",
      value: "non-existing",
    });
  });
});
