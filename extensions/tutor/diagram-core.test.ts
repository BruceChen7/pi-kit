import { describe, expect, it } from "vitest";
import { getMermaidParser } from "../shared/mermaid-runtime.ts";
import {
  detectRenderCapability,
  extractMermaidBlocks,
  renderArgs,
  validateMermaidInput,
  validateMermaidSource,
} from "./diagram-core.ts";

const goodFlowchart = 'flowchart TB\n  A["start"] --> B["stop"]';

describe("diagram-core / capability and args", () => {
  it("degrades to a skip reason when mmdc is missing", () => {
    expect(detectRenderCapability(false)).toEqual({
      render: false,
      reason: "mmdc-not-found",
    });
    expect(detectRenderCapability(true)).toEqual({ render: true });
  });

  it("builds mmdc arguments", () => {
    expect(
      renderArgs({ inputPath: "/tmp/a.mmd", outputPath: "/tmp/a.png" }),
    ).toEqual(["-i", "/tmp/a.mmd", "-o", "/tmp/a.png"]);
  });
});

describe("diagram-core / fence extraction", () => {
  it("returns nothing for markdown without mermaid", () => {
    expect(extractMermaidBlocks("# title\n\ntext")).toEqual([]);
  });

  it("extracts closed fences in order", () => {
    const markdown =
      "```mermaid\nflowchart TB\n  A --> B\n```\n\ntext\n\n```mermaid\nsequenceDiagram\n  A->>B: hi\n```\n";
    const blocks = extractMermaidBlocks(markdown);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].source).toContain("flowchart TB");
    expect(blocks[1].source).toContain("sequenceDiagram");
  });

  it("still returns an unclosed fence so it can be reported", () => {
    const blocks = extractMermaidBlocks("```mermaid\nflowchart TB\n  A --> B");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].source).toContain("A --> B");
  });
});

describe("diagram-core / validation (real parser, no browser)", () => {
  it("accepts a valid diagram and reports its type", async () => {
    const parser = await getMermaidParser();
    const result = await validateMermaidSource(goodFlowchart, parser);
    expect(result.ok).toBe(true);
    expect(result.diagramType).toBe("flowchart");
  });

  it("rejects an empty diagram", async () => {
    const parser = await getMermaidParser();
    const result = await validateMermaidSource("   ", parser);
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.errors.join(" ")).toContain("empty");
  });

  it("rejects broken syntax with a readable error", async () => {
    const parser = await getMermaidParser();
    const result = await validateMermaidSource(
      "flowchart TB\n  A --> ",
      parser,
    );
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].length).toBeGreaterThan(0);
    }
  });

  it("validates every fence in a markdown snippet", async () => {
    const parser = await getMermaidParser();
    const { results, fromFences } = await validateMermaidInput(
      `text\n\n\`\`\`mermaid\n${goodFlowchart}\n\`\`\`\n`,
      parser,
    );
    expect(fromFences).toBe(true);
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
  });

  it("treats input without fences as a bare diagram", async () => {
    const parser = await getMermaidParser();
    const { results, fromFences } = await validateMermaidInput(
      goodFlowchart,
      parser,
    );
    expect(fromFences).toBe(false);
    expect(results[0].ok).toBe(true);
  });
});
