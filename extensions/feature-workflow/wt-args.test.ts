import { describe, expect, it } from "vitest";

import { buildWtSwitchCreateArgs } from "./wt.js";

describe("buildWtSwitchCreateArgs", () => {
  it("builds stable args for creating a worktree", () => {
    expect(
      buildWtSwitchCreateArgs({
        branch: "feat/main/checkout-v2",
        base: "main",
      }),
    ).toEqual([
      "switch",
      "--create",
      "feat/main/checkout-v2",
      "--base",
      "main",
      "--no-cd",
      "--yes",
    ]);
  });
});
