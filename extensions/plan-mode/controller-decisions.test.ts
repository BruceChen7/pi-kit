import { describe, expect, it } from "vitest";
import {
  decideAgentStartPostActions,
  decideAgentStartPreActions,
  decidePlanReviewObligation,
  getApprovedReviewPathToQueue,
  parsePlanModeBadgeEvent,
  parseReviewVerdictEvent,
} from "./controller-decisions.js";

const reviewArtifactPath = ".pi/plans/pi-kit/plan/2026-05-08-demo.md";

const approvedReviewQueueInput = {
  reviewArtifactPath,
  latestReviewArtifactPath: reviewArtifactPath,
  alreadyApproved: false,
  pendingApprovedPlanContinuationPath: null,
  confirmedApprovedContinuationPath: null,
  phase: "plan" as const,
  activePlanPath: null,
};

describe("plan-mode controller decisions", () => {
  it.each([
    {
      name: "parses an approved manual-review verdict",
      raw: {
        type: "plannotator-auto.review-verdict",
        cwd: "/repo",
        path: reviewArtifactPath,
        approved: true,
      },
      expected: {
        cwd: "/repo",
        path: reviewArtifactPath,
        approved: true,
      },
    },
    {
      name: "parses a rejected manual-review verdict",
      raw: {
        type: "plannotator-auto.review-verdict",
        cwd: "/repo",
        path: reviewArtifactPath,
        approved: false,
      },
      expected: {
        cwd: "/repo",
        path: reviewArtifactPath,
        approved: false,
      },
    },
    {
      name: "ignores another event type",
      raw: {
        type: "notify.idle",
        cwd: "/repo",
        path: reviewArtifactPath,
        approved: true,
      },
      expected: null,
    },
    {
      name: "ignores a verdict without cwd",
      raw: {
        type: "plannotator-auto.review-verdict",
        path: reviewArtifactPath,
        approved: true,
      },
      expected: null,
    },
    {
      name: "ignores a verdict without a path",
      raw: {
        type: "plannotator-auto.review-verdict",
        cwd: "/repo",
        approved: true,
      },
      expected: null,
    },
    {
      name: "ignores a non-boolean verdict",
      raw: {
        type: "plannotator-auto.review-verdict",
        cwd: "/repo",
        path: reviewArtifactPath,
        approved: "yes",
      },
      expected: null,
    },
    {
      name: "ignores a non-object payload",
      raw: "plannotator-auto.review-verdict",
      expected: null,
    },
  ])("$name", ({ raw, expected }) => {
    expect(parseReviewVerdictEvent(raw)).toEqual(expected);
  });

  it.each([
    {
      name: "accepts a badge with text",
      raw: {
        type: "plan-mode.badge",
        cwd: "/repo",
        key: "subagent",
        text: "subagent 2 running, 0 queued",
      },
      expected: {
        cwd: "/repo",
        key: "subagent",
        text: "subagent 2 running, 0 queued",
      },
    },
    {
      name: "accepts null as the retraction signal",
      raw: {
        type: "plan-mode.badge",
        cwd: "/repo",
        key: "subagent",
        text: null,
      },
      expected: { cwd: "/repo", key: "subagent", text: null },
    },
    {
      name: "ignores a badge without cwd",
      raw: { type: "plan-mode.badge", key: "subagent", text: "x" },
      expected: null,
    },
    {
      name: "ignores a badge without key",
      raw: { type: "plan-mode.badge", cwd: "/repo", text: "x" },
      expected: null,
    },
    {
      name: "ignores a non-string, non-null text",
      raw: { type: "plan-mode.badge", cwd: "/repo", key: "subagent", text: 3 },
      expected: null,
    },
    {
      name: "ignores the wrong event type",
      raw: {
        type: "plan-mode.other",
        cwd: "/repo",
        key: "subagent",
        text: "x",
      },
      expected: null,
    },
  ])("$name", ({ raw, expected }) => {
    expect(parsePlanModeBadgeEvent(raw)).toEqual(expected);
  });

  it.each([
    {
      name: "bypasses plan-mode turn decisions for extension-sourced prompts",
      input: {
        inputSourceForTurn: "extension" as const,
        prompt: "implement this feature",
        hasCompletedNonApprovedRun: true,
      },
      expected: {
        internalExtensionBypass: true,
        shouldDismissCompletedNonApprovedRun: false,
        shouldEnterPlanMode: false,
      },
    },
    {
      name: "dismisses stale completed non-approved runs before user plan prompts",
      input: {
        inputSourceForTurn: "interactive" as const,
        prompt: "计划模式帮我实现这个功能",
        hasCompletedNonApprovedRun: true,
      },
      expected: {
        internalExtensionBypass: false,
        shouldDismissCompletedNonApprovedRun: true,
        shouldEnterPlanMode: true,
      },
    },
  ])("$name", ({ input, expected }) => {
    expect(decideAgentStartPreActions(input)).toEqual(expected);
  });

  it.each([
    {
      name: "returns completed approved runs to plan when not continuing them",
      continuesApprovedPlan: false,
      expected: {
        reviewRequiredForTurn: false,
        shouldCompleteApprovedRun: true,
        shouldReturnPlanActToPlan: true,
      },
    },
    {
      name: "keeps approved act runs active while continuing them",
      continuesApprovedPlan: true,
      expected: {
        reviewRequiredForTurn: false,
        shouldCompleteApprovedRun: false,
        shouldReturnPlanActToPlan: false,
      },
    },
  ])("$name", ({ continuesApprovedPlan, expected }) => {
    expect(
      decideAgentStartPostActions({
        internalExtensionBypass: false,
        continuesApprovedPlan,
        isPlanPhase: false,
        isApprovedCompletedPlanActRun: true,
        canReturnPlanActToPlan: true,
      }),
    ).toEqual(expected);
  });

  it.each([
    {
      name: "ignores extension-sourced turns",
      input: {
        internalExtensionBypass: true,
        phase: "plan" as const,
        mode: "plan" as const,
        reviewRequiredForTurn: true,
        todoCount: 1,
        latestReviewArtifactPath: "plan.md",
      },
      expected: false,
    },
    {
      name: "ignores act phase",
      input: {
        internalExtensionBypass: false,
        phase: "act" as const,
        mode: "act" as const,
        reviewRequiredForTurn: true,
        todoCount: 1,
        latestReviewArtifactPath: "plan.md",
      },
      expected: false,
    },
    {
      name: "requires review for visible plan-phase obligations",
      input: {
        internalExtensionBypass: false,
        phase: "plan" as const,
        mode: "act" as const,
        reviewRequiredForTurn: false,
        todoCount: 1,
        latestReviewArtifactPath: null,
      },
      expected: true,
    },
  ])("$name", ({ input, expected }) => {
    expect(decidePlanReviewObligation(input)).toBe(expected);
  });

  it.each([
    {
      name: "queues the current not-yet-queued artifact",
      input: approvedReviewQueueInput,
      expected: reviewArtifactPath,
    },
    {
      name: "ignores stale approval results",
      input: {
        ...approvedReviewQueueInput,
        latestReviewArtifactPath: ".pi/plans/pi-kit/plan/2026-05-08-other.md",
      },
      expected: null,
    },
    {
      name: "ignores approval results that are already queued",
      input: {
        ...approvedReviewQueueInput,
        alreadyApproved: true,
        pendingApprovedPlanContinuationPath: reviewArtifactPath,
      },
      expected: null,
    },
  ])("$name", ({ input, expected }) => {
    expect(getApprovedReviewPathToQueue(input)).toBe(expected);
  });
});
