import { describe, expect, it } from "vitest";
import {
  normalizeMermaidCode,
  normalizeMermaidNodesInSpec,
  validateMermaidCode,
} from "./mermaid-boundary.ts";

describe("normalizeMermaidCode", () => {
  it("quotes multiline flowchart labels containing nested brackets", () => {
    const input = [
      "graph TD",
      "UPDATE_UI --> |todo widget| SHOW_TODO[#id [✓/~/!] text",
      "progress bar]",
    ].join("\n");

    const output = normalizeMermaidCode(input);

    expect(output).toContain('SHOW_TODO["#id [✓/~/!] text<br/>progress bar"]');
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

    expect(nestedCode).toContain('Y["label [inner]<br/>next"]');
  });
});

describe("validateMermaidCode", () => {
  it("accepts the normalized version of the current parse-error case", async () => {
    const code = normalizeMermaidCode(
      [
        "graph TD",
        "UPDATE_UI --> |todo widget| SHOW_TODO[#id [✓/~/!] text",
        "progress bar]",
      ].join("\n"),
    );

    const result = await validateMermaidCode(code);

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

    const result = await validateMermaidCode(code);

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

    const result = await validateMermaidCode(code);

    expect(result.ok).toBe(true);
  });

  it("accepts normalized labels with array brackets and pipe, connected on the same line", async () => {
    const code = normalizeMermaidCode(
      [
        "flowchart LR",
        "TODOS[todos: TodoItem[]] --> ACTIVE[activeRun: PlanRun | null]",
      ].join("\n"),
    );

    const result = await validateMermaidCode(code);

    expect(result.ok).toBe(true);
  });
});
