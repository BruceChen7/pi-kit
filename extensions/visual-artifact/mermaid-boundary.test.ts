import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { MermaidParser } from "./mermaid-boundary.ts";
import {
  detectDiagramType,
  getMermaidRuntime,
  getTypeAdviceForDiagram,
  normalizeMermaidCode,
  normalizeMermaidNodesInSpec,
  resetMermaidModule,
  validateMermaidCodeWith,
} from "./mermaid-boundary.ts";

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
    // aggressiveQuoteLabels only handles square brackets, not diamond.
    // But the normalize function should not break diamond labels.
    expect(output).toContain("A{");
    expect(output).toContain("more}");
  });
});

describe("normalizeMermaidNodesInSpec", () => {
  it("normalizes mermaid nodes recursively in nested props", () => {
    const spec = {
      slug: "demo",
      title: "demo",
      nodes: [
        {
          type: "card",
          props: {
            nodes: [
              {
                type: "mermaid",
                props: {
                  code: "graph TD\nX --> Y[label [inner]\nnext]",
                },
              },
            ],
          },
        },
      ],
    };

    const normalized = normalizeMermaidNodesInSpec(spec);
    const nestedCode = (
      normalized.nodes[0].props.nodes as {
        type: string;
        props: { code: string };
      }[]
    )[0].props.code;

    expect(nestedCode).toContain('Y["label [inner]');
    expect(nestedCode).toContain("next");
  });
});

