import { describe, expect, it } from "vitest";
import {
  BOUNDARIES_SEQUENCE_GUIDANCE,
  FLOW_TREE_GUIDANCE,
  IMPLEMENTATION_CALL_TREE_GUIDANCE,
  MERMAID_CONFIG_LIGHT,
  todoDisciplineGuidance,
} from "./guidance.ts";

describe("MERMAID_CONFIG_LIGHT", () => {
  it("produces valid frontmatter block with triple-dash delimiters", () => {
    const lines = MERMAID_CONFIG_LIGHT.split("\n");
    expect(lines[0]).toBe("---");
    expect(lines[lines.length - 1]).toBe("---");
    expect(lines[1]).toBe("config:");
    // Ensure the block has config, theme, and themeVariables in order
    const configIndex = lines.findIndex((l) => l.startsWith("config:"));
    const themeIndex = lines.findIndex((l) => l.includes("theme: base"));
    const varsIndex = lines.findIndex((l) => l.startsWith("  themeVariables:"));
    expect(configIndex).toBeGreaterThanOrEqual(0);
    expect(themeIndex).toBeGreaterThan(configIndex);
    expect(varsIndex).toBeGreaterThan(themeIndex);
  });

  it("contains config: section", () => {
    expect(MERMAID_CONFIG_LIGHT).toContain("config:");
  });

  it("contains theme: base", () => {
    expect(MERMAID_CONFIG_LIGHT).toContain("theme: base");
  });

  it("contains themeVariables section", () => {
    expect(MERMAID_CONFIG_LIGHT).toContain("themeVariables:");
  });

  it("each themeVariable key has a hex color value", () => {
    // Dynamically extract all keys under themeVariables and verify
    // each has a hex color assignment — no hardcoded key list needed.
    const themeBlock = MERMAID_CONFIG_LIGHT.match(
      /themeVariables:\n((?: {4}\w+: .*\n?)*)/,
    );
    expect(themeBlock).not.toBeNull();
    const assignments = (themeBlock![1].match(/^\s{4}\w+:.+$/gm) ?? [])
      .map((l) => l.trim())
      .filter((l) => l.includes("'#"));
    expect(assignments.length).toBeGreaterThanOrEqual(12);
    for (const assignment of assignments) {
      // Each line should look like "key: '#ffffff'"
      expect(assignment).toMatch(/^\w+: '#[0-9a-fA-F]{6,8}'$/);
    }
  });
});

describe("FLOW_TREE_GUIDANCE", () => {
  it("includes guidance about Mermaid frontmatter config", () => {
    expect(
      FLOW_TREE_GUIDANCE.some((line) => line.includes("frontmatter")),
    ).toBe(true);
  });

  it("includes guidance about sequenceDiagram format", () => {
    expect(
      FLOW_TREE_GUIDANCE.some((line) => line.includes("sequenceDiagram")),
    ).toBe(true);
  });

  it("includes a mermaid code block example", () => {
    expect(FLOW_TREE_GUIDANCE.join("\n")).toContain("```mermaid");
  });

  it("references the frontmatter config structure (--- / config: / themeVariables: / ---)", () => {
    const text = FLOW_TREE_GUIDANCE.join("\n");
    expect(text).toContain("---");
    expect(text).toContain("config:");
    expect(text).toContain("themeVariables:");
  });
});

describe("BOUNDARIES_SEQUENCE_GUIDANCE", () => {
  it("mentions Mermaid frontmatter config requirement", () => {
    expect(BOUNDARIES_SEQUENCE_GUIDANCE).toContain("frontmatter");
  });

  it("mentions sequenceDiagram for boundaries", () => {
    expect(BOUNDARIES_SEQUENCE_GUIDANCE).toContain("sequenceDiagram");
  });
});

describe("IMPLEMENTATION_CALL_TREE_GUIDANCE", () => {
  it("does not mention mermaid frontmatter (ASCII tree only)", () => {
    const text = IMPLEMENTATION_CALL_TREE_GUIDANCE.join("\n");
    expect(text).not.toContain("frontmatter");
    expect(text).not.toContain("mermaid");
  });

  it("references ASCII tree characters (├─ / └─)", () => {
    const text = IMPLEMENTATION_CALL_TREE_GUIDANCE.join("\n");
    expect(text).toContain("├─");
    expect(text).toContain("└─");
  });
});

describe("todoDisciplineGuidance", () => {
  it("names the todo tool the agent should call", () => {
    expect(todoDisciplineGuidance("act_mode_todo")).toContain("act_mode_todo");
  });

  it("covers the one-in_progress and per-step update rules", () => {
    const text = todoDisciplineGuidance("the todo list");
    expect(text).toContain("at most one in_progress");
    expect(text).toContain("before starting each step");
    expect(text).toContain("never bulk-mark all items done");
  });
});
