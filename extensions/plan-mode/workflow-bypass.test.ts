import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKFLOW_BYPASS_STATE,
  decideWorkflowBypass,
} from "./workflow-bypass.js";

const activeWorkflow = {
  active: true,
  reason: "workflow-only request",
};

describe("workflow bypass policy", () => {
  it.each([
    "commit all the changes",
    "commit all changes and no extra branch",
    "commit and push",
    "git status --short",
    "run lint checks",
  ])("enables bypass for pure workflow prompt: %s", (prompt) => {
    expect(
      decideWorkflowBypass(prompt, DEFAULT_WORKFLOW_BYPASS_STATE, false),
    ).toEqual(activeWorkflow);
  });

  it.each([
    "fix the bug and commit",
    "implement feature and commit",
  ])("keeps implementation prompt in normal plan mode: %s", (prompt) => {
    expect(
      decideWorkflowBypass(prompt, DEFAULT_WORKFLOW_BYPASS_STATE, false),
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
