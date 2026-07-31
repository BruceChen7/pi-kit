import { describe, expect, it, vi } from "vitest";
import type { MermaidParser } from "../shared/mermaid-runtime.ts";
import {
  countLeadingStrippedLines,
  formatPlanMermaidErrors,
  runPlanMermaidValidation,
  scanMermaidBlocks,
  validatePlanMermaidBlocks,
} from "./mermaid-validator.ts";

/** Realistic mermaid parse error shape (line 2, caret excerpt). */
const PARSE_ERROR_LINE_2 = new Error(
  "Parse error on line 2:\n" +
    "...lowchart TD  A[bad (label] --> B\n" +
    "----------------------^\n" +
    "Expecting 'PS', got 'TEXT'",
);

/** Parse-only stub for the pure core (validatePlanMermaidBlocks). */
const failingParser = (failBodies: string[]): MermaidParser => {
  const fails = new Set(failBodies);
  return {
    initialize: vi.fn(),
    parse: vi.fn(async (code: string) => {
      if (fails.has(code)) throw PARSE_ERROR_LINE_2;
      return undefined;
    }),
  };
};

const passingParser = (): MermaidParser => ({
  initialize: vi.fn(),
  parse: vi.fn(async () => undefined),
});

describe("scanMermaidBlocks", () => {
  it("extracts multiple mermaid blocks with 1-based start lines", () => {
    const markdown = [
      "# Plan",
      "",
      "```mermaid",
      "sequenceDiagram",
      "  A->>B: x",
      "```",
      "",
      "text",
      "",
      "```mermaid",
      "flowchart LR",
      "  A --> B",
      "```",
    ].join("\n");

    const { blocks, fenceErrors } = scanMermaidBlocks(markdown);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      startLine: 3,
      diagramType: "sequenceDiagram",
    });
    expect(blocks[0]?.body).toContain("A->>B: x");
    expect(blocks[1]).toMatchObject({
      startLine: 10,
      diagramType: "flowchart",
    });
    expect(fenceErrors).toHaveLength(0);
  });

  it("skips non-mermaid fences", () => {
    const markdown = [
      "```ts",
      "const x = 1;",
      "```",
      "```mermaid",
      "graph TD",
      "  A-->B",
      "```",
    ].join("\n");

    const { blocks } = scanMermaidBlocks(markdown);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.startLine).toBe(4);
  });

  it("keeps frontmatter config inside the body (parsed natively by mermaid)", () => {
    const markdown = [
      "```mermaid",
      "---",
      "config:",
      "  theme: base",
      "---",
      "sequenceDiagram",
      "  A->>B: x",
      "```",
    ].join("\n");

    const { blocks } = scanMermaidBlocks(markdown);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.body.startsWith("---")).toBe(true);
    expect(blocks[0]?.body).toContain("sequenceDiagram");
    expect(blocks[0]?.diagramType).toBe("sequenceDiagram");
  });

  it("reports unclosed fences as fence errors (self-contained)", () => {
    const markdown = ["# Plan", "", "```mermaid", "graph TD", "  A-->B"].join(
      "\n",
    );

    const { blocks, fenceErrors } = scanMermaidBlocks(markdown);

    expect(blocks).toHaveLength(0);
    expect(fenceErrors).toHaveLength(1);
    expect(fenceErrors[0]).toMatchObject({
      startLine: 3,
      message: expect.stringContaining("未闭合"),
    });
  });

  it("reports empty fences as fence errors", () => {
    const markdown = ["```mermaid", "```"].join("\n");

    const { blocks, fenceErrors } = scanMermaidBlocks(markdown);

    expect(blocks).toHaveLength(0);
    expect(fenceErrors).toHaveLength(1);
    expect(fenceErrors[0]?.startLine).toBe(1);
    expect(fenceErrors[0]?.message).toContain("为空");
  });
});

describe("countLeadingStrippedLines", () => {
  it("returns 0 for bodies without frontmatter", () => {
    expect(countLeadingStrippedLines("flowchart TD\n  A --> B")).toBe(0);
  });

  it("counts a complete leading frontmatter block including delimiters", () => {
    expect(
      countLeadingStrippedLines(
        "---\nconfig:\n  theme: base\n---\nflowchart TD\n  A --> B",
      ),
    ).toBe(4);
  });

  it("counts blank lines inside the frontmatter block", () => {
    expect(
      countLeadingStrippedLines("---\nconfig:\n\n\n---\nflowchart TD"),
    ).toBe(5);
  });

  it("returns 0 for an unclosed leading delimiter", () => {
    expect(countLeadingStrippedLines("---\nflowchart TD\n  A --> B")).toBe(0);
  });

  it("returns 0 when frontmatter does not start the body", () => {
    expect(countLeadingStrippedLines("flowchart TD\n---\nconfig:\n---")).toBe(
      0,
    );
  });

  it("counts leading blank lines even without frontmatter", () => {
    expect(countLeadingStrippedLines("\n\nsequenceDiagram\n  A->>B: x")).toBe(
      2,
    );
  });

  it("counts blank lines directly after the frontmatter", () => {
    // mermaid strips frontmatter AND the blank line(s) after it before
    // parsing, so the error-line offset must include them.
    expect(
      countLeadingStrippedLines(
        "---\nconfig:\n  theme: base\n---\n\nsequenceDiagram\n  A->>B: x",
      ),
    ).toBe(5);
  });

  it("counts blank lines before and after an unclosed delimiter only once", () => {
    // Leading blank lines are stripped even when the frontmatter is unclosed.
    expect(countLeadingStrippedLines("\n---\nflowchart TD\n  A --> B")).toBe(1);
  });
});

