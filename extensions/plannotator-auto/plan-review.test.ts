import { describe, expect, it } from "vitest";
import {
  preprocessPlanMarkdown,
  validateMermaidFences,
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

  it("returns error when mermaid fence is not closed", () => {
    const markdown = ["```mermaid", "graph TD", "A-->B"].join("\n");

    expect(validateMermaidFences(markdown)).toBe(
      "Mermaid block starting at line 1 is missing a closing ``` fence.",
    );
  });

  it("returns error when mermaid fence body is empty", () => {
    const markdown = ["```mermaid", "   ", "```"].join("\n");

    expect(validateMermaidFences(markdown)).toBe(
      "Mermaid block starting at line 1 is empty.",
    );
  });

  it("returns null for valid mermaid fences", () => {
    const markdown = ["```mermaid", "graph TD", "A-->B", "```"].join("\n");

    expect(validateMermaidFences(markdown)).toBeNull();
  });
});
