import { describe, expect, it } from "vitest";

import { checkBaseBranchFreshness } from "./guards.js";

const ok = (
  stdout = "",
): { exitCode: number; stdout: string; stderr: string } => ({
  exitCode: 0,
  stdout,
  stderr: "",
});

const fail = (
  stderr = "err",
): { exitCode: number; stdout: string; stderr: string } => ({
  exitCode: 1,
  stdout: "",
  stderr,
});

describe("checkBaseBranchFreshness", () => {
  it("treats branches without upstream as fresh (non-blocking)", () => {
    const runGit = (args: string[]) => {
      if (args[0] === "rev-parse") return fail("no upstream");
      throw new Error(`unexpected: ${args.join(" ")}`);
    };

    expect(checkBaseBranchFreshness({ runGit, baseBranch: "main" })).toEqual({
      ok: true,
      upstream: null,
      behind: null,
    });
  });

  it("fails when base is behind upstream", () => {
    const runGit = (args: string[]) => {
      if (args[0] === "rev-parse") return ok("origin/main\n");
      if (args[0] === "rev-list") return ok("2\t0\n");
      throw new Error(`unexpected: ${args.join(" ")}`);
    };

    expect(checkBaseBranchFreshness({ runGit, baseBranch: "main" })).toEqual({
      ok: false,
      upstream: "origin/main",
      behind: 2,
    });
  });

  it("passes when base is not behind upstream", () => {
    const runGit = (args: string[]) => {
      if (args[0] === "rev-parse") return ok("origin/main\n");
      if (args[0] === "rev-list") return ok("0\t0\n");
      throw new Error(`unexpected: ${args.join(" ")}`);
    };

    expect(checkBaseBranchFreshness({ runGit, baseBranch: "main" })).toEqual({
      ok: true,
      upstream: "origin/main",
      behind: 0,
    });
  });
});
