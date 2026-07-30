import { describe, expect, it } from "vitest";
import {
  aggressiveQuoteLabels,
  detectDiagramType,
  getTypeAdviceForDiagram,
  normalizeMermaidCode,
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

describe("normalizeMermaidCode", () => {
  it("quotes labels with parentheses and inline ::: class (the original session failure)", () => {
    const input = [
      "flowchart TB",
      "classDef storage fill:#e8f5e9,stroke:#2e7d32",
      "classDef decision fill:#f3e5f5,stroke:#7b1fa2",
      "WRITE_ENTRY[writeSessionEntry(key, snapshot)]:::storage",
      "EXEC_CONT[执行 continuation] --> CHECK_PATH{path 在 approvedPaths 中?}:::decision",
    ].join("\n");

    const output = normalizeMermaidCode(input);

    expect(output).toContain('WRITE_ENTRY["writeSessionEntry(key, snapshot)"]');
    expect(output).toContain(":::storage");
    // Diamond labels with Chinese characters work fine without quoting
    expect(output).toContain(
      "CHECK_PATH{path 在 approvedPaths 中?}:::decision",
    );
  });

  it("quotes multiline flowchart labels containing nested brackets", () => {
    const input = [
      "graph TD",
      "UPDATE_UI --> |todo widget| SHOW_TODO[#id [✓/~/!] text",
      "progress bar]",
    ].join("\n");

    const output = normalizeMermaidCode(input);

    expect(output).toContain('SHOW_TODO["#id [✓/~/!] text');
    expect(output).toContain("progress bar");
  });

  it("quotes link text in edge connectors with parentheses", () => {
    const input = [
      "flowchart LR",
      "State -->|snapshot()| APPEND",
      "State2 -->|test()| APPEND2",
      'Already -->|"quoted"| OK',
    ].join("\n");

    const output = normalizeMermaidCode(input);

    expect(output).toContain('State -->|"snapshot()"| APPEND');
    expect(output).toContain('State2 -->|"test()"| APPEND2');
    expect(output).toContain('Already -->|"quoted"| OK');
  });

  it("quotes flowchart labels containing pipe characters", () => {
    const input = [
      "flowchart LR",
      "MODE[mode: plan | act]",
      "PHASE[phase: plan | act]",
    ].join("\n");

    const output = normalizeMermaidCode(input);

    expect(output).toContain('MODE["mode: plan | act"]');
    expect(output).toContain('PHASE["phase: plan | act"]');
  });

  it("quotes labels with array brackets and handles multiple nodes per line", () => {
    const input = [
      "flowchart LR",
      "TODOS[todos: TodoItem[]] ACTIVE[activeRun: PlanRun | null]",
    ].join("\n");

    const output = normalizeMermaidCode(input);

    expect(output).toContain('TODOS["todos: TodoItem[]"]');
    expect(output).toContain('ACTIVE["activeRun: PlanRun | null"]');
  });

  it("leaves already-valid quoted labels unchanged", () => {
    const input = 'graph TD\nA["already quoted"] --> B';
    expect(normalizeMermaidCode(input)).toBe(input);
  });

  it("fixes diamond labels with special characters", () => {
    const input = "flowchart LR\n  A{test <br/> more} --> B";
    const output = normalizeMermaidCode(input);
    // Should not break diamond labels
    expect(output).toContain("A{");
    expect(output).toContain("more}");
  });

  /* ---- New tests for plan-mode session failures ---- */

  it("handles frontmatter-style config blocks in mermaid code", () => {
    // Plan artifacts use this format:
    const input = [
      "---",
      "config:",
      "  theme: base",
      "---",
      "sequenceDiagram",
      "  A->>B: message",
    ].join("\n");

    const output = normalizeMermaidCode(input);
    // Should preserve frontmatter and still process diagram content
    expect(output).toContain("---");
    expect(output).toContain("config:");
    expect(output).toContain("theme: base");
    expect(output).toContain("A->>B: message");
    // Should not corrupt the frontmatter
    expect(output.startsWith("---")).toBe(true);
  });

  it("does not break classDiagram with member braces", () => {
    const input = [
      "classDiagram",
      "  class Animal {",
      "    +String name",
      "    +eat()",
      "  }",
      "  Animal <|-- Dog",
    ].join("\n");

    const output = normalizeMermaidCode(input);
    expect(output).toContain("class Animal {");
    expect(output).toContain("+String name");
    expect(output).toContain("+eat()");
    expect(output).toContain("Animal <|-- Dog");
  });

  it("does not break stateDiagram-v2 with bracket syntax", () => {
    const input = [
      "stateDiagram-v2",
      "  [*] --> Idle",
      "  Idle --> Processing: submit",
      "  Processing --> Success",
      "  Success --> [*]",
    ].join("\n");

    const output = normalizeMermaidCode(input);
    expect(output).toContain("[*] --> Idle");
    expect(output).toContain("Idle --> Processing: submit");
    expect(output).toContain("Processing --> Success");
    expect(output).toContain("Success --> [*]");
  });

  it("does not break erDiagram with cardinality syntax", () => {
    const input = [
      "erDiagram",
      '  CUSTOMER ||--o{ ORDER : "places"',
      '  ORDER ||--o{ LINE_ITEM : "contains"',
    ].join("\n");

    const output = normalizeMermaidCode(input);
    expect(output).toContain('CUSTOMER ||--o{ ORDER : "places"');
    expect(output).toContain("ORDER ||--o{ LINE_ITEM");
  });

  it("does not break gantt syntax", () => {
    const input = [
      "gantt",
      "  title Project",
      "  dateFormat YYYY-MM-DD",
      "  section Work",
      "  Task : t1, 2024-01-01, 3d",
    ].join("\n");

    const output = normalizeMermaidCode(input);
    expect(output).toContain("title Project");
    expect(output).toContain("dateFormat YYYY-MM-DD");
    expect(output).toContain("Task : t1, 2024-01-01, 3d");
  });

  it("does not break mindmap indentation", () => {
    const input = ["mindmap", "  root((T))", "    A", "      B"].join("\n");

    const output = normalizeMermaidCode(input);
    expect(output).toContain("root((T))");
    expect(output).toContain("      B");
  });

  it("does not break gitGraph syntax", () => {
    const input = [
      "gitGraph",
      "  commit",
      "  branch f",
      "  checkout f",
      "  commit",
      "  checkout main",
      "  merge f",
    ].join("\n");

    const output = normalizeMermaidCode(input);
    expect(output).toContain("branch f");
    expect(output).toContain("checkout f");
    expect(output).toContain("merge f");
  });

  /* ---- Sequence diagram participant quoting ---- */

  it("quotes participant aliases with dots in sequenceDiagram", () => {
    const input = [
      "sequenceDiagram",
      "  participant T as guidance.test.ts",
      "  participant A as artifact-policy.test.ts",
      "  T->>guidance.ts: method call",
    ].join("\n");

    const output = normalizeMermaidCode(input);
    expect(output).toContain('T as "guidance.test.ts"');
    expect(output).toContain('A as "artifact-policy.test.ts"');
    expect(output).toContain("T->>guidance.ts: method call");
  });

  it("quotes bare participant names with dots in sequenceDiagram", () => {
    const input = [
      "sequenceDiagram",
      "  participant guidance.test.ts",
      "  participant artifact-policy.test.ts",
    ].join("\n");

    const output = normalizeMermaidCode(input);
    expect(output).toContain('participant "guidance.test.ts"');
    expect(output).toContain('participant "artifact-policy.test.ts"');
  });

  it("quotes participant aliases with angle brackets", () => {
    const input = [
      "sequenceDiagram",
      "  participant X as 2026-07-30-<slug>.md",
      "  participant Y as <date>",
    ].join("\n");

    const output = normalizeMermaidCode(input);
    expect(output).toContain('X as "2026-07-30-<slug>.md"');
    expect(output).toContain('Y as "<date>"');
  });

  it("skips already-quoted participant aliases", () => {
    const input = [
      "sequenceDiagram",
      '  participant T as "already.quoted"',
    ].join("\n");

    const output = normalizeMermaidCode(input);
    expect(output).toBe(input);
  });

  it("does not modify simple participant names without special chars", () => {
    const input = [
      "sequenceDiagram",
      "  participant User",
      "  participant System",
      "  User->>System: Request",
    ].join("\n");

    const output = normalizeMermaidCode(input);
    expect(output).toBe(input);
  });
});

/* ------------------------------------------------------------------ */
/*  aggressiveQuoteLabels (standalone)                                 */
/* ------------------------------------------------------------------ */

describe("aggressiveQuoteLabels", () => {
  it("quotes unquoted square-bracket labels", () => {
    const output = aggressiveQuoteLabels(
      "flowchart LR\n  A[label with spaces]",
    );
    expect(output).toContain('A["label with spaces"]');
  });

  it("skips already-quoted labels", () => {
    const input = 'flowchart LR\n  A["already quoted"]';
    expect(aggressiveQuoteLabels(input)).toBe(input);
  });

  it("skips backtick-quoted labels", () => {
    const input = "flowchart LR\n  A[`code label`]";
    expect(aggressiveQuoteLabels(input)).toBe(input);
  });

  it("handles multiple nodes on one line", () => {
    const input = "flowchart LR\n  A[first] --> B[second]";
    const output = aggressiveQuoteLabels(input);
    expect(output).toContain('A["first"]');
    expect(output).toContain('B["second"]');
  });

  it("does not mangle classDef declarations with brackets in values", () => {
    const input = "classDef myClass fill:#fff,stroke:#000;";
    const output = aggressiveQuoteLabels(input);
    expect(output).toContain("classDef myClass");
  });
});

/* ------------------------------------------------------------------ */
/*  getTypeAdviceForDiagram                                            */
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
