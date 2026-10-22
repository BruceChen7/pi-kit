import { describe, expect, it } from "vitest";
import {
  classifyDivergence,
  collectArtifactMermaidNodes,
  collectMermaidFences,
  countDivergences,
  detectDiagramType,
  parseSamples,
  summarizeReport,
} from "./mermaid-corpus-diff.mjs";

describe("collectMermaidFences", () => {
  it("reports the opening fence line and the block body", () => {
    const markdown = [
      "# Plan",
      "",
      "```mermaid",
      "flowchart LR",
      "  A --> B",
      "```",
    ].join("\n");

    expect(collectMermaidFences(markdown)).toEqual([
      { startLine: 3, body: "flowchart LR\n  A --> B" },
    ]);
  });

  it("collects every mermaid fence and ignores other fences", () => {
    const markdown = [
      "```bash",
      "echo hi",
      "```",
      "```mermaid",
      "flowchart TD",
      "  A --> B",
      "```",
      "```mermaid",
      "sequenceDiagram",
      "  A->>B: hi",
      "```",
    ].join("\n");

    expect(
      collectMermaidFences(markdown).map(
        (fence: { startLine: number }) => fence.startLine,
      ),
    ).toEqual([4, 8]);
  });

  it("includes an unclosed fence so the probe sees what the gate sees", () => {
    const markdown = ["```mermaid", "flowchart TD", "  A --> B"].join("\n");

    expect(collectMermaidFences(markdown)).toEqual([
      { startLine: 1, body: "flowchart TD\n  A --> B" },
    ]);
  });
});

describe("collectArtifactMermaidNodes", () => {
  const spec = JSON.stringify({
    nodes: [
      { type: "text", props: { text: "hello" } },
      {
        type: "section",
        props: {
          children: [
            {
              type: "mermaid",
              props: { definition: "flowchart LR\n  A --> B" },
            },
          ],
        },
      },
      { type: "mermaid", props: { code: "sequenceDiagram\n  A->>B: hi" } },
      { type: "mermaid", props: { definition: "   " } },
    ],
  });

  it("walks nested nodes and both code property names", () => {
    const nodes = collectArtifactMermaidNodes(spec);

    expect(nodes.map((node: { body: string }) => node.body)).toEqual([
      "flowchart LR\n  A --> B",
      "sequenceDiagram\n  A->>B: hi",
    ]);
    expect(nodes[0].path).toBe("$.nodes[1].props.children[0]");
  });

  it("returns nothing for invalid JSON", () => {
    expect(collectArtifactMermaidNodes("{not json")).toEqual([]);
  });
});

describe("detectDiagramType", () => {
  it("skips YAML frontmatter", () => {
    const body = [
      "---",
      "config:",
      "  theme: base",
      "---",
      "flowchart LR",
      "  A --> B",
    ].join("\n");

    expect(detectDiagramType(body)).toBe("flowchart");
  });

  it("skips comments and blank lines", () => {
    expect(detectDiagramType("%% note\n\nsequenceDiagram\n  A->>B: hi")).toBe(
      "sequenceDiagram",
    );
  });

  it("returns undefined for an empty body", () => {
    expect(detectDiagramType("\n  \n")).toBeUndefined();
  });
});

describe("classifyDivergence", () => {
  it("maps the four outcome combinations", () => {
    expect(classifyDivergence({ ok: true }, { ok: true })).toBe("both-ok");
    expect(classifyDivergence({ ok: false }, { ok: false })).toBe("both-fail");
    expect(classifyDivergence({ ok: true }, { ok: false })).toBe(
      "mermaid-only-ok",
    );
    expect(classifyDivergence({ ok: false }, { ok: true })).toBe(
      "pele-only-ok",
    );
  });
});

describe("countDivergences / parseSamples", () => {
  const results = [
    { kind: "both-ok", location: "a:1" },
    { kind: "mermaid-only-ok", location: "b:2" },
    { kind: "mermaid-only-ok", location: "c:3" },
    { kind: "pele-only-ok", location: "d:4" },
    { kind: "both-fail", location: "e:5" },
  ];

  it("counts every bucket", () => {
    expect(countDivergences(results)).toEqual({
      "both-ok": 1,
      "both-fail": 1,
      "mermaid-only-ok": 2,
      "pele-only-ok": 1,
    });
  });

  it("selects samples by bucket and honours the limit", () => {
    expect(
      parseSamples(results, "mermaid-only-ok").map(
        (r: { location: string }) => r.location,
      ),
    ).toEqual(["b:2", "c:3"]);
    expect(
      parseSamples(results, "mermaid-only-ok", 1).map(
        (r: { location: string }) => r.location,
      ),
    ).toEqual(["b:2"]);
    expect(
      parseSamples(results, "both-ok").map(
        (r: { location: string }) => r.location,
      ),
    ).toEqual(["a:1"]);
  });
});

describe("summarizeReport", () => {
  const engines = {
    mermaid: { version: "11.0.0", importMs: 700, parseMs: 100, parseCount: 10 },
    pele: { version: "1.6.0", importMs: 20, parseMs: 2, parseCount: 10 },
  };

  it("states the verdict, buckets and engine cost", () => {
    const report = summarizeReport({
      sources: [".pi/plans"],
      engines,
      results: [
        {
          kind: "both-ok",
          origin: "fence",
          diagramType: "flowchart",
          location: "a:1",
          mermaid: { ok: true },
          pele: { ok: true },
        },
        {
          kind: "both-fail",
          origin: "fence",
          diagramType: "flowchart",
          location: "b:2",
          mermaid: { ok: false, error: "boom" },
          pele: { ok: false, error: "boom" },
        },
      ],
    });

    expect(report).toContain("No `mermaid-only-ok` block in this corpus");
    expect(report).toContain("| both-ok | 1 |");
    expect(report).toContain("| mermaid 11.0.0 | 700 ms | 100 ms | 10.0 ms |");
    expect(report).toContain("| flowchart | 2 |");
    expect(report).toContain("`.pi/plans`");
  });

  it("flags the blocking bucket in the verdict line", () => {
    const report = summarizeReport({
      sources: [".pi/plans"],
      engines,
      results: [
        {
          kind: "mermaid-only-ok",
          origin: "fence",
          diagramType: "flowchart",
          location: "b:2",
          mermaid: { ok: true },
          pele: { ok: false, error: "Parse error on line 1:\n^\nnope" },
        },
      ],
    });

    expect(report).toContain("**1 `mermaid-only-ok` block(s)**");
    expect(report).toContain("- pele: Parse error on line 1:");
    expect(report).not.toContain("- mermaid:");
  });
});
