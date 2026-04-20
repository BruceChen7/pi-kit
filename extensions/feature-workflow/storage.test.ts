import { describe, expect, it } from "vitest";

import * as storage from "./storage.js";

const { hasActiveFeatureBranchConflict, listFeatureRecords } = storage;

describe("storage", () => {
  it("does not expose local feature-record persistence helpers", () => {
    expect("writeFeatureRecord" in storage).toBe(false);
    expect("readFeatureRecord" in storage).toBe(false);
  });

  it("lists active worktree records directly from wt list json", () => {
    const wtListJson = JSON.stringify([
      {
        branch: "checkout-v2",
        path: "/tmp/checkout-v2",
        commit: { timestamp: 100 },
      },
      {
        branch: "legacy-main--login-timeout",
        path: "/tmp/login-timeout",
        commit: { timestamp: 200 },
      },
      {
        branch: "user/demo",
        path: "/tmp/demo",
        commit: { timestamp: 150 },
      },
      {
        branch: "no-worktree",
        commit: { timestamp: 300 },
      },
    ]);

    const records = listFeatureRecords(wtListJson);

    expect(records.map((r) => r.branch)).toEqual([
      "legacy-main--login-timeout",
      "user/demo",
      "checkout-v2",
    ]);
    expect(records[0]).toMatchObject({
      slug: "legacy-main--login-timeout",
      branch: "legacy-main--login-timeout",
      worktreePath: "/tmp/login-timeout",
    });
    const topRecord = records[0];
    expect(topRecord).toBeDefined();
    if (topRecord) {
      expect(Object.hasOwn(topRecord, "sessionPath")).toBe(false);
    }
  });

  it("detects no conflict when active records differ", () => {
    const activeRecords = listFeatureRecords(
      JSON.stringify([
        {
          branch: "another-feature",
          path: "/tmp/another-feature",
          commit: { timestamp: 100 },
        },
      ]),
    );

    expect(hasActiveFeatureBranchConflict(activeRecords, "checkout-v2")).toBe(
      false,
    );
  });

  it("detects branch conflict when branch names are identical", () => {
    const activeRecords = listFeatureRecords(
      JSON.stringify([
        {
          branch: "checkout-v2",
          path: "/tmp/checkout-v2",
          commit: { timestamp: 100 },
        },
      ]),
    );

    expect(hasActiveFeatureBranchConflict(activeRecords, "checkout-v2")).toBe(
      true,
    );
  });

  it("does not treat different branches as conflicts anymore", () => {
    const activeRecords = listFeatureRecords(
      JSON.stringify([
        {
          branch: "legacy-main--checkout-v2",
          path: "/tmp/legacy-checkout-v2",
          commit: { timestamp: 90 },
        },
      ]),
    );

    expect(hasActiveFeatureBranchConflict(activeRecords, "checkout-v2")).toBe(
      false,
    );
  });
});
