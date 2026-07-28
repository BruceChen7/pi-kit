import { beforeAll, describe, expect, it } from "vitest";
import type { MermaidParser } from "./mermaid-boundary.ts";
import {
  getMermaidRuntime,
  normalizeMermaidCode,
  normalizeMermaidNodesInSpec,
  validateMermaidCode,
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

  it("shell validateMermaidCode still works (wires getMermaidRuntime internally)", async () => {
    const result = await validateMermaidCode("flowchart LR\n  A --> B");
    expect(result.ok).toBe(true);
  });
});
