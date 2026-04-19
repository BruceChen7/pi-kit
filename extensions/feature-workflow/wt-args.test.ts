import { describe, expect, it } from "vitest";

import { buildWtSwitchCreateArgs } from "./wt.js";

describe("buildWtSwitchCreateArgs", () => {
  it("builds stable args for creating a worktree", () => {
    expect(
      buildWtSwitchCreateArgs({
        branch: "main--checkout-v2",
        base: "main",
      }),
    ).toEqual([
      "switch",
      "--create",
      "main--checkout-v2",
      "--base",
      "main",
      "--no-cd",
      "--yes",
    ]);
  });
});