describe("validatePlanMermaidBlocks", () => {
  it("returns no errors when every block parses", async () => {
    const markdown = [
      "```mermaid",
      "sequenceDiagram",
      "  A->>B: x",
      "```",
      "```mermaid",
      "flowchart LR",
      "  A --> B",
      "```",
    ].join("\n");

    const errors = await validatePlanMermaidBlocks(markdown, passingParser());

    expect(errors).toHaveLength(0);
  });

  it("reports a single failed block with mapped file line", async () => {
    const markdown = [
      "# Plan",
      "",
      "```mermaid",
      "flowchart TD",
      "  A[bad (label] --> B",
      "```",
    ].join("\n");
    const body = "flowchart TD\n  A[bad (label] --> B";

    const errors = await validatePlanMermaidBlocks(
      markdown,
      failingParser([body]),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      startLine: 3,
      // block-internal line 2 → absolute file line 5 (body starts on startLine + 1)
      errorLine: 5,
      diagramType: "flowchart",
    });
    expect(errors[0]?.message).toContain("Expecting 'PS'");
  });

  it("maps error lines correctly for blocks with YAML frontmatter", async () => {
    const markdown = [
      "```mermaid",
      "---",
      "config:",
      "  theme: base",
      "---",
      "flowchart TD",
      "  A[bad (label] --> B",
      "```",
    ].join("\n");
    const body = [
      "---",
      "config:",
      "  theme: base",
      "---",
      "flowchart TD",
      "  A[bad (label] --> B",
    ].join("\n");

    // Mermaid strips the 4 frontmatter lines before parsing, so the reported
    // line 2 refers to the stripped code — the absolute file line must add
    // the frontmatter height back: 1 (fence) + 4 (frontmatter) + 2.
    const errors = await validatePlanMermaidBlocks(
      markdown,
      failingParser([body]),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]?.errorLine).toBe(7);
  });

  it("collects ALL failures (no fail-fast)", async () => {
    const markdown = [
      "```mermaid",
      "graph TD",
      "  A-->B",
      "```",
      "```mermaid",
      "flowchart LR",
      "  BAD[",
      "```",
      "```mermaid",
      "sequenceDiagram",
      "  X->>Y: ok",
      "```",
      "```mermaid",
      "mindmap",
      "  root((t",
      "```",
    ].join("\n");
    const blockBodies = [
      "graph TD\n  A-->B",
      "flowchart LR\n  BAD[",
      "sequenceDiagram\n  X->>Y: ok",
      "mindmap\n  root((t",
    ];

    const errors = await validatePlanMermaidBlocks(
      markdown,
      failingParser([blockBodies[1]!, blockBodies[3]!]),
    );

    expect(errors).toHaveLength(2);
    expect(errors[0]?.startLine).toBe(5);
    expect(errors[0]?.diagramType).toBe("flowchart");
    expect(errors[1]?.startLine).toBe(13);
    expect(errors[1]?.diagramType).toBe("mindmap");
  });

  it("reports unknown diagram types with their detected type", async () => {
    const markdown = ["```mermaid", "customThing", "  x", "```"].join("\n");
    const body = "customThing\n  x";

    const errors = await validatePlanMermaidBlocks(
      markdown,
      failingParser([body]),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]?.diagramType).toBe("customThing");
  });

  it("includes fence-structure errors alongside parse errors", async () => {
    const markdown = [
      "```mermaid", // line 1 — closed block, bad syntax → parse error
      "flowchart LR",
      "  BAD[",
      "```",
      "",
      "```mermaid", // line 6 — unclosed → fence error
      "graph TD",
      "  A-->B",
    ].join("\n");
    const body = "flowchart LR\n  BAD[";

    const errors = await validatePlanMermaidBlocks(
      markdown,
      failingParser([body]),
    );

    expect(errors).toHaveLength(2);
    // Fence-structure errors are reported first, then parse errors.
    expect(errors[0]?.startLine).toBe(6);
    expect(errors[0]?.message).toContain("未闭合");
    expect(errors[1]?.startLine).toBe(1);
    expect(errors[1]?.diagramType).toBe("flowchart");
  });

  it("attaches sequenceDiagram diagnostics to a failed block", async () => {
    const markdown = [
      "```mermaid", // line 1
      "sequenceDiagram", // line 2
      "  A->>B: ok", // line 3
      "  Note over A: bad;one", // line 4 — semicolon
      "  Note over B: bad;two", // line 5 — semicolon
      "```",
    ].join("\n");
    const body =
      "sequenceDiagram\n  A->>B: ok\n  Note over A: bad;one\n  Note over B: bad;two";

    const errors = await validatePlanMermaidBlocks(
      markdown,
      failingParser([body]),
    );

    // Wiring contract: a failed sequenceDiagram block carries its
    // content-anchored diagnostics (the core's branching is tested directly
    // in mermaid-normalize.test.ts).
    expect(errors).toHaveLength(1);
    expect(errors[0]?.diagnostics?.map((d) => d.code)).toEqual([
      "Note over A: bad;one",
      "Note over B: bad;two",
    ]);
  });

  it("keeps diagnostics empty for non-sequenceDiagram failures", async () => {
    const markdown = ["```mermaid", "flowchart LR", "  BAD[", "```"].join("\n");
    const body = "flowchart LR\n  BAD[";

    const errors = await validatePlanMermaidBlocks(
      markdown,
      failingParser([body]),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]?.diagnostics).toEqual([]);
  });
});

