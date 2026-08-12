import { describe, expect, it } from "vitest";

import {
  deriveUpdatedContent,
  formatResults,
  generateDiffString,
  getEditModeForRender,
  normalizeEditParams,
  type PatchOperation,
  parsePatch,
  seekSequence,
  type UpdateChunk,
} from "./edit-engine.js";

// Hand-derived fixtures (independent source of truth — expectations are
// literals, not recomputed through the implementation).

describe("normalizeEditParams", () => {
  it("classifies patch vs classic modes and empty-string placeholders", () => {
    expect(normalizeEditParams({})).toEqual({
      mode: "classic",
      path: undefined,
      oldText: undefined,
      newText: undefined,
      multi: undefined,
    });

    expect(
      normalizeEditParams({ path: "", oldText: "", newText: "", multi: [] }),
    ).toEqual({
      mode: "classic",
      path: undefined,
      // An EMPTY multi array is treated as absent, so empty oldText/newText
      // placeholders are preserved (only a non-empty multi drops them).
      oldText: "",
      newText: "",
      multi: undefined,
    });

    expect(
      normalizeEditParams({
        path: "a.txt",
        oldText: "x",
        newText: "y",
      }),
    ).toEqual({
      mode: "classic",
      path: "a.txt",
      oldText: "x",
      newText: "y",
      multi: undefined,
    });
  });

  it("preserves an empty newText for single-edit deletion", () => {
    expect(
      normalizeEditParams({ path: "a.txt", oldText: "x", newText: "" }),
    ).toEqual({
      mode: "classic",
      path: "a.txt",
      oldText: "x",
      newText: "",
      multi: undefined,
    });
  });

  it("drops empty newText/oldText when multi is present", () => {
    expect(
      normalizeEditParams({
        multi: [{ path: "a.txt", oldText: "x", newText: "y" }],
        oldText: "",
        newText: "",
        path: "",
        patch: "",
      }),
    ).toEqual({
      mode: "classic",
      path: undefined,
      oldText: undefined,
      newText: undefined,
      multi: [{ path: "a.txt", oldText: "x", newText: "y" }],
    });
  });

  it("selects patch mode and rejects mixed parameters", () => {
    expect(
      normalizeEditParams({ patch: "*** Begin Patch\n*** End Patch" }),
    ).toEqual({ mode: "patch", patch: "*** Begin Patch\n*** End Patch" });

    expect(() =>
      normalizeEditParams({
        patch: "*** Begin Patch\n*** End Patch",
        multi: [{ path: "a.txt", oldText: "x", newText: "y" }],
      }),
    ).toThrow("mutually exclusive");

    expect(() =>
      normalizeEditParams({
        patch: "*** Begin Patch\n*** End Patch",
        path: "a.txt",
      }),
    ).toThrow("mutually exclusive");
  });

  it("getEditModeForRender ranks patch > multi > single > none", () => {
    expect(
      getEditModeForRender({ patch: "*** Begin Patch\n*** End Patch" }),
    ).toBe("patch");
    expect(
      getEditModeForRender({ multi: [{ oldText: "a", newText: "b" }] }),
    ).toBe("multi");
    expect(getEditModeForRender({ path: "a.txt" })).toBe("single");
    expect(getEditModeForRender({})).toBe("none");
  });
});

