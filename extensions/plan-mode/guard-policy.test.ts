import { describe, expect, it } from "vitest";
import {
  decideToolBlock,
  type GuardPolicyInput,
  type GuardPolicyTarget,
} from "./guard-policy.js";

const target = (
  overrides: Partial<GuardPolicyTarget> = {},
): GuardPolicyTarget => ({
  rawPath: "src/example.ts",
  exists: true,
  isInsideCwd: true,
  isReviewArtifact: false,
  wasRead: false,
  ...overrides,
});

const input = (
  overrides: Partial<GuardPolicyInput> = {},
): GuardPolicyInput => ({
  internalExtensionBypass: false,
  isPlanPhase: false,
  readBeforeWrite: true,
  toolName: "edit",
  todoToolName: "act_mode_todo",
  isWriteTool: true,
  isPathGuardedTool: true,
  targetResult: { kind: "paths", paths: [{ rawPath: "src/example.ts" }] },
  targets: [target()],
  ...overrides,
});

describe("plan-mode guard policy", () => {
  it("blocks existing writes that have not been read first", () => {
    expect(decideToolBlock(input())).toMatchObject({
      block: true,
      reason: expect.stringContaining("read the file first"),
    });
  });

  it("allows write targets that were read first", () => {
    expect(
      decideToolBlock(input({ targets: [target({ wasRead: true })] })),
    ).toBe(undefined);
  });

  it("blocks writes outside cwd before read-before-write checks", () => {
    expect(
      decideToolBlock(
        input({
          targets: [target({ isInsideCwd: false, rawPath: "/tmp/outside.ts" })],
        }),
      ),
    ).toMatchObject({
      block: true,
      reason: expect.stringContaining("path is outside cwd"),
    });
  });

  it("allows read-only tools outside cwd", () => {
    expect(
      decideToolBlock(
        input({
          toolName: "read",
          isWriteTool: false,
          targets: [target({ isInsideCwd: false, rawPath: "/tmp/outside.ts" })],
        }),
      ),
    ).toBeUndefined();
  });

  it("allows plan-phase writes only when every target is a review artifact", () => {
    expect(
      decideToolBlock(
        input({
          isPlanPhase: true,
          targets: [target({ isReviewArtifact: true })],
        }),
      ),
    ).toBeUndefined();

    expect(decideToolBlock(input({ isPlanPhase: true }))).toMatchObject({
      block: true,
      reason: expect.stringContaining("current phase can only write"),
    });
  });
});