describe("formatPlanMermaidErrors", () => {
  it("includes file line, diagram type and type-specific advice", () => {
    const text = formatPlanMermaidErrors([
      {
        startLine: 7,
        errorLine: 9,
        diagramType: "flowchart",
        message: "Expecting 'PS', got 'TEXT'",
      },
    ]);

    expect(text).toContain("文件第 9 行");
    expect(text).toContain("flowchart");
    expect(text).toContain("Expecting 'PS'");
    expect(text).toContain('N["label text"]');
  });

  it("renders diagnostics as content anchors (no line numbers)", () => {
    const text = formatPlanMermaidErrors([
      {
        startLine: 10,
        errorLine: 20,
        diagramType: "sequenceDiagram",
        message: "Expecting '()', got 'NEWLINE'",
        diagnostics: [
          {
            // Trimmed source line, exactly as diagnoseSequenceDiagramIssues
            // produces it in the real pipeline.
            code: "Note over T,E: 并发上限 3 由任务侧强制;不引入新依赖",
            message: "Note 文本中的分号 `;` 会导致解析失败",
          },
        ],
      },
    ]);

    // Block-level location still shown; the diagnostic itself is a content
    // anchor the agent can grep for, not a line number.
    expect(text).toContain("文件第 20 行");
    expect(text).toContain("疑似根因: Note 文本中的分号 `;` 会导致解析失败");
    expect(text).toContain(
      "出错行内容: `Note over T,E: 并发上限 3 由任务侧强制;不引入新依赖`",
    );
    // No diagnostic line-number is rendered.
    expect(text).not.toContain("文件第 13 行");
  });

  it("escapes backticks inside the offending source line", () => {
    const text = formatPlanMermaidErrors([
      {
        startLine: 1,
        errorLine: 3,
        diagramType: "sequenceDiagram",
        message: "Expecting '()', got 'NEWLINE'",
        diagnostics: [
          { code: "A->>B: use `foo`;x", message: "消息文本中的分号" },
        ],
      },
    ]);

    expect(text).toContain("出错行内容: `A->>B: use \\`foo\\`;x`");
  });
});

describe("runPlanMermaidValidation", () => {
  it("returns ok when validation passes (real path)", async () => {
    const result = await runPlanMermaidValidation(
      "```mermaid\ngraph TD\n  A-->B\n```\n",
      async () => passingParser(),
    );

    expect(result).toEqual({ skipped: false, errors: [] });
  });

  it("returns failures without skipping", async () => {
    const markdown = "```mermaid\nflowchart TD\n  A[bad (label] --> B\n```";
    const body = "flowchart TD\n  A[bad (label] --> B";

    const result = await runPlanMermaidValidation(markdown, async () =>
      failingParser([body]),
    );

    expect(result.skipped).toBe(false);
    if (!result.skipped) {
      expect(result.errors).toHaveLength(1);
    }
  });

  it("degrades to skipped when the parser provider fails", async () => {
    const result = await runPlanMermaidValidation(
      "```mermaid\ngraph TD\n  A-->B\n```\n",
      async () => {
        throw new Error("mermaid module failed to load");
      },
    );

    expect(result).toEqual({
      skipped: true,
      reason: "mermaid module failed to load",
      errors: [],
    });
  });

  it("degrades to skipped when parser configuration fails", async () => {
    const result = await runPlanMermaidValidation(
      "```mermaid\ngraph TD\n  A-->B\n```\n",
      async () => ({
        initialize: () => {
          throw new Error("initialize failed");
        },
        parse: async () => undefined,
      }),
    );

    expect(result).toEqual({
      skipped: true,
      reason: "initialize failed",
      errors: [],
    });
  });
});
