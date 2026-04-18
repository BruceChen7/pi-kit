import { describe, expect, it } from "vitest";

import { buildBaseBranchCandidates } from "./base-branches.js";

describe("buildBaseBranchCandidates", () => {
  it("prioritizes non-feature current branch, then main/master, then release* branches", () => {
    const result = buildBaseBranchCandidates({
      currentBranch: "dev",
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
      "dev",
      "main",
      "master",
      "release",
      "release-1.2",
      "release/2026-04",
      "bugfix/x",
    ]);
  });

  it("prioritizes parsed base when current branch is already a feature branch", () => {
    const result = buildBaseBranchCandidates({
      currentBranch: "feat/main/checkout-v2",
      localBranches: [
        "main",
        "master",
        "release/2026-04",
        "feat/main/checkout-v2",
        "dev",
      ],
    });

    expect(result).toEqual([
      "main",
      "master",
      "release/2026-04",
      "dev",
      "feat/main/checkout-v2",
    ]);
  });

  it("does not prioritize unsupported old-format feature branches", () => {
    const result = buildBaseBranchCandidates({
      currentBranch: "fix/my-work",
      localBranches: ["main", "fix/my-work", "dev"],
    });

    expect(result).toEqual(["main", "dev", "fix/my-work"]);
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
      localBranches: ["main", "main", "release", "release"],
    });

    expect(result).toEqual(["main", "release"]);
  });
});
