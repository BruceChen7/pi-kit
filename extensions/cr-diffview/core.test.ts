import { describe, expect, it } from "vitest";

import {
  annotationsFromFinishPayload,
  branchScope,
  buildBranchItems,
  buildNoBranchCandidatesMessage,
  CR_PRESETS,
  type CrSession,
  decideScopeFromPreset,
  decideScopeResolution,
  formatAnnotationsPrompt,
  getBranchCandidates,
  getCrReviewViewId,
  parseSocketPayload,
} from "./core.ts";

describe("cr-diffview pure decisions", () => {
  it("resolves direct targets without interactive UI", () => {
    expect(decideScopeResolution(" main ", false)).toEqual({
      kind: "scope",
      scope: branchScope("main"),
    });
  });

  it("requires interactive mode only when no direct target is provided", () => {
    expect(decideScopeResolution("", false)).toEqual({
      kind: "requiresInteractiveMode",
    });
    expect(decideScopeResolution("", true)).toEqual({
      kind: "needsInteractivePreset",
    });
  });

  it.each([
    ["staged", { target: "", label: "staged changes", diffArgs: ["--cached"] }],
    ["unstaged", { target: "", label: "unstaged changes", diffArgs: [] }],
  ] as const)("maps %s preset to a diff scope", (preset, scope) => {
    expect(decideScopeFromPreset(preset)).toEqual({ kind: "scope", scope });
  });

  it("keeps branch selection as a shell action", () => {
    expect(decideScopeFromPreset("baseBranch")).toEqual({
      kind: "needsBranchSelection",
    });
    expect(decideScopeFromPreset(null)).toEqual({ kind: "cancelled" });
  });

  it("maps lastNCommits preset to a number input decision", () => {
    expect(decideScopeFromPreset("lastNCommits")).toEqual({
      kind: "needsNumberInput",
    });
  });

  it("includes the lastNCommits preset with correct structure", () => {
    const preset = CR_PRESETS.find((p) => p.value === "lastNCommits");
    expect(preset).toBeDefined();
    expect(preset?.label).toBe("Review last N commits");
    expect(preset?.description).toBe("HEAD~N...HEAD");
  });

  it("filters the current branch and sorts default branch first", () => {
    const candidates = getBranchCandidates(
      ["feature", "dev", "main"],
      "feature",
    );

    expect(candidates).toEqual(["dev", "main"]);
    expect(buildBranchItems(candidates, "main")).toEqual([
      { value: "main", label: "main", description: "(default)" },
      { value: "dev", label: "dev", description: "" },
    ]);
  });

  it("builds no-branch messages without requiring UI mocks", () => {
    expect(buildNoBranchCandidatesMessage("feature")).toContain("feature");
    expect(buildNoBranchCandidatesMessage(null)).toBe("No branches found");
  });

  it("uses the active review view id or falls back to the generic view", () => {
    expect(getCrReviewViewId(null)).toBe("pi-cr");
    expect(getCrReviewViewId({ reviewViewId: "pi-cr-repo" } as CrSession)).toBe(
      "pi-cr-repo",
    );
  });
});

describe("cr-diffview socket payload core", () => {
  it("parses socket payloads as data and ignores invalid JSON", () => {
    expect(parseSocketPayload('{"type":"hello"}')).toEqual({ type: "hello" });
    expect(parseSocketPayload("not-json")).toBeNull();
  });

  it("keeps only complete finish annotations with non-empty comments", () => {
    expect(
      annotationsFromFinishPayload({
        type: "finish",
        annotations: [
          { file: "src/a.ts", line: 1, comment: "Please rename." },
          { file: "src/b.ts", line: 2, comment: "   " },
          { file: "src/c.ts", line: Number.NaN, comment: "bad line" },
        ],
      }),
    ).toEqual([{ file: "src/a.ts", line: 1, comment: "Please rename." }]);
  });

  it("formats annotations as review.nvim-style markdown for Pi follow-up", () => {
    const prompt = formatAnnotationsPrompt([
      {
        file: "src/a.ts",
        line: 7,
        type: "fix",
        snippet: " const x = 1\n+const x = 2",
        comment: "Please rename this.",
      },
    ]);

    expect(prompt).toContain("# Code Review Comments");
    expect(prompt).toContain("## src/a.ts");
    expect(prompt).toContain("### [FIX] src/a.ts:7");
    expect(prompt).toContain("```typescript");
    expect(prompt).toContain("+const x = 2");
    expect(prompt).toContain("```");
    expect(prompt).toContain("Please rename this.");
  });

  it("groups annotations by file and maps comment types to labels", () => {
    const prompt = formatAnnotationsPrompt([
      {
        file: "a.py",
        line: 1,
        type: "note",
        snippet: "x = 1",
        comment: "note",
      },
      { file: "a.py", line: 3, type: "question", comment: "q?" },
      { file: "b.go", line: 2, comment: "legacy without type" },
    ]);

    expect(prompt).toContain("### [NOTE] a.py:1");
    expect(prompt).toContain("```python");
    expect(prompt).toContain("### [QUESTION] a.py:3");
    expect(prompt).toContain("### b.go:2");
    expect(prompt.match(/## a\.py/g)).toHaveLength(1);
    expect(prompt.indexOf("## a.py")).toBeLessThan(prompt.indexOf("## b.go"));
  });
});
