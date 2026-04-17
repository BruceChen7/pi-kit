import { describe, expect, it } from "vitest";

import * as storage from "./storage.js";

const { findActiveFeatureConflicts, listFeatureRecords } = storage;

describe("storage", () => {
  it("does not expose local feature-record persistence helpers", () => {
    expect("writeFeatureRecord" in storage).toBe(false);
    expect("readFeatureRecord" in storage).toBe(false);
  });

  it("lists records from wt list json", () => {
    const wtListJson = JSON.stringify([
      {
        branch: "feat/main/a",
        path: "/tmp/a",
        commit: { timestamp: 100 },
      },
      {
        branch: "feat/release/2026-q2/b",
        path: "/tmp/b",
        commit: { timestamp: 200 },
      },
      {
        branch: "feat/c",
        path: "/tmp/c",
        commit: { timestamp: 150 },
      },
      {
        branch: "feature/legacy",
        path: "/tmp/legacy",
        commit: { timestamp: 300 },
      },
    ]);

    const records = listFeatureRecords(wtListJson);

    expect(records.map((r) => r.id)).toEqual([
      "feat-release-2026-q2-b",
      "feat-c",
      "feat-main-a",
    ]);
    expect(records[0]).toMatchObject({
      id: "feat-release-2026-q2-b",
      name: "b",
      branch: "feat/release/2026-q2/b",
      worktreePath: "/tmp/b",
      base: "release/2026-q2",
    });
    expect(records[1]).toMatchObject({
      id: "feat-c",
      branch: "feat/c",
      base: "",
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
          branch: "feat/main/another-feature",
          path: "/tmp/another-feature",
          commit: { timestamp: 100 },
        },
      ]),
    );

    expect(
      findActiveFeatureConflicts(activeRecords, {
        id: "feat-main-checkout-v2",
        branch: "feat/main/checkout-v2",
      }),
    ).toEqual({
      idConflict: false,
      branchConflict: false,
    });
  });

  it("detects branch conflict while keeping ids base-aware", () => {
    const activeRecords = listFeatureRecords(
      JSON.stringify([
        {
          branch: "feat/main/checkout-v2",
          path: "/tmp/checkout-v2",
          commit: { timestamp: 100 },
        },
        {
          branch: "feat/release/2026-q2/checkout-v2",
          path: "/tmp/release-checkout-v2",
          commit: { timestamp: 90 },
        },
      ]),
    );

    expect(
      findActiveFeatureConflicts(activeRecords, {
        id: "feat-main-checkout-v2",
        branch: "feat/main/checkout-v2",
      }),
    ).toEqual({
      idConflict: true,
      branchConflict: true,
    });
  });

  it("does not report id conflict for same slug on different base", () => {
    const activeRecords = listFeatureRecords(
      JSON.stringify([
        {
          branch: "feat/main/checkout-v2",
          path: "/tmp/checkout-v2",
          commit: { timestamp: 100 },
        },
      ]),
    );

    expect(
      findActiveFeatureConflicts(activeRecords, {
        id: "feat-release-2026-q2-checkout-v2",
        branch: "feat/release/2026-q2/checkout-v2",
      }),
    ).toEqual({
      idConflict: false,
      branchConflict: false,
    });
  });
});
