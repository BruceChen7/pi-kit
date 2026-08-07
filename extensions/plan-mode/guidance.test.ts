import { describe, expect, it } from "vitest";
import { EXECUTION_TODO_DISCIPLINE_GUIDANCE } from "./constants.js";
import {
  BOUNDARIES_SEQUENCE_GUIDANCE,
  FLOW_TREE_GUIDANCE,
  IMPLEMENTATION_CALL_TREE_GUIDANCE,
  MERMAID_CONFIG_LIGHT,
  PLAN_CONTENT_FORM_RULES,
  PLAN_SUBMIT_CHECKLIST,
  todoDisciplineGuidance,
} from "./guidance.js";

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
    const assignments = (themeBlock?.[1].match(/^\s{4}\w+:.+$/gm) ?? [])
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

describe("PLAN_CONTENT_FORM_RULES", () => {
  it("defines the required content forms from the review contract", () => {
    // Literal contract (independent source of truth): the four sections and
    // their content forms fixed by the plan template review.
    expect(
      PLAN_CONTENT_FORM_RULES.map(({ section, form }) => ({ section, form })),
    ).toEqual([
      { section: "Current Flow", form: "mermaid" },
      { section: "Desired Flow", form: "mermaid" },
      { section: "Boundaries", form: "mermaid" },
      { section: "Implementation", form: "ascii-call-tree" },
    ]);
  });

  it("gives every rule a copyable fix suggestion", () => {
    for (const rule of PLAN_CONTENT_FORM_RULES) {
      expect(rule.suggestion).toBeTruthy();
    }
  });
});

describe("PLAN_SUBMIT_CHECKLIST", () => {
  it("renders a checklist line for every content-form rule", () => {
    const text = PLAN_SUBMIT_CHECKLIST.join("\n");
    for (const rule of PLAN_CONTENT_FORM_RULES) {
      expect(text).toContain(rule.section);
    }
  });

  it("mentions the mermaid fence requirement", () => {
    const text = PLAN_SUBMIT_CHECKLIST.join("\n");
    expect(text).toContain("```mermaid");
    expect(text).toContain("~~~mermaid");
  });

  it("mentions the ASCII call tree requirement", () => {
    const text = PLAN_SUBMIT_CHECKLIST.join("\n");
    expect(text).toContain("├─");
    expect(text).toContain("└─");
  });

  it("reminds to reuse the same file and keep the first heading", () => {
    const text = PLAN_SUBMIT_CHECKLIST.join("\n");
    expect(text).toContain("同一个 plan 文件");
    expect(text).toContain("第一个 # 标题");
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

describe("todo discipline guidance wiring", () => {
  it("system prompt constant uses the single source of truth", () => {
    // Guards the wording drift this refactor fixed: if the system prompt text
    // is ever re-inlined at the consumption point, this fails.
    expect(EXECUTION_TODO_DISCIPLINE_GUIDANCE).toBe(
      todoDisciplineGuidance("the todo list"),
    );
  });
});
