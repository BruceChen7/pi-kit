import { describe, expect, it } from "vitest";
import {
  decideReviewStateTransition,
  preprocessPlanMarkdown,
  type ReviewStateTransition,
  reviewWidgetHost,
} from "./plan-review.ts";

describe("plan-review mermaid helpers", () => {
  it("converts ~~~mermaid fences to ```mermaid fences", () => {
    const input = [
      "# Plan",
      "",
      "~~~mermaid",
      "graph TD",
      "  A-->B",
      "~~~",
      "",
      "text",
    ].join("\n");

    const output = preprocessPlanMarkdown(input);

    expect(output).toContain("```mermaid");
    expect(output).toContain("graph TD");
    expect(output).toContain("```\n\ntext");
    expect(output).not.toContain("~~~mermaid");
  });
});

const transition = (
  outcome: ReviewStateTransition["outcome"],
  clearPendingTarget: boolean,
  nextSettledState: ReviewStateTransition["nextSettledState"],
): ReviewStateTransition => ({ outcome, clearPendingTarget, nextSettledState });

describe("decideReviewStateTransition (Functional Core)", () => {
  // One table, both flows: the reviewer's verdict and the resulting gate state
  // are flow-independent — only "does the reviewed revision leave the pending
  // queue" differs (manual clears it, the auto flow keeps it on rejection).
  it.each([
    {
      name: "approval settles the path and releases the reviewed revision",
      decision: { approved: true },
      manual: transition("approved", true, "settled"),
      auto: transition("approved", true, "settled"),
    },
    {
      name: "feedback re-arms the path",
      decision: { approved: false, feedback: "Restructure the sections." },
      manual: transition("rejected", true, "armed"),
      auto: transition("rejected", false, "armed"),
    },
    {
      name: "annotated without feedback is still a rejection",
      decision: { approved: false, feedback: "" },
      manual: transition("rejected", true, "armed"),
      auto: transition("rejected", false, "armed"),
    },
    {
      name: "dismissal re-arms the path",
      decision: { approved: false, dismissed: true, exit: true },
      manual: transition("dismissed", true, "armed"),
      auto: transition("dismissed", true, "armed"),
    },
    {
      name: "a review without a verdict leaves the gate state alone",
      decision: { approved: false, exit: true },
      manual: transition("no-verdict", false, "unchanged"),
      auto: transition("no-verdict", false, "unchanged"),
    },
  ])("$name", ({ decision, manual, auto }) => {
    expect(decideReviewStateTransition(decision, "manual")).toEqual(manual);
    expect(decideReviewStateTransition(decision, "auto")).toEqual(auto);
  });
});

describe("reviewWidgetHost", () => {
  const env = (pairs: Record<string, string>): NodeJS.ProcessEnv =>
    pairs as NodeJS.ProcessEnv;

  it("says herdr-panel whenever the panel mode is on", () => {
    expect(reviewWidgetHost({ hostMode: "herdr-panel", env: env({}) })).toBe(
      "herdr-panel",
    );
    expect(
      reviewWidgetHost({
        hostMode: "herdr-panel",
        env: env({ PLANNOTATOR_REMOTE: "0" }),
      }),
    ).toBe("herdr-panel");
  });

  it("says remote when the URL went to the client", () => {
    // The rich-host case this change exists for: the app is the reviewer's
    // screen, so "no browser opened here" must not read as "never started".
    expect(
      reviewWidgetHost({
        hostMode: "browser",
        env: env({ PI_KIT_UI_HOST: "android" }),
      }),
    ).toBe("remote");
    expect(
      reviewWidgetHost({
        hostMode: "browser",
        env: env({ PLANNOTATOR_REMOTE: "1" }),
      }),
    ).toBe("remote");
  });

  it("says browser on an ordinary local session", () => {
    expect(
      reviewWidgetHost({
        hostMode: "browser",
        env: env({ PI_KIT_UI_HOST: "tui" }),
      }),
    ).toBe("browser");
    // Explicit local wins over an inferred rich host.
    expect(
      reviewWidgetHost({
        hostMode: "browser",
        env: env({ PI_KIT_UI_HOST: "android", PLANNOTATOR_REMOTE: "0" }),
      }),
    ).toBe("browser");
  });
});
