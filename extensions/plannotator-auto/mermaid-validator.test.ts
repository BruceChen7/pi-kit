import { describe, expect, it, vi } from "vitest";
import type { MermaidParser } from "../shared/mermaid-runtime.ts";
import {
  countLeadingFrontmatterLines,
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

describe("countLeadingFrontmatterLines", () => {
  it("returns 0 for bodies without frontmatter", () => {
    expect(countLeadingFrontmatterLines("flowchart TD\n  A --> B")).toBe(0);
  });

  it("counts a complete leading frontmatter block including delimiters", () => {
    expect(
      countLeadingFrontmatterLines(
        "---\nconfig:\n  theme: base\n---\nflowchart TD\n  A --> B",
      ),
    ).toBe(4);
  });

  it("counts blank lines inside the frontmatter block", () => {
    expect(
      countLeadingFrontmatterLines("---\nconfig:\n\n\n---\nflowchart TD"),
    ).toBe(5);
  });

  it("returns 0 for an unclosed leading delimiter", () => {
    expect(countLeadingFrontmatterLines("---\nflowchart TD\n  A --> B")).toBe(
      0,
    );
  });

  it("returns 0 when frontmatter does not start the body", () => {
    expect(
      countLeadingFrontmatterLines("flowchart TD\n---\nconfig:\n---"),
    ).toBe(0);
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
