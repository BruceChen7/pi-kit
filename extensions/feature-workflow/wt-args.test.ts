import { describe, expect, it } from "vitest";

import { buildWtSwitchCreateArgs } from "./wt.js";

describe("buildWtSwitchCreateArgs", () => {
  it("builds stable args for creating a worktree", () => {
    expect(
      buildWtSwitchCreateArgs({
        branch: "checkout-v2",
        base: "main",
      }),
    ).toEqual([
      "switch",
      "--create",
      "checkout-v2",
      "--base",
      "main",
      "--no-cd",
      "--yes",
    ]);
  });
});
