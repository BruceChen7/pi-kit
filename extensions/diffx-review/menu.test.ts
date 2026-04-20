import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { getDiffxReviewBranchSelectionState } from "./menu.ts";

describe("diffx-review menu", () => {
  it("includes remote-tracking branches and prefers the remote default branch", async () => {
    const exec = async (_command: string, args: string[]) => {
      if (args[0] === "for-each-ref") {
        return {
          code: 0,
          stdout: [
            "feature/test",
            "main",
            "origin/feature/test",
            "origin/main",
            "origin/release",
            "",
          ].join("\n"),
          stderr: "",
        };
      }

      if (args[0] === "branch" && args[1] === "--show-current") {
        return {
          code: 0,
          stdout: "feature/test\n",
          stderr: "",
        };
      }

      if (args[0] === "symbolic-ref") {
        return {
          code: 0,
          stdout: "origin/main\n",
          stderr: "",
        };
      }

      throw new Error(`Unexpected git args: ${args.join(" ")}`);
    };

    const result = await getDiffxReviewBranchSelectionState({
      exec,
    } as unknown as ExtensionAPI);

    expect(result.defaultBranch).toBe("origin/main");
    expect(result.currentBranch).toBe("feature/test");
    expect(result.branches).toEqual([
      "origin/main",
      "main",
      "origin/feature/test",
      "origin/release",
    ]);
  });
});
