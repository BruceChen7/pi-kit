import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { VisualArtifactSpec } from "./artifact-schema.ts";
import type { MermaidParser } from "./mermaid-boundary.ts";
import {
  formatMermaidValidationErrors,
  getMermaidRuntime,
  resetMermaidModule,
  validateMermaidCodeWith,
  validateMermaidNodesInSpec,
} from "./mermaid-boundary.ts";

describe("validateMermaidCodeWith — Tier 1 diagram types", () => {
  let mermaid: MermaidParser;

  beforeAll(async () => {
    mermaid = await getMermaidRuntime();
    // Configuration is the shell's job (validateMermaidCode /
    // validateMermaidNodesInSpec); initialize once here for direct core tests.
    mermaid.initialize({ startOnLoad: false, securityLevel: "loose" });
  });

  afterEach(() => {
    resetMermaidModule();
  });

  it("validates sequenceDiagram", async () => {
    const result = await validateMermaidCodeWith(
      [
        "sequenceDiagram",
        '  participant U as "User"',
        '  participant S as "Service"',
        "  U->>S: Request",
        "  S-->>U: Response",
      ].join("\n"),
      mermaid,
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.diagramType).toBe("sequenceDiagram");
  });

  it("validates flowchart with quoted labels", async () => {
    const result = await validateMermaidCodeWith(
      [
        "flowchart LR",
        'MODE["mode: plan | act"]',
        'PHASE["phase: plan | act"]',
        "MODE --> PHASE",
      ].join("\n"),
      mermaid,
    );

    expect(result.ok).toBe(true);
  });

  it("validates classDiagram", async () => {
    const result = await validateMermaidCodeWith(
      [
        "classDiagram",
        "  class Animal {",
        "    +String name",
        "    +eat()",
        "  }",
        "  Animal <|-- Dog",
      ].join("\n"),
      mermaid,
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.diagramType).toBe("classDiagram");
  });

  it("validates stateDiagram-v2", async () => {
    const result = await validateMermaidCodeWith(
      [
        "stateDiagram-v2",
        "  [*] --> Idle",
        "  Idle --> Processing: submit",
        "  Processing --> [*]",
      ].join("\n"),
      mermaid,
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.diagramType).toBe("stateDiagram-v2");
  });

  it("validates erDiagram", async () => {
    const result = await validateMermaidCodeWith(
      [
        "erDiagram",
        '  CUSTOMER ||--o{ ORDER : "places"',
        "  CUSTOMER {",
        "    int id PK",
        "  }",
      ].join("\n"),
      mermaid,
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.diagramType).toBe("erDiagram");
  });

  it("validates gantt", async () => {
    const result = await validateMermaidCodeWith(
      [
        "gantt",
        "  title Project",
        "  dateFormat YYYY-MM-DD",
        "  section Work",
        "  Task : t1, 2024-01-01, 3d",
      ].join("\n"),
      mermaid,
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.diagramType).toBe("gantt");
  });

  it("validates mindmap", async () => {
    const result = await validateMermaidCodeWith(
      ["mindmap", "  root((T))", "    A", "      B"].join("\n"),
      mermaid,
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.diagramType).toBe("mindmap");
  });

  it("validates gitGraph", async () => {
    const result = await validateMermaidCodeWith(
      [
        "gitGraph",
        "  commit",
        "  branch f",
        "  checkout f",
        "  commit",
        "  checkout main",
        "  merge f",
      ].join("\n"),
      mermaid,
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.diagramType).toBe("gitGraph");
  });

  it("reports parse failures without auto-fixing (no silent rewrite)", async () => {
    const result = await validateMermaidCodeWith(
      "flowchart TD\n  A[bad (label] --> B",
      mermaid,
    );

    expect(result.ok).toBe(false);
    if ("error" in result) {
      expect(result.error).toContain("Expecting");
      expect(result.diagramType).toBe("flowchart");
    }
  });
});

describe("validateMermaidNodesInSpec", () => {
  afterEach(() => {
    resetMermaidModule();
  });

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
