import { describe, expect, it } from "vitest";

import * as storage from "./storage.js";

const { findActiveFeatureConflicts, listFeatureRecords } = storage;

describe("storage", () => {
  it("does not expose local feature-record persistence helpers", () => {
    expect("writeFeatureRecord" in storage).toBe(false);
    expect("readFeatureRecord" in storage).toBe(false);
  });

  it("lists only managed records from wt list json", () => {
    const wtListJson = JSON.stringify([
      {
        branch: "main/a",
        path: "/tmp/a",
        commit: { timestamp: 100 },
      },
      {
        branch: "release/2026-q2/b",
        path: "/tmp/b",
        commit: { timestamp: 200 },
      },
      {
        branch: "user/demo",
        path: "/tmp/demo",
        commit: { timestamp: 150 },
      },
      {
        branch: "main/no-worktree",
        commit: { timestamp: 300 },
      },
    ]);

    const records = listFeatureRecords(wtListJson, [
      "main/a",
      "release/2026-q2/b",
    ]);

    expect(records.map((r) => r.branch)).toEqual([
      "release/2026-q2/b",
      "main/a",
    ]);
    expect(records[0]).toMatchObject({
      name: "b",
      branch: "release/2026-q2/b",
      worktreePath: "/tmp/b",
      base: "release/2026-q2",
    });
    expect(records.some((record) => record.branch === "user/demo")).toBe(false);
    const topRecord = records[0];
    expect(topRecord).toBeDefined();
    if (topRecord) {
      expect(Object.hasOwn(topRecord, "sessionPath")).toBe(false);
    }
  });

  it("returns empty list when no managed branches are provided", () => {
    const records = listFeatureRecords(
      JSON.stringify([
        {
          branch: "main--checkout-v2",
          path: "/tmp/checkout-v2",
          commit: { timestamp: 100 },
        },
      ]),
      [],
    );

    expect(records).toEqual([]);
  });

  it("detects no conflict when active records differ", () => {
    const activeRecords = listFeatureRecords(
      JSON.stringify([
        {
          branch: "main--another-feature",
          path: "/tmp/another-feature",
          commit: { timestamp: 100 },
        },
      ]),
      ["main--another-feature"],
    );

    expect(
      findActiveFeatureConflicts(activeRecords, {
        branch: "main--checkout-v2",
      }),
    ).toEqual({
      branchConflict: false,
    });
  });

  it("detects branch conflict", () => {
    const activeRecords = listFeatureRecords(
      JSON.stringify([
        {
          branch: "main--checkout-v2",
          path: "/tmp/checkout-v2",
          commit: { timestamp: 100 },
        },
        {
          branch: "release%2F2026-q2--checkout-v2",
          path: "/tmp/release-checkout-v2",
          commit: { timestamp: 90 },
        },
      ]),
      [
        "main--checkout-v2",
        "release%2F2026-q2--checkout-v2",
      ],
    );

    expect(
      findActiveFeatureConflicts(activeRecords, {
        branch: "main--checkout-v2",
      }),
    ).toEqual({
      branchConflict: true,
    });
  });
});
