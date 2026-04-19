import { describe, expect, it } from "vitest";

import type { GitRunner, StatusOutput } from "../shared/git.js";

import {
  filterInferredBaseCandidateBranches,
  inferBaseBranch,
} from "./infer-base-branch.js";

type ResponseMap = Record<string, StatusOutput>;

const ok = (stdout: string): StatusOutput => ({
  exitCode: 0,
  stdout,
  stderr: "",
});

const fail = (stderr: string = "fail"): StatusOutput => ({
  exitCode: 1,
  stdout: "",
  stderr,
});

const keyFor = (args: string[]): string => JSON.stringify(args);

const createRunGit =
  (responses: ResponseMap): GitRunner =>
  (args) =>
    responses[keyFor(args)] ?? fail(`Unexpected git args: ${args.join(" ")}`);

describe("filterInferredBaseCandidateBranches", () => {
  it("keeps only main/master/release* branches", () => {
    expect(
      filterInferredBaseCandidateBranches([
        "main",
        "master",
        "release",
        "release/2026-q2",
        "release-1.2",
        "feature/demo",
        "user/demo",
        "main",
        "",
      ]),
    ).toEqual(["main", "master", "release", "release/2026-q2", "release-1.2"]);
  });
});

describe("inferBaseBranch", () => {
  it("returns unknown for detached head", () => {
    expect(
      inferBaseBranch({
        currentBranch: null,
        localBranches: ["main"],
        runGit: createRunGit({}),
      }),
    ).toEqual({
      kind: "unknown",
      reason: "detached-head",
    });
  });

  it("returns unknown when no baseline candidates exist", () => {
    expect(
      inferBaseBranch({
        currentBranch: "feature/demo",
        localBranches: ["dev", "feature/demo"],
        runGit: createRunGit({}),
      }),
    ).toEqual({
      kind: "unknown",
      reason: "no-candidates",
    });
  });

  it("returns unknown when no candidate yields graph evidence", () => {
    const runGit = createRunGit({
      [keyFor(["merge-base", "--fork-point", "main", "feature/demo"])]: fail(),
      [keyFor(["merge-base", "main", "feature/demo"])]: fail(),
    });

    expect(
      inferBaseBranch({
        currentBranch: "feature/demo",
        localBranches: ["main"],
        runGit,
      }),
    ).toEqual({
      kind: "unknown",
      reason: "no-graph-signal",
    });
  });

  it("resolves main via fork-point with high confidence", () => {
    const runGit = createRunGit({
      [keyFor(["merge-base", "--fork-point", "main", "feature/demo"])]:
        ok("abc123\n"),
      [keyFor(["rev-list", "--count", "abc123..main"])]: ok("0\n"),
      [keyFor(["rev-list", "--count", "abc123..feature/demo"])]: ok("3\n"),
      [keyFor(["merge-base", "--fork-point", "master", "feature/demo"])]:
        fail(),
      [keyFor(["merge-base", "master", "feature/demo"])]: ok("base-master\n"),
      [keyFor(["rev-list", "--count", "base-master..master"])]: ok("8\n"),
      [keyFor(["rev-list", "--count", "base-master..feature/demo"])]: ok("7\n"),
      [keyFor([
        "merge-base",
        "--fork-point",
        "release/2026-q2",
        "feature/demo",
      ])]: fail(),
      [keyFor(["merge-base", "release/2026-q2", "feature/demo"])]:
        ok("base-release\n"),
      [keyFor(["rev-list", "--count", "base-release..release/2026-q2"])]:
        ok("12\n"),
      [keyFor(["rev-list", "--count", "base-release..feature/demo"])]:
        ok("9\n"),
    });

    expect(
      inferBaseBranch({
        currentBranch: "feature/demo",
        localBranches: ["main", "master", "release/2026-q2"],
        runGit,
      }),
    ).toEqual({
      kind: "resolved",
      branch: "main",
      basis: "fork-point",
      confidence: "high",
    });
  });

  it("uses merge-base fallback with medium confidence when clearly ahead", () => {
    const runGit = createRunGit({
      [keyFor([
        "merge-base",
        "--fork-point",
        "release/2026-q2",
        "feature/demo",
      ])]: fail(),
      [keyFor(["merge-base", "release/2026-q2", "feature/demo"])]:
        ok("release-base\n"),
      [keyFor(["rev-list", "--count", "release-base..release/2026-q2"])]:
        ok("1\n"),
      [keyFor(["rev-list", "--count", "release-base..feature/demo"])]:
        ok("4\n"),
      [keyFor(["merge-base", "--fork-point", "main", "feature/demo"])]: fail(),
      [keyFor(["merge-base", "main", "feature/demo"])]: ok("main-base\n"),
      [keyFor(["rev-list", "--count", "main-base..main"])]: ok("9\n"),
      [keyFor(["rev-list", "--count", "main-base..feature/demo"])]: ok("10\n"),
    });

    expect(
      inferBaseBranch({
        currentBranch: "feature/demo",
        localBranches: ["main", "release/2026-q2"],
        runGit,
      }),
    ).toEqual({
      kind: "resolved",
      branch: "release/2026-q2",
      basis: "merge-base",
      confidence: "medium",
    });
  });

  it("breaks main/master ties in favor of main with low confidence", () => {
    const runGit = createRunGit({
      [keyFor(["merge-base", "--fork-point", "main", "feature/demo"])]: fail(),
      [keyFor(["merge-base", "main", "feature/demo"])]: ok("shared\n"),
      [keyFor(["rev-list", "--count", "shared..main"])]: ok("0\n"),
      [keyFor(["rev-list", "--count", "shared..feature/demo"])]: ok("2\n"),
      [keyFor(["merge-base", "--fork-point", "master", "feature/demo"])]:
        fail(),
      [keyFor(["merge-base", "master", "feature/demo"])]: ok("shared\n"),
      [keyFor(["rev-list", "--count", "shared..master"])]: ok("0\n"),
      [keyFor(["rev-list", "--count", "shared..feature/demo"])]: ok("2\n"),
    });

    expect(
      inferBaseBranch({
        currentBranch: "feature/demo",
        localBranches: ["master", "main"],
        runGit,
      }),
    ).toEqual({
      kind: "resolved",
      branch: "main",
      basis: "merge-base",
      confidence: "low",
    });
  });

  it("returns ambiguous for indistinguishable release candidates", () => {
    const runGit = createRunGit({
      [keyFor([
        "merge-base",
        "--fork-point",
        "release/2026-q2",
        "feature/demo",
      ])]: fail(),
      [keyFor(["merge-base", "release/2026-q2", "feature/demo"])]:
        ok("shared\n"),
      [keyFor(["rev-list", "--count", "shared..release/2026-q2"])]: ok("0\n"),
      [keyFor(["rev-list", "--count", "shared..feature/demo"])]: ok("2\n"),
      [keyFor([
        "merge-base",
        "--fork-point",
        "release/2026-q3",
        "feature/demo",
      ])]: fail(),
      [keyFor(["merge-base", "release/2026-q3", "feature/demo"])]:
        ok("shared\n"),
      [keyFor(["rev-list", "--count", "shared..release/2026-q3"])]: ok("0\n"),
      [keyFor(["rev-list", "--count", "shared..feature/demo"])]: ok("2\n"),
    });

    expect(
      inferBaseBranch({
        currentBranch: "feature/demo",
        localBranches: ["release/2026-q3", "release/2026-q2"],
        runGit,
      }),
    ).toEqual({
      kind: "ambiguous",
      candidates: ["release/2026-q2", "release/2026-q3"],
    });
  });
});
