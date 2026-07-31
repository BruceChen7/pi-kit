import { describe, expect, it } from "vitest";
import {
  detectDiagramType,
  getTypeAdviceForDiagram,
  TIER_1_DIAGRAM_TYPES,
} from "./mermaid-normalize.ts";

/* ------------------------------------------------------------------ */
/*  detectDiagramType                                                  */
/* ------------------------------------------------------------------ */

describe("detectDiagramType", () => {
  it("returns 'flowchart' for flowchart LR", () => {
    expect(detectDiagramType("flowchart LR\n  A --> B")).toBe("flowchart");
  });

  it("returns 'graph' for graph TD", () => {
    expect(detectDiagramType("graph TD\n  A --> B")).toBe("graph");
  });

  it("skips YAML frontmatter before detecting the type", () => {
    expect(
      detectDiagramType(
        "---\nconfig:\n  theme: base\n---\nsequenceDiagram\n  A->>B: x",
      ),
    ).toBe("sequenceDiagram");
  });

  it("returns 'sequenceDiagram' for sequenceDiagram", () => {
    expect(detectDiagramType("sequenceDiagram\n  A->>B: hello")).toBe(
      "sequenceDiagram",
    );
  });

  it("returns 'classDiagram' for classDiagram", () => {
    expect(detectDiagramType("classDiagram\n  class Animal {}")).toBe(
      "classDiagram",
    );
  });

  it("returns 'stateDiagram-v2' for stateDiagram-v2", () => {
    expect(detectDiagramType("stateDiagram-v2\n  [*] --> Idle")).toBe(
      "stateDiagram-v2",
    );
  });

  it("returns 'erDiagram' for erDiagram", () => {
    expect(detectDiagramType("erDiagram\n  A ||--o{ B")).toBe("erDiagram");
  });

  it("returns 'gantt' for gantt", () => {
    expect(detectDiagramType("gantt\n  title T")).toBe("gantt");
  });

  it("returns 'mindmap' for mindmap", () => {
    expect(detectDiagramType("mindmap\n  root((T))")).toBe("mindmap");
  });

  it("returns 'gitGraph' for gitGraph", () => {
    expect(detectDiagramType("gitGraph\n  commit")).toBe("gitGraph");
  });

  it("returns undefined for empty code", () => {
    expect(detectDiagramType("")).toBeUndefined();
  });

  it("skips comment lines (%% prefix)", () => {
    const code = "%% this is a comment\nflowchart LR\n  A --> B";
    expect(detectDiagramType(code)).toBe("flowchart");
  });
});

/* ------------------------------------------------------------------ */
/*  TIER_1_DIAGRAM_TYPES                                              */
/* ------------------------------------------------------------------ */

describe("TIER_1_DIAGRAM_TYPES", () => {
  it("includes all 10 known diagram types", () => {
    expect(TIER_1_DIAGRAM_TYPES.has("flowchart")).toBe(true);
    expect(TIER_1_DIAGRAM_TYPES.has("graph")).toBe(true);
    expect(TIER_1_DIAGRAM_TYPES.has("sequenceDiagram")).toBe(true);
    expect(TIER_1_DIAGRAM_TYPES.has("classDiagram")).toBe(true);
    expect(TIER_1_DIAGRAM_TYPES.has("stateDiagram")).toBe(true);
    expect(TIER_1_DIAGRAM_TYPES.has("stateDiagram-v2")).toBe(true);
    expect(TIER_1_DIAGRAM_TYPES.has("erDiagram")).toBe(true);
    expect(TIER_1_DIAGRAM_TYPES.has("gantt")).toBe(true);
    expect(TIER_1_DIAGRAM_TYPES.has("mindmap")).toBe(true);
    expect(TIER_1_DIAGRAM_TYPES.has("gitGraph")).toBe(true);
    expect(TIER_1_DIAGRAM_TYPES.size).toBe(10);
  });
});

/* ------------------------------------------------------------------ */
/*  normalizeMermaidCode                                               */
/* ------------------------------------------------------------------ */

describe("getTypeAdviceForDiagram", () => {
  it("returns advice for flowchart", () => {
    expect(getTypeAdviceForDiagram("flowchart")).toMatchInlineSnapshot(`
      [
        "Use double-quoted labels: N["label text"] not N[label text]",
        "Edge labels need quoting: -->|"label"| Next",
        "Use subgraph for logical groups: subgraph Title ... end",
        "Inline :::class breaks node labels — put on separate line: N:::class",
      ]
    `);
  });

  it("returns advice for sequenceDiagram", () => {
    expect(getTypeAdviceForDiagram("sequenceDiagram")).toMatchInlineSnapshot(`
      [
        "Quote participant names with special chars: participant A as "my name"",
        "Message arrows: -> for solid, ->> for dotted",
        "Use activate/deactivate for lifeline blocks",
      ]
    `);
  });

  it("returns advice for stateDiagram-v2", () => {
    expect(getTypeAdviceForDiagram("stateDiagram-v2")).toMatchInlineSnapshot(`
      [
        "Use quotes for multi-word state names: state "My State" as S",
        "Transitions: State1 --> State2 : event",
        "Use [*] for initial and final states",
      ]
    `);
  });

  it("returns undefined for unknown diagram type", () => {
    expect(getTypeAdviceForDiagram("unknown")).toBeUndefined();
  });

  it("returns undefined for undefined input", () => {
    expect(getTypeAdviceForDiagram(undefined)).toBeUndefined();
  });
});
