import { describe, expect, it } from "vitest";

import {
  listFeatureRecordsFromWtList,
  listPruneCandidatesFromWtList,
  listSwitchableFeatureRecordsFromWtList,
  resolvePrimaryWorktreePathFromWtList,
  resolveWorktreePathForBranchFromWtList,
} from "./wt-list.js";

describe("wt-list", () => {
  it("builds sorted feature records from wt list json", () => {
    const records = listFeatureRecordsFromWtList(
      JSON.stringify([
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
          branch: "missing-path",
          commit: { timestamp: 300 },
        },
      ]),
    );

    expect(records.map((record) => record.branch)).toEqual([
      "legacy-main--login-timeout",
      "checkout-v2",
    ]);
  });

  it("filters out the primary worktree when building switchable records", () => {
    const records = listSwitchableFeatureRecordsFromWtList(
      JSON.stringify([
        {
          branch: "main",
          path: "/repo",
          is_main: true,
          commit: { timestamp: 50 },
        },
        {
          branch: "checkout-v2",
          path: "/repo/.wt/checkout-v2",
          is_main: false,
          commit: { timestamp: 100 },
        },
      ]),
    );

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      branch: "checkout-v2",
      worktreePath: "/repo/.wt/checkout-v2",
    });
  });

  it("extracts prune candidates from merged or empty worktrees only", () => {
    const candidates = listPruneCandidatesFromWtList(
      JSON.stringify([
        {
          branch: "main",
          path: "/repo",
          is_main: true,
          main_state: "integrated",
        },
        {
          branch: "feature-a",
          path: "/repo/.wt/feature-a",
          is_main: false,
          main_state: "integrated",
        },
        {
          branch: "feature-b",
          path: "/repo/.wt/feature-b",
          is_main: false,
          main_state: "empty",
        },
        {
          branch: "feature-c",
          path: "/repo/.wt/feature-c",
          is_main: false,
          main_state: "ahead",
        },
      ]),
    );

    expect(candidates).toEqual([
      {
        branch: "feature-a",
        path: "/repo/.wt/feature-a",
        mainState: "integrated",
      },
      {
        branch: "feature-b",
        path: "/repo/.wt/feature-b",
        mainState: "empty",
      },
    ]);
  });

  it("resolves primary and branch-specific worktree paths", () => {
    const wtListJson = JSON.stringify([
      {
        branch: "main",
        path: "/repo",
        is_main: true,
      },
      {
        branch: "checkout-v2",
        path: "/repo/.wt/checkout-v2",
        is_main: false,
      },
    ]);

    expect(resolvePrimaryWorktreePathFromWtList(wtListJson)).toBe("/repo");
    expect(
      resolveWorktreePathForBranchFromWtList(wtListJson, "checkout-v2"),
    ).toBe("/repo/.wt/checkout-v2");
    expect(resolveWorktreePathForBranchFromWtList(wtListJson, "missing")).toBe(
      null,
    );
  });
});
