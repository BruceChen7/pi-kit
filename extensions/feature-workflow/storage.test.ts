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

    const records = listFeatureRecords(wtListJson, [
      {
        branch: "checkout-v2",
        slug: "checkout-v2",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        branch: "legacy-main--login-timeout",
        slug: "login-timeout",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    expect(records.map((r) => r.branch)).toEqual([
      "legacy-main--login-timeout",
      "checkout-v2",
    ]);
    expect(records[0]).toMatchObject({
      name: "login-timeout",
      slug: "login-timeout",
      branch: "legacy-main--login-timeout",
      worktreePath: "/tmp/login-timeout",
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
          branch: "checkout-v2",
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
          branch: "another-feature",
          path: "/tmp/another-feature",
          commit: { timestamp: 100 },
        },
      ]),
      [
        {
          branch: "another-feature",
          slug: "another-feature",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    );

    expect(
      findActiveFeatureConflicts(activeRecords, {
        branch: "checkout-v2",
        slug: "checkout-v2",
      }),
    ).toEqual({
      branchConflict: false,
      slugConflict: false,
    });
  });

  it("detects branch conflict", () => {
    const activeRecords = listFeatureRecords(
      JSON.stringify([
        {
          branch: "checkout-v2",
          path: "/tmp/checkout-v2",
          commit: { timestamp: 100 },
        },
        {
          branch: "legacy-main--checkout-v2",
          path: "/tmp/legacy-checkout-v2",
          commit: { timestamp: 90 },
        },
      ]),
      [
        {
          branch: "checkout-v2",
          slug: "checkout-v2",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          branch: "legacy-main--checkout-v2",
          slug: "checkout-v2",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    );

    expect(
      findActiveFeatureConflicts(activeRecords, {
        branch: "checkout-v2",
        slug: "checkout-v2",
      }),
    ).toEqual({
      branchConflict: true,
      slugConflict: true,
    });
  });
});
