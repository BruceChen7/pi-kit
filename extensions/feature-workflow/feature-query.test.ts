import { describe, expect, it } from "vitest";

import {
  buildFeatureSwitchCandidates,
  matchFeatureRecord,
  matchFeatureSwitchCandidate,
} from "./feature-query.js";
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

describe("buildFeatureSwitchCandidates", () => {
  it("adds remote-only origin branches after worktree candidates", () => {
    const candidates = buildFeatureSwitchCandidates({
      records: [record({ branch: "checkout-v2" })],
      originBranches: ["kanban-v2"],
    });

    expect(candidates).toMatchObject([
      {
        kind: "worktree",
        branch: "checkout-v2",
        displayLabel: "checkout-v2",
        fallbackWorktreePath: "/tmp/checkout-v2",
        matchKeys: ["checkout-v2"],
      },
      {
        kind: "remote",
        branch: "kanban-v2",
        displayLabel: "kanban-v2 (remote)",
        fallbackWorktreePath: "",
        matchKeys: ["kanban-v2", "origin/kanban-v2"],
      },
    ]);
  });

  it("keeps a single worktree candidate when the same origin branch exists", () => {
    const candidates = buildFeatureSwitchCandidates({
      records: [record({ branch: "kanban-v2" })],
      originBranches: ["kanban-v2"],
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      kind: "worktree",
      branch: "kanban-v2",
      displayLabel: "kanban-v2",
      matchKeys: ["kanban-v2", "origin/kanban-v2"],
      remoteRef: "origin/kanban-v2",
    });
  });
});

describe("matchFeatureSwitchCandidate", () => {
  it("matches remote-only candidates by bare branch name", () => {
    const candidates = buildFeatureSwitchCandidates({
      records: [],
      originBranches: ["kanban-v2"],
    });

    expect(matchFeatureSwitchCandidate(candidates, "kanban-v2")).toMatchObject({
      kind: "matched",
      candidate: {
        kind: "remote",
        branch: "kanban-v2",
      },
    });
  });

  it("matches remote-only candidates by origin-prefixed branch name", () => {
    const candidates = buildFeatureSwitchCandidates({
      records: [],
      originBranches: ["kanban-v2"],
    });

    expect(
      matchFeatureSwitchCandidate(candidates, "origin/kanban-v2"),
    ).toMatchObject({
      kind: "matched",
      candidate: {
        kind: "remote",
        branch: "kanban-v2",
      },
    });
  });

  it("prefers the worktree candidate when the same branch exists locally", () => {
    const candidates = buildFeatureSwitchCandidates({
      records: [record({ branch: "kanban-v2" })],
      originBranches: ["kanban-v2"],
    });

    expect(matchFeatureSwitchCandidate(candidates, "kanban-v2")).toMatchObject({
      kind: "matched",
      candidate: {
        kind: "worktree",
        branch: "kanban-v2",
      },
    });
    expect(
      matchFeatureSwitchCandidate(candidates, "origin/kanban-v2"),
    ).toMatchObject({
      kind: "matched",
      candidate: {
        kind: "worktree",
        branch: "kanban-v2",
      },
    });
  });
});
