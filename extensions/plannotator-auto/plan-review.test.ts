import { describe, expect, it } from "vitest";
import { preprocessPlanMarkdown } from "./plan-review.ts";

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
