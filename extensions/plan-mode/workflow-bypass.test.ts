import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKFLOW_BYPASS_STATE,
  decideWorkflowBypass,
  requiresPlanReviewForIntentFeedback,
} from "./workflow-bypass.js";

const activeWorkflow = {
  active: true,
  reason: "workflow-only request",
};

const workflowOnlyFeedback = {
  kind: "workflow_only",
  confidence: 0.9,
  reason: "User only asked to commit existing changes.",
  evidence: ["commit existing changes"],
  requestedOperations: ["git commit"],
};

const implementationFeedback = {
  kind: "implementation",
  confidence: 0.9,
  reason: "User asked to fix code before committing.",
  evidence: ["fix"],
  requestedOperations: ["edit", "git commit"],
};

describe("workflow bypass policy", () => {
  it("enables bypass from structured LLM workflow feedback", () => {
    expect(
      decideWorkflowBypass(
        workflowOnlyFeedback,
        DEFAULT_WORKFLOW_BYPASS_STATE,
        false,
      ),
    ).toEqual(activeWorkflow);
  });

  it("keeps implementation feedback in normal plan mode", () => {
    expect(
      decideWorkflowBypass(
        implementationFeedback,
        DEFAULT_WORKFLOW_BYPASS_STATE,
        false,
      ),
    ).toEqual(DEFAULT_WORKFLOW_BYPASS_STATE);
  });

  it("requires plan review when feedback is missing or ambiguous", () => {
    expect(requiresPlanReviewForIntentFeedback(undefined)).toBe(true);
    expect(
      requiresPlanReviewForIntentFeedback({
        ...workflowOnlyFeedback,
        kind: "ambiguous",
      }),
    ).toBe(true);
    expect(requiresPlanReviewForIntentFeedback(workflowOnlyFeedback)).toBe(
      false,
    );
  });

  it("fails closed when feedback is missing or invalid", () => {
    expect(
      decideWorkflowBypass(undefined, DEFAULT_WORKFLOW_BYPASS_STATE, false),
    ).toEqual(DEFAULT_WORKFLOW_BYPASS_STATE);
    expect(
      decideWorkflowBypass(
        { ...workflowOnlyFeedback, confidence: 0.4 },
        DEFAULT_WORKFLOW_BYPASS_STATE,
        false,
      ),
    ).toEqual(DEFAULT_WORKFLOW_BYPASS_STATE);
  });

  it.each([
    "yes",
    "no",
  ])("continues active workflow on confirmation reply: %s", (prompt) => {
    expect(decideWorkflowBypass(prompt, activeWorkflow, true)).toEqual(
      activeWorkflow,
    );
  });

  it("does not continue confirmation replies after workflow todos finish", () => {
    expect(decideWorkflowBypass("no", activeWorkflow, false)).toEqual(
      DEFAULT_WORKFLOW_BYPASS_STATE,
    );
  });
});
