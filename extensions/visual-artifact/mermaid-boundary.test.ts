import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { MermaidParser } from "./mermaid-boundary.ts";
import {
  getMermaidRuntime,
  normalizeMermaidCode,
  normalizeMermaidNodesInSpec,
  resetMermaidModule,
  validateMermaidCodeWith,
} from "./mermaid-boundary.ts";

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