describe("parsePatch", () => {
  it("parses add, update, and delete operations", () => {
    const ops = parsePatch(`*** Begin Patch
*** Add File: new.txt
+line1
+line2
*** Update File: f.ts
@@ before block
-old
+new
*** Delete File: gone.ts
*** End Patch`);

    expect(ops).toEqual<PatchOperation[]>([
      { kind: "add", path: "new.txt", contents: "line1\nline2\n" },
      {
        kind: "update",
        path: "f.ts",
        chunks: [
          {
            changeContext: "before block",
            oldLines: ["old"],
            newLines: ["new"],
            isEndOfFile: false,
          },
        ],
      },
      { kind: "delete", path: "gone.ts" },
    ]);
  });

  it("normalizes CRLF patch text and allows a context-less first hunk", () => {
    const ops = parsePatch(
      "*** Begin Patch\r\n*** Update File: f.ts\r\n-old\r\n+new\r\n*** End Patch",
    );
    expect(ops).toEqual<PatchOperation[]>([
      {
        kind: "update",
        path: "f.ts",
        chunks: [
          {
            changeContext: undefined,
            oldLines: ["old"],
            newLines: ["new"],
            isEndOfFile: false,
          },
        ],
      },
    ]);
  });

  it("rejects malformed patches", () => {
    expect(() => parsePatch("*** Begin Patch\n*** End Patch")).not.toThrow();
    expect(() => parsePatch("garbage")).toThrow("Patch is empty or invalid");
    expect(() => parsePatch("garbage\nmore")).toThrow("'*** Begin Patch'");
    expect(() => parsePatch("*** Begin Patch\nx")).toThrow("'*** End Patch'");
    expect(() =>
      parsePatch("*** Begin Patch\n*** Move to: x\n*** End Patch"),
    ).toThrow("not a valid hunk header");
    expect(() =>
      parsePatch(
        "*** Begin Patch\n*** Update File: f.ts\n*** Move to: x\n*** End Patch",
      ),
    ).toThrow("not supported");
    expect(() =>
      parsePatch(
        "*** Begin Patch\n*** Update File: f.ts\nbad line\n*** End Patch",
      ),
    ).toThrow("Unexpected line found in update hunk");
    expect(() =>
      parsePatch(
        "*** Begin Patch\n*** Update File: f.ts\n-old\nbad line\n*** End Patch",
      ),
    ).toThrow("Expected update hunk to start with @@ context marker");
    expect(() =>
      parsePatch("*** Begin Patch\n*** Add File: f.ts\nno-plus\n*** End Patch"),
    ).toThrow("must start with '+'");
  });
});

describe("seekSequence", () => {
  const lines = ["a", "b", "c"];

  it("matches exactly and falls back through rstrip → trim → fuzzy", () => {
    expect(seekSequence(lines, ["b"], 0, false)).toBe(1);
    expect(seekSequence(lines, ["z"], 0, false)).toBeUndefined();
    expect(seekSequence(lines, [], 0, false)).toBe(0);
    expect(seekSequence(lines, ["b", "c"], 0, false)).toBe(1);
    // pattern longer than the file
    expect(seekSequence(lines, ["a", "b", "c", "d"], 0, false)).toBeUndefined();

    // rstrip fallback: trailing whitespace on the target line
    expect(seekSequence(["a", "b  "], ["b"], 0, false)).toBe(1);
    // trim fallback: surrounding whitespace on both
    expect(seekSequence(["  b  "], ["b"], 0, false)).toBe(0);
    // fuzzy fallback: curly quotes vs straight quotes
    expect(seekSequence(["\u201Cquoted\u201D"], ['"quoted"'], 0, false)).toBe(
      0,
    );
  });

  it("anchors the search at the end of file when eof is set", () => {
    expect(seekSequence(lines, ["b"], 0, true)).toBeUndefined(); // only checks index 2
    expect(seekSequence(["a", "b", "b"], ["b"], 0, true)).toBe(2);
  });
});

