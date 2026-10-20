import { beforeAll, describe, expect, it } from "vitest";
import { getPeleParser, type PeleParser } from "../shared/pele-runtime.ts";
import type { VisualArtifactSpec } from "./artifact-schema.ts";
import {
  formatMermaidValidationErrors,
  validateMermaidCodeWith,
  validateMermaidNodesInSpec,
} from "./mermaid-boundary.ts";

describe("validateMermaidCodeWith — Tier 1 diagram types", () => {
  let parser: PeleParser;

  beforeAll(async () => {
    parser = await getPeleParser();
  });

  it("validates sequenceDiagram", () => {
    const result = validateMermaidCodeWith(
      [
        "sequenceDiagram",
        '  participant U as "User"',
        '  participant S as "Service"',
        "  U->>S: Request",
        "  S-->>U: Response",
      ].join("\n"),
      parser,
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.diagramType).toBe("sequenceDiagram");
  });

  it("validates flowchart with quoted labels", () => {
    const result = validateMermaidCodeWith(
      [
        "flowchart LR",
        'MODE["mode: plan | act"]',
        'PHASE["phase: plan | act"]',
        "MODE --> PHASE",
      ].join("\n"),
      parser,
    );

    expect(result.ok).toBe(true);
  });

  it("validates classDiagram", () => {
    const result = validateMermaidCodeWith(
      [
        "classDiagram",
        "  class Animal {",
        "    +String name",
        "    +eat()",
        "  }",
        "  Animal <|-- Dog",
      ].join("\n"),
      parser,
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.diagramType).toBe("classDiagram");
  });

  it("validates stateDiagram-v2", () => {
    const result = validateMermaidCodeWith(
      [
        "stateDiagram-v2",
        "  [*] --> Idle",
        "  Idle --> Processing: submit",
        "  Processing --> [*]",
      ].join("\n"),
      parser,
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.diagramType).toBe("stateDiagram-v2");
  });

  it("validates erDiagram", () => {
    const result = validateMermaidCodeWith(
      [
        "erDiagram",
        '  CUSTOMER ||--o{ ORDER : "places"',
        "  CUSTOMER {",
        "    int id PK",
        "  }",
      ].join("\n"),
      parser,
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.diagramType).toBe("erDiagram");
  });

  it("validates gantt", () => {
    const result = validateMermaidCodeWith(
      [
        "gantt",
        "  title Project",
        "  dateFormat YYYY-MM-DD",
        "  section Work",
        "  Task : t1, 2024-01-01, 3d",
      ].join("\n"),
      parser,
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.diagramType).toBe("gantt");
  });

  it("validates mindmap", () => {
    const result = validateMermaidCodeWith(
      ["mindmap", "  root((T))", "    A", "      B"].join("\n"),
      parser,
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.diagramType).toBe("mindmap");
  });

  it("validates gitGraph", () => {
    const result = validateMermaidCodeWith(
      [
        "gitGraph",
        "  commit",
        "  branch f",
        "  checkout f",
        "  commit",
        "  checkout main",
        "  merge f",
      ].join("\n"),
      parser,
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.diagramType).toBe("gitGraph");
  });

  it("reports parse failures without auto-fixing (no silent rewrite)", () => {
    const result = validateMermaidCodeWith(
      "flowchart TD\n  A[bad (label] --> B",
      parser,
    );

    expect(result.ok).toBe(false);
    if ("error" in result) {
      expect(result.error).toContain("Expecting");
      expect(result.diagramType).toBe("flowchart");
    }
  });
});

describe("validateMermaidNodesInSpec", () => {
  const spec = (code: string): VisualArtifactSpec => ({
    slug: "demo",
    title: "demo",
    nodes: [{ type: "mermaid", props: { code } }],
  });

  it("returns no errors for valid mermaid nodes", async () => {
    const { errors } = await validateMermaidNodesInSpec(
      spec("sequenceDiagram\n  A->>B: x"),
    );

    expect(errors).toHaveLength(0);
  });

  it("reports invalid nodes verbatim — no fixedSpec, no auto-fix", async () => {
    const { errors } = await validateMermaidNodesInSpec(
      spec("flowchart TD\n  A[bad (label] --> B"),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("nodes[0]<mermaid:flowchart>");
    expect(errors[0]).toContain("Expecting");
  });
});

describe("formatMermaidValidationErrors", () => {
  it("expands node errors with location, type and advice", () => {
    const text = formatMermaidValidationErrors([
      "nodes[14]<mermaid:flowchart>: Expecting 'PS', got 'TEXT'",
    ]);

    expect(text).toContain("MERMAID_VALIDATION_ERROR");
    expect(text).toContain("1 diagram(s) failed to parse");
    expect(text).toContain("nodes[14]");
    expect(text).toContain("Diagram type: flowchart");
    expect(text).toContain("Parse error: Expecting 'PS', got 'TEXT'");
    expect(text).toContain('N["label text"]');
  });

  it("preserves unrecognized error entries verbatim", () => {
    const text = formatMermaidValidationErrors([
      "mystery entry without the node format",
    ]);

    expect(text).toContain("mystery entry without the node format");
  });

  it("handles stateDiagram-v2 (hyphenated type) and unknown types", () => {
    const text = formatMermaidValidationErrors([
      "nodes[0]<mermaid:stateDiagram-v2>: bad transition",
      "nodes[1]<mermaid:customThing>: boom",
    ]);

    expect(text).toContain("Diagram type: stateDiagram-v2");
    expect(text).toContain("Diagram type: customThing");
  });
});
