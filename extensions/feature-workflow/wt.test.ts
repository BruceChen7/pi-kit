import { describe, expect, it } from "vitest";

import { parseWtJsonResult } from "./wt.js";

describe("parseWtJsonResult", () => {
  it("parses the last JSON object line from mixed output", () => {
    const stdout = [
      "○ Already on worktree for main",
      '{"action":"already_at","branch":"main","path":"/repo"}',
    ].join("\n");

    expect(parseWtJsonResult(stdout)).toEqual({
      action: "already_at",
      branch: "main",
      path: "/repo",
    });
  });

  it("returns null when no JSON is present", () => {
    expect(parseWtJsonResult("no json here")).toBeNull();
  });
});