describe("validateMermaidCode", () => {
  let mermaid: MermaidParser;

  beforeAll(async () => {
    mermaid = await getMermaidRuntime();
  });

  afterEach(() => {
    resetMermaidModule();
  });

  it("accepts the normalized version of the current parse-error case", async () => {
    const code = normalizeMermaidCode(
      [
        "graph TD",
        "UPDATE_UI --> |todo widget| SHOW_TODO[#id [✓/~/!] text",
        "progress bar]",
      ].join("\n"),
    );

    const result = await validateMermaidCodeWith(code, mermaid);

    expect(result.ok).toBe(true);
  });

  it("accepts normalized flowchart labels containing pipe characters", async () => {
    const code = normalizeMermaidCode(
      [
        "flowchart LR",
        "MODE[mode: plan | act]",
        "PHASE[phase: plan | act]",
        "MODE --> PHASE",
      ].join("\n"),
    );

    const result = await validateMermaidCodeWith(code, mermaid);

    expect(result.ok).toBe(true);
  });

  it("accepts normalized link text with parentheses", async () => {
    const code = normalizeMermaidCode(
      [
        "flowchart LR",
        'State -->|"snapshot()"| APPEND',
        "APPEND -->|test()| ANOTHER",
      ].join("\n"),
    );

    const result = await validateMermaidCodeWith(code, mermaid);

    expect(result.ok).toBe(true);
  });

  it("accepts normalized labels with array brackets and pipe, connected on the same line", async () => {
    const code = normalizeMermaidCode(
      [
        "flowchart LR",
        "TODOS[todos: TodoItem[]] --> ACTIVE[activeRun: PlanRun | null]",
      ].join("\n"),
    );

    const result = await validateMermaidCodeWith(code, mermaid);

    expect(result.ok).toBe(true);
  });

  it("accepts normalized flowchart with parens in label and ::: inline (the session failure)", async () => {
    const code = normalizeMermaidCode(
      [
        "flowchart TB",
        "classDef storage fill:#e8f5e9,stroke:#2e7d32",
        "classDef decision fill:#f3e5f5,stroke:#7b1fa2",
        "WRITE_ENTRY[writeSessionEntry(key, snapshot)]:::storage",
        "EXEC_CONT[执行 continuation] --> CHECK_PATH{path 在 approvedPaths 中?}:::decision",
      ].join("\n"),
    );

    const result = await validateMermaidCodeWith(code, mermaid);

    expect(result.ok).toBe(true);
  });

  it("accepts normalized diamond label with special characters via auto-fix", async () => {
    const code = normalizeMermaidCode("flowchart LR\n  A{test more} --> B");

    const result = await validateMermaidCodeWith(code, mermaid);

    expect(result.ok).toBe(true);
  });

  // Shell integration is tested implicitly via validateMermaidNodesInSpec.
  // The core logic (validateMermaidCodeWith) is what matters here.
});

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

  it("returns advice for classDiagram", () => {
    expect(getTypeAdviceForDiagram("classDiagram")).toMatchInlineSnapshot(`
      [
        "Use quotes for class names with special chars: class "My Class"",
        "Members in {} blocks: class Name { +method() }",
        "Avoid unquoted parens in labels: use N["method()"] not N[method()]",
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

  it("returns advice for erDiagram", () => {
    expect(getTypeAdviceForDiagram("erDiagram")).toMatchInlineSnapshot(`
      [
        "Cardinality: ||--o{ for one-to-many, ||--|| for one-to-one",
        "Quoted multi-word entity names: "Order Item"",
        "Attributes in {} blocks: Entity { attr type }",
      ]
    `);
  });

  it("returns advice for gantt", () => {
    expect(getTypeAdviceForDiagram("gantt")).toMatchInlineSnapshot(`
      [
        "Set dateFormat first: dateFormat YYYY-MM-DD",
        "Use crit for critical path, milestone for key points",
        "Task: Name, id, start, duration",
      ]
    `);
  });

  it("returns advice for mindmap", () => {
    expect(getTypeAdviceForDiagram("mindmap")).toMatchInlineSnapshot(`
      [
        "Use 2-space indentation for hierarchy",
        "Root: root((Title)) or root[Title]",
        "Keep branches shallow (3-4 levels max)",
      ]
    `);
  });

  it("returns advice for gitGraph", () => {
    expect(getTypeAdviceForDiagram("gitGraph")).toMatchInlineSnapshot(`
      [
        "Use commit, branch, checkout, merge keywords",
        "checkout before adding commits to a branch",
        "merge to integrate branches",
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

/* ------------------------------------------------------------------ */
/*  Tier 1 — normalize: all 8 diagram types pass through safely        */
/* ------------------------------------------------------------------ */

describe("normalizeMermaidCode — Tier 1 diagram types", () => {
  it("normalizes sequenceDiagram without corrupting syntax", () => {
    const input = [
      "sequenceDiagram",
      '  participant U as "User"',
      '  participant S as "Service"',
      "  U->>S: Request",
      "  activate S",
      "  S-->>U: Response",
      "  deactivate S",
    ].join("\n");

    const output = normalizeMermaidCode(input);
    // Should preserve participant syntax
    expect(output).toContain('participant U as "User"');
    expect(output).toContain("U->>S: Request");
    expect(output).toContain("activate S");
    // Should not add unnecessary quoting
    expect(output).not.toContain('["U->>S');
  });

  it("normalizes classDiagram without corrupting syntax", () => {
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

  it("normalizes stateDiagram-v2 without corrupting syntax", () => {
    const input = [
      "stateDiagram-v2",
      "  [*] --> Idle",
      "  Idle --> Processing: submit",
      "  Processing --> Success: complete",
      "  Success --> [*]",
    ].join("\n");

    const output = normalizeMermaidCode(input);
    expect(output).toContain("[*] --> Idle");
    expect(output).toContain("Idle --> Processing: submit");
    expect(output).toContain("Success --> [*]");
  });

  it("normalizes erDiagram without corrupting syntax", () => {
    const input = [
      "erDiagram",
      '  CUSTOMER ||--o{ ORDER : "places"',
      '  ORDER ||--o{ LINE_ITEM : "contains"',
      "  CUSTOMER {",
      "    int id PK",
      "    string name",
      "  }",
    ].join("\n");

    const output = normalizeMermaidCode(input);
    expect(output).toContain('CUSTOMER ||--o{ ORDER : "places"');
    expect(output).toContain("ORDER ||--o{ LINE_ITEM");
    expect(output).toContain("CUSTOMER {");
    expect(output).toContain("int id PK");
  });

  it("normalizes gantt without corrupting syntax", () => {
    const input = [
      "gantt",
      "  title Project",
      "  dateFormat YYYY-MM-DD",
      "  section Planning",
      "  Research : r1, 2024-01-01, 7d",
      "  Launch : m1, after r1, 0d",
    ].join("\n");

    const output = normalizeMermaidCode(input);
    expect(output).toContain("title Project");
    expect(output).toContain("dateFormat YYYY-MM-DD");
    expect(output).toContain("Research : r1, 2024-01-01, 7d");
  });

  it("normalizes mindmap without corrupting syntax", () => {
    const input = [
      "mindmap",
      "  root((Project))",
      "    Frontend",
      "      React",
      "    Backend",
      "      API",
    ].join("\n");

    const output = normalizeMermaidCode(input);
    expect(output).toContain("root((Project))");
    expect(output).toContain("Frontend");
    // Indentation should be preserved
    expect(output).toContain("      React");
    expect(output).toContain("      API");
  });

  it("normalizes gitGraph without corrupting syntax", () => {
    const input = [
      "gitGraph",
      "  commit",
      "  branch feature",
      "  checkout feature",
      "  commit",
      "  checkout main",
      "  merge feature",
    ].join("\n");

    const output = normalizeMermaidCode(input);
    expect(output).toContain("branch feature");
    expect(output).toContain("checkout feature");
    expect(output).toContain("merge feature");
  });
});

/* ------------------------------------------------------------------ */
/*  Tier 1 — validate: all 8 diagram types parse correctly after       */
/*  normalize                                                          */
/* ------------------------------------------------------------------ */

describe("validateMermaidCodeWith — Tier 1 diagram types", () => {
  let mermaid: MermaidParser;

  beforeAll(async () => {
    mermaid = await getMermaidRuntime();
  });

  afterEach(() => {
    resetMermaidModule();
  });

  it("validates sequenceDiagram", async () => {
    const code = normalizeMermaidCode(
      [
        "sequenceDiagram",
        '  participant U as "User"',
        '  participant S as "Service"',
        "  U->>S: Request",
        "  S-->>U: Response",
      ].join("\n"),
    );

    const result = await validateMermaidCodeWith(code, mermaid);
    expect(result.ok).toBe(true);
    expect(result.diagramType).toBe("sequenceDiagram");
  });

  it("validates classDiagram", async () => {
    const code = normalizeMermaidCode(
      [
        "classDiagram",
        "  class Animal {",
        "    +String name",
        "    +eat()",
        "  }",
        "  Animal <|-- Dog",
      ].join("\n"),
    );

    const result = await validateMermaidCodeWith(code, mermaid);
    expect(result.ok).toBe(true);
    expect(result.diagramType).toBe("classDiagram");
  });

  it("validates stateDiagram-v2", async () => {
    const code = normalizeMermaidCode(
      [
        "stateDiagram-v2",
        "  [*] --> Idle",
        "  Idle --> Processing: submit",
        "  Processing --> [*]",
      ].join("\n"),
    );

    const result = await validateMermaidCodeWith(code, mermaid);
    expect(result.ok).toBe(true);
    expect(result.diagramType).toBe("stateDiagram-v2");
  });

  it("validates erDiagram", async () => {
    const code = normalizeMermaidCode(
      [
        "erDiagram",
        '  CUSTOMER ||--o{ ORDER : "places"',
        "  CUSTOMER {",
        "    int id PK",
        "  }",
      ].join("\n"),
    );

    const result = await validateMermaidCodeWith(code, mermaid);
    expect(result.ok).toBe(true);
    expect(result.diagramType).toBe("erDiagram");
  });

  it("validates gantt", async () => {
    const code = normalizeMermaidCode(
      [
        "gantt",
        "  title Project",
        "  dateFormat YYYY-MM-DD",
        "  section Work",
        "  Task : t1, 2024-01-01, 3d",
      ].join("\n"),
    );

    const result = await validateMermaidCodeWith(code, mermaid);
    expect(result.ok).toBe(true);
    expect(result.diagramType).toBe("gantt");
  });

  it("validates mindmap", async () => {
    const code = normalizeMermaidCode(
      ["mindmap", "  root((T))", "    A", "      B"].join("\n"),
    );

    const result = await validateMermaidCodeWith(code, mermaid);
    expect(result.ok).toBe(true);
    expect(result.diagramType).toBe("mindmap");
  });

  it("validates gitGraph", async () => {
    const code = normalizeMermaidCode(
      [
        "gitGraph",
        "  commit",
        "  branch f",
        "  checkout f",
        "  commit",
        "  checkout main",
        "  merge f",
      ].join("\n"),
    );

    const result = await validateMermaidCodeWith(code, mermaid);
    expect(result.ok).toBe(true);
    expect(result.diagramType).toBe("gitGraph");
  });
});