describe("deriveUpdatedContent", () => {
  const chunk = (
    oldLines: string[],
    newLines: string[],
    extra?: Partial<UpdateChunk>,
  ): UpdateChunk => ({
    changeContext: undefined,
    oldLines,
    newLines,
    isEndOfFile: false,
    ...extra,
  });

  it("replaces a line and preserves the trailing newline", () => {
    expect(
      deriveUpdatedContent("f.ts", "one\ntwo\n", [chunk(["one"], ["1"])]),
    ).toBe("1\ntwo\n");
  });

  it("advances a forward cursor so duplicate patterns match in file order", () => {
    expect(
      deriveUpdatedContent("f.ts", "a\nb\na\n", [
        chunk(["a"], ["A"]),
        chunk(["a"], ["A2"]),
      ]),
    ).toBe("A\nb\nA2\n");
  });

  it("appends at end of file when oldLines is empty", () => {
    expect(deriveUpdatedContent("f.ts", "a\nb\n", [chunk([], ["c"])])).toBe(
      "a\nb\nc\n",
    );
  });

  it("strips a trailing empty pattern line for hunks touching EOF", () => {
    expect(
      deriveUpdatedContent("f.ts", "a\nb\n", [chunk(["b", ""], ["B", ""])]),
    ).toBe("a\nB\n");
  });

  it("uses the change context to position the cursor", () => {
    expect(
      deriveUpdatedContent("f.ts", "x\ny\nz\n", [
        chunk(["z"], ["Z"], { changeContext: "y" }),
      ]),
    ).toBe("x\ny\nZ\n");
  });

  it("throws when expected lines or context cannot be found", () => {
    expect(() =>
      deriveUpdatedContent("f.ts", "a\nb\n", [chunk(["missing"], ["x"])]),
    ).toThrow("Failed to find expected lines in f.ts");
    expect(() =>
      deriveUpdatedContent("f.ts", "a\nb\n", [
        chunk(["b"], ["B"], { changeContext: "no-such-context" }),
      ]),
    ).toThrow("Failed to find context 'no-such-context' in f.ts");
  });
});

describe("generateDiffString", () => {
  it("renders a small replacement with line numbers", () => {
    expect(generateDiffString("a\nb\nc\n", "a\nX\nc\n")).toEqual({
      diff: " 1 a\n-2 b\n+2 X\n 3 c",
      firstChangedLine: 2,
    });
  });

  it("collapses the middle of long unchanged blocks", () => {
    const oldContent = "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n";
    const newContent = "1\n2\n3\n4\n5\nSIX\n7\n8\n9\n10\n11\n12\n";

    expect(generateDiffString(oldContent, newContent)).toEqual({
      diff:
        "    ...\n" +
        "  2 2\n" +
        "  3 3\n" +
        "  4 4\n" +
        "  5 5\n" +
        "- 6 6\n" +
        "+ 6 SIX\n" +
        "  7 7\n" +
        "  8 8\n" +
        "  9 9\n" +
        " 10 10\n" +
        "    ...",
      firstChangedLine: 6,
    });
  });

  it("is empty when content is unchanged", () => {
    expect(generateDiffString("same\n", "same\n")).toEqual({
      diff: "",
      firstChangedLine: undefined,
    });
  });
});

describe("formatResults", () => {
  it("summarizes mixed success/failure with remaining count", () => {
    expect(
      formatResults(
        [
          { path: "a.ts", success: true, message: "Edited a.ts." },
          { path: "b.ts", success: false, message: "Could not find text." },
        ],
        3,
      ),
    ).toBe(
      "✓ Edit 1/3 (a.ts): Edited a.ts.\n" +
        "✗ Edit 2/3 (b.ts): Could not find text.\n" +
        "⊘ 1 remaining edit(s) skipped due to error.",
    );
  });

  it("marks preflight-passing edits as not applied in preflight mode", () => {
    // Preflight failures abort the batch before any file is written. Edits
    // that passed the preflight simulation must not be reported with the
    // same "✓ ... Edited" wording as real writes — that phrasing made the
    // model believe edits were applied and then silently reverted.
    expect(
      formatResults(
        [
          { path: "a.ts", success: true, message: "Edited a.ts." },
          { path: "b.ts", success: false, message: "Could not find text." },
        ],
        2,
        "preflight",
      ),
    ).toBe(
      "⊘ Edit 1/2 (a.ts): preflight OK — not applied (batch aborted).\n" +
        "✗ Edit 2/2 (b.ts): Could not find text.",
    );
  });
});
