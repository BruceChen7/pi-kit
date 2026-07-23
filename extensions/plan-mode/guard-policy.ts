import {
  PLAN_INSPECTION_TOOL_COMMA_LIST,
  REVIEW_ARTIFACT_WRITE_GUIDANCE,
} from "./constants.ts";
import type { ToolTargetPathResult } from "./guards.ts";

export type GuardPolicyTarget = {
  rawPath: string;
  exists: boolean;
  isInsideCwd: boolean;
  isReviewArtifact: boolean;
  wasRead: boolean;
  wasFreshlyWritten: boolean;
};

export type GuardPolicyInput = {
  internalExtensionBypass: boolean;
  isPlanPhase: boolean;
  readBeforeWrite: boolean;
  toolName: string;
  todoToolName: string;
  isWriteTool: boolean;
  isPathGuardedTool: boolean;
  targetResult: ToolTargetPathResult;
  targets: GuardPolicyTarget[];
};

export type GuardPolicyBlock = {
  block: true;
  reason: string;
};

export const decideToolBlock = (
  input: GuardPolicyInput,
): GuardPolicyBlock | undefined => {
  if (input.internalExtensionBypass) {
    return undefined;
  }

  if (input.isPlanPhase && input.toolName === "bash") {
    return {
      block: true,
      reason:
        `plan-mode blocked ${input.toolName}: current phase is read-only. ` +
        `Use ${PLAN_INSPECTION_TOOL_COMMA_LIST}, and ${input.todoToolName}.`,
    };
  }

  if (input.isPlanPhase && input.isWriteTool) {
    const writesOnlyReviewArtifacts =
      input.targetResult.kind === "paths" &&
      input.targets.length > 0 &&
      input.targets.every((target) => target.isReviewArtifact);
    if (writesOnlyReviewArtifacts) {
      return undefined;
    }

    return {
      block: true,
      reason:
        `plan-mode blocked ${input.toolName}: current phase can only write ` +
        REVIEW_ARTIFACT_WRITE_GUIDANCE,
    };
  }

  if (!input.readBeforeWrite || !input.isPathGuardedTool) {
    return undefined;
  }

  if (input.targetResult.kind === "unresolved-write") {
    return {
      block: true,
      reason: `plan-mode blocked ${input.toolName}: ${input.targetResult.reason}`,
    };
  }

  if (!input.isWriteTool) {
    return undefined;
  }

  for (const target of input.targets) {
    // No outside-cwd check — in plan phase writes are already blocked above,
    // and in act phase the user has approved a plan so the agent should be
    // trusted to write where it needs (including /tmp or other legitimate
    // locations outside the project). The read-before-write check below
    // still protects existing files.
    if (target.exists && !target.wasRead && !target.wasFreshlyWritten) {
      return {
        block: true,
        reason:
          `plan-mode blocked ${input.toolName}: read the file first before ` +
          `modifying it: ${target.rawPath}`,
      };
    }
  }

  return undefined;
};
