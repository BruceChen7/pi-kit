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
  wasFreshlyWritten: false,
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

  it("allows follow-up edits for targets that were freshly written", () => {
    expect(
      decideToolBlock(
        input({ targets: [target({ wasFreshlyWritten: true })] }),
      ),
    ).toBe(undefined);
  });

  it("allows writes outside cwd in act phase (no plan-phase write guard)", () => {
    expect(
      decideToolBlock(
        input({
          isPlanPhase: false,
          targets: [
            target({
              isInsideCwd: false,
              exists: false,
              rawPath: "/tmp/outside.ts",
            }),
          ],
        }),
      ),
    ).toBeUndefined();
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
