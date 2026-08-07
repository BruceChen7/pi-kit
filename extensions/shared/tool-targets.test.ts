import { describe, expect, it } from "vitest";

import { pathsFromWriteToolInput } from "./tool-targets.js";

describe("pathsFromWriteToolInput", () => {
  it("extracts paths from a non-empty multi array", () => {
    expect(
      pathsFromWriteToolInput({
        multi: [
          { path: "src/a.ts", oldText: "x", newText: "y" },
          { path: "src/b.ts", oldText: "x", newText: "y" },
        ],
      }),
    ).toEqual([{ rawPath: "src/a.ts" }, { rawPath: "src/b.ts" }]);
  });

  it("lets multi entries inherit the top-level path", () => {
    expect(
      pathsFromWriteToolInput({
        path: "src/a.ts",
        multi: [{ oldText: "x", newText: "y" }],
      }),
    ).toEqual([{ rawPath: "src/a.ts" }]);
  });

  it("falls through to patch headers when the multi array is empty", () => {
    expect(
      pathsFromWriteToolInput({
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
      pathsFromWriteToolInput({ multi: [], patch: "", path: "src/a.ts" }),
    ).toEqual([{ rawPath: "src/a.ts" }]);
  });

  it("returns no paths when nothing is provided", () => {
    expect(pathsFromWriteToolInput({ multi: [], patch: "", path: "" })).toEqual(
      [],
    );
    expect(pathsFromWriteToolInput({})).toEqual([]);
  });

  it("dedupes repeated paths", () => {
    expect(
      pathsFromWriteToolInput({
        multi: [
          { path: "src/a.ts", oldText: "x", newText: "y" },
          { path: "src/a.ts", oldText: "z", newText: "w" },
        ],
      }),
    ).toEqual([{ rawPath: "src/a.ts" }]);
  });
});
