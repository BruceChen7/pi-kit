import { describe, expect, it } from "vitest";

import { buildBaseBranchCandidates } from "./base-branches.js";

describe("buildBaseBranchCandidates", () => {
  it("prioritizes current branch, then main/master, then release* branches", () => {
    const result = buildBaseBranchCandidates({
      currentBranch: "feat/my-work",
      localBranches: [
        "main",
        "master",
        "release",
        "release/2026-04",
        "release-1.2",
        "feat/my-work",
        "bugfix/x",
      ],
    });

    expect(result).toEqual([
      "feat/my-work",
      "main",
      "master",
      "release",
      "release-1.2",
      "release/2026-04",
      "bugfix/x",
    ]);
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
