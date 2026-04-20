import { describe, expect, it } from "vitest";

import { buildBaseBranchCandidates } from "./base-branches.js";

describe("buildBaseBranchCandidates", () => {
  it("prioritizes inferred base, then current branch, then main/master, then release* branches", () => {
    const result = buildBaseBranchCandidates({
      currentBranch: "dev",
      inferredBaseBranch: "main",
      localBranches: [
        "main",
        "master",
        "release",
        "release/2026-04",
        "release-1.2",
        "dev",
        "bugfix/x",
      ],
    });

    expect(result).toEqual([
      "main",
      "dev",
      "master",
      "release",
      "release-1.2",
      "release/2026-04",
      "bugfix/x",
    ]);
  });

  it("falls back to current branch when inferred base is unavailable", () => {
    const result = buildBaseBranchCandidates({
      currentBranch: "user/demo",
      inferredBaseBranch: null,
      localBranches: ["main", "user/demo", "dev"],
    });

    expect(result).toEqual(["user/demo", "main", "dev"]);
  });

  it("ignores inferred base when it is not present locally", () => {
    const result = buildBaseBranchCandidates({
      currentBranch: "main--checkout-v2",
      inferredBaseBranch: "release/2026-04",
      localBranches: ["main", "master", "main--checkout-v2", "dev"],
    });

    expect(result).toEqual(["main--checkout-v2", "main", "master", "dev"]);
  });

  it("filters missing preferred branches and keeps deterministic ordering", () => {
    const result = buildBaseBranchCandidates({
      currentBranch: null,
      localBranches: ["dev", "release/2026-04", "hotfix"],
    });

    expect(result).toEqual(["release/2026-04", "dev", "hotfix"]);
  });

  it("dedupes branches", () => {
    const result = buildBaseBranchCandidates({
      currentBranch: "main",
      inferredBaseBranch: "main",
      localBranches: ["main", "main", "release", "release"],
    });

    expect(result).toEqual(["main", "release"]);
  });
});
