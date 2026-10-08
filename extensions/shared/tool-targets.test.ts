import { describe, expect, it } from "vitest";

import { pathsFromToolArgs } from "./tool-targets.js";

describe("pathsFromToolArgs: pi write shapes", () => {
  it("extracts paths from a non-empty multi array", () => {
    expect(
      pathsFromToolArgs({
        multi: [
          { path: "src/a.ts", oldText: "x", newText: "y" },
          { path: "src/b.ts", oldText: "x", newText: "y" },
        ],
      }),
    ).toEqual([{ rawPath: "src/a.ts" }, { rawPath: "src/b.ts" }]);
  });

  it("lets multi entries inherit the top-level path", () => {
    expect(
      pathsFromToolArgs({
        path: "src/a.ts",
        multi: [{ oldText: "x", newText: "y" }],
      }),
    ).toEqual([{ rawPath: "src/a.ts" }]);
  });

  it("falls through to patch headers when the multi array is empty", () => {
    expect(
      pathsFromToolArgs({
        multi: [],
        patch: `*** Begin Patch
*** Update File: src/a.ts
*** Add File: src/b.ts
*** Delete File: src/c.ts
*** End Patch`,
      }),
    ).toEqual([
      { rawPath: "src/a.ts" },
      { rawPath: "src/b.ts" },
      { rawPath: "src/c.ts" },
    ]);
  });

  it("uses the top-level path when multi and patch are both empty", () => {
    expect(
      pathsFromToolArgs({ multi: [], patch: "", path: "src/a.ts" }),
    ).toEqual([{ rawPath: "src/a.ts" }]);
  });

  it("returns no paths when nothing is provided", () => {
    expect(pathsFromToolArgs({ multi: [], patch: "", path: "" })).toEqual([]);
    expect(pathsFromToolArgs({})).toEqual([]);
  });

  it("dedupes repeated paths", () => {
    expect(
      pathsFromToolArgs({
        multi: [
          { path: "src/a.ts", oldText: "x", newText: "y" },
          { path: "src/a.ts", oldText: "z", newText: "w" },
        ],
      }),
    ).toEqual([{ rawPath: "src/a.ts" }]);
  });
});

describe("pathsFromToolArgs: MCP shapes", () => {
  it("reads the snake_case file_path shape used by MCP servers", () => {
    expect(
      pathsFromToolArgs({ file_path: "docs/guide.md", content: "x" }),
    ).toEqual([{ rawPath: "docs/guide.md" }]);
  });

  it("reads camelCase and filename aliases", () => {
    expect(pathsFromToolArgs({ filePath: "src/a.ts" })).toEqual([
      { rawPath: "src/a.ts" },
    ]);
    expect(pathsFromToolArgs({ filename: "src/b.ts" })).toEqual([
      { rawPath: "src/b.ts" },
    ]);
  });

  it("reads path lists of strings and of objects", () => {
    expect(pathsFromToolArgs({ paths: ["src/a.ts", "src/b.ts"] })).toEqual([
      { rawPath: "src/a.ts" },
      { rawPath: "src/b.ts" },
    ]);
    expect(pathsFromToolArgs({ files: [{ path: "src/c.ts" }] })).toEqual([
      { rawPath: "src/c.ts" },
    ]);
  });

  it("keeps pi's write shapes winning over aliases", () => {
    expect(
      pathsFromToolArgs({
        path: "src/a.ts",
        multi: [{ oldText: "x", newText: "y" }],
      }),
    ).toEqual([{ rawPath: "src/a.ts" }]);
    expect(
      pathsFromToolArgs({
        path: "src/a.ts",
        patch: "*** Update File: src/b.ts",
      }),
    ).toEqual([{ rawPath: "src/b.ts" }]);
  });

  it("ignores empty, whitespace and remote URI values", () => {
    expect(pathsFromToolArgs({ path: "   " })).toEqual([]);
    expect(pathsFromToolArgs({ path: "https://example.com/plan.md" })).toEqual(
      [],
    );
    expect(
      pathsFromToolArgs({ paths: ["file:///tmp/a.md", "src/a.ts"] }),
    ).toEqual([{ rawPath: "src/a.ts" }]);
  });

  it("trims values and dedupes repeats", () => {
    expect(pathsFromToolArgs({ paths: [" src/a.ts ", "src/a.ts"] })).toEqual([
      { rawPath: "src/a.ts" },
    ]);
  });

  it("returns no paths for unrelated arguments", () => {
    expect(pathsFromToolArgs({ query: "search terms" })).toEqual([]);
    expect(pathsFromToolArgs(undefined)).toEqual([]);
  });
});
