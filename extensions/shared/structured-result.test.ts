import { describe, expect, it } from "vitest";
import { jsonStructuredResult, structuredResult } from "./structured-result.ts";

describe("structuredResult", () => {
  it("keeps the text model-facing and shares one payload object", () => {
    const payload = {
      tool: "qmd_query",
      query: "create worktree",
      results: [{ file: "docs/a.md", score: 0.8 }],
    };

    const result = structuredResult("QMD Query: create worktree", payload);

    expect(result.content).toEqual([
      { type: "text", text: "QMD Query: create worktree" },
    ]);
    expect(result.details).toBe(payload);
    expect(result.structuredContent).toBe(payload);
  });

  it("accepts an empty payload without marking the result as an error", () => {
    const result = structuredResult("nothing here", {});

    expect(result.structuredContent).toEqual({});
    expect(result.isError).toBeUndefined();
  });

  it("keeps null-bearing payloads intact", () => {
    const result = structuredResult("ok", { path: null, total: 0 });

    expect(result.structuredContent).toEqual({ path: null, total: 0 });
  });
});

describe("jsonStructuredResult", () => {
  it("renders the payload as the model-facing text", () => {
    const payload = { absolutePath: "src/a.ts", content: "1: a" };

    const result = jsonStructuredResult(payload);

    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify(payload, null, 2) },
    ]);
    expect(result.details).toBe(payload);
    expect(result.structuredContent).toBe(payload);
  });

  it("renders arrays as JSON, not as a list of entries", () => {
    const result = jsonStructuredResult(["src/a.ts", "src/b.ts"]);

    expect(result.content).toEqual([
      { type: "text", text: '[\n  "src/a.ts",\n  "src/b.ts"\n]' },
    ]);
    expect(result.structuredContent).toEqual(["src/a.ts", "src/b.ts"]);
  });
});
