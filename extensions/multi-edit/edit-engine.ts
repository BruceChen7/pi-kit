/**
 * Pure edit engine for the multi-edit extension: parameter classification,
 * patch parsing, content derivation, fuzzy line matching, and diff rendering.
 *
 * All functions here are value-in / value-out — no IO, no platform imports.
 * The imperative shell (`index.ts`) performs filesystem access and
 * concurrency control, and funnels raw tool parameters through
 * `normalizeEditParams` so execute and renderCall cannot drift apart.
 */

import { isAbsolute, resolve as resolvePath } from "node:path";
import * as Diff from "diff";

export interface EditItem {
  path: string;
  oldText: string;
  newText: string;
}

export type MultiEditItem = {
  path?: string;
  oldText: string;
  newText: string;
};

export type ClassicEditInput = {
  path?: string;
  oldText?: string;
  newText?: string;
  multi?: MultiEditItem[];
};

export type RenderableEditArgs = ClassicEditInput & {
  patch?: string;
};

export type EditPlan =
  | { mode: "patch"; patch: string }
  | {
      mode: "classic";
      path?: string;
      oldText?: string;
      newText?: string;
      multi?: MultiEditItem[];
    };

export interface EditResult {
  path: string;
  success: boolean;
  message: string;
  diff?: string;
  firstChangedLine?: number;
}

export interface UpdateChunk {
  changeContext?: string;
  oldLines: string[];
  newLines: string[];
  isEndOfFile: boolean;
}

export type PatchOperation =
  | { kind: "add"; path: string; contents: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; chunks: UpdateChunk[] };

export interface PatchOpResult {
  path: string;
  message: string;
  diff?: string;
  firstChangedLine?: number;
}

// ---- edit mode classification (pure) -------------------------------------
//
// Some model providers serialize omitted optional fields as empty strings or
// an empty array. These placeholders are treated as absent, while an empty
// `newText` is preserved for a valid single-edit deletion. All interpretation
// of the raw tool parameters lives here so execute and renderCall cannot
// drift apart.

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const nonEmptyArray = (value: unknown): value is unknown[] =>
  Array.isArray(value) && value.length > 0;

export function normalizeEditParams(
  raw: ClassicEditInput & { patch?: string },
): EditPlan {
  const patch = nonEmptyString(raw.patch) ? raw.patch : undefined;
  const multi = nonEmptyArray(raw.multi) ? raw.multi : undefined;
  const hasNonEmptyClassicParam = [raw.path, raw.oldText, raw.newText].some(
    nonEmptyString,
  );

  if (patch !== undefined) {
    if (multi !== undefined || hasNonEmptyClassicParam) {
      throw new Error(
        "The `patch` parameter is mutually exclusive with path/oldText/newText/multi.",
      );
    }
    return { mode: "patch", patch };
  }

  return {
    mode: "classic",
    path: nonEmptyString(raw.path) ? raw.path : undefined,
    oldText:
      multi !== undefined && raw.oldText === "" ? undefined : raw.oldText,
    newText:
      multi !== undefined && raw.newText === "" ? undefined : raw.newText,
    multi,
  };
}

export function getEditModeForRender(
  args: RenderableEditArgs,
): "patch" | "multi" | "single" | "none" {
  if (nonEmptyString(args.patch)) return "patch";
  if (nonEmptyArray(args.multi)) return "multi";
  if (nonEmptyString(args.path)) return "single";
  return "none";
}

export function formatResults(
  results: EditResult[],
  totalEdits: number,
): string {
  const lines: string[] = [];

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const status = r.success ? "✓" : "✗";
    lines.push(
      `${status} Edit ${i + 1}/${totalEdits} (${r.path}): ${r.message}`,
    );
  }

  const remaining = totalEdits - results.length;
  if (remaining > 0) {
    lines.push(`⊘ ${remaining} remaining edit(s) skipped due to error.`);
  }

  return lines.join("\n");
}

export function generateDiffString(
  oldContent: string,
  newContent: string,
  contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
  const parts = Diff.diffLines(oldContent, newContent);
  const output: string[] = [];

  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const maxLineNum = Math.max(oldLines.length, newLines.length);
  const lineNumWidth = String(maxLineNum).length;

  let oldLineNum = 1;
  let newLineNum = 1;
  let lastWasChange = false;
  let firstChangedLine: number | undefined;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const raw = part.value.split("\n");
    if (raw[raw.length - 1] === "") {
      raw.pop();
    }

    if (part.added || part.removed) {
      if (firstChangedLine === undefined) {
        firstChangedLine = newLineNum;
      }

      for (const line of raw) {
        if (part.added) {
          const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
          output.push(`+${lineNum} ${line}`);
          newLineNum++;
        } else {
          const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
          output.push(`-${lineNum} ${line}`);
          oldLineNum++;
        }
      }
      lastWasChange = true;
    } else {
      const nextPartIsChange =
        i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);

      if (lastWasChange || nextPartIsChange) {
        // Determine how many lines to show at the start and end of this
        // unchanged block.  When the block sits between two changes we
        // show context on both sides but collapse the middle.
        const showAtStart = lastWasChange ? contextLines : 0;
        const showAtEnd = nextPartIsChange ? contextLines : 0;

        if (raw.length <= showAtStart + showAtEnd) {
          // Block is small enough — show it entirely.
          for (const line of raw) {
            const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
            output.push(` ${lineNum} ${line}`);
            oldLineNum++;
            newLineNum++;
          }
        } else {
          // Show head context.
          for (let j = 0; j < showAtStart; j++) {
            const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
            output.push(` ${lineNum} ${raw[j]}`);
            oldLineNum++;
            newLineNum++;
          }

          // Collapse the middle.
          const skipped = raw.length - showAtStart - showAtEnd;
          if (skipped > 0) {
            output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
            oldLineNum += skipped;
            newLineNum += skipped;
          }

          // Show tail context.
          for (let j = raw.length - showAtEnd; j < raw.length; j++) {
            const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
            output.push(` ${lineNum} ${raw[j]}`);
            oldLineNum++;
            newLineNum++;
          }
        }
      } else {
        oldLineNum += raw.length;
        newLineNum += raw.length;
      }

      lastWasChange = false;
    }
  }

  return { diff: output.join("\n"), firstChangedLine };
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function resolvePatchPath(cwd: string, filePath: string): string {
  const trimmed = filePath.trim();
  if (!trimmed) {
    throw new Error("Patch path cannot be empty");
  }
  return isAbsolute(trimmed) ? resolvePath(trimmed) : resolvePath(cwd, trimmed);
}

export function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

export function normaliseLineForFuzzyMatch(s: string): string {
  return s
    .trim()
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

export function seekSequence(
  lines: string[],
  pattern: string[],
  start: number,
  eof: boolean,
): number | undefined {
  if (pattern.length === 0) return start;
  if (pattern.length > lines.length) return undefined;

  const searchStart =
    eof && lines.length >= pattern.length
      ? lines.length - pattern.length
      : start;
  const searchEnd = lines.length - pattern.length;

  const exactEqual = (a: string, b: string) => a === b;
  const rstripEqual = (a: string, b: string) => a.trimEnd() === b.trimEnd();
  const trimEqual = (a: string, b: string) => a.trim() === b.trim();
  const fuzzyEqual = (a: string, b: string) =>
    normaliseLineForFuzzyMatch(a) === normaliseLineForFuzzyMatch(b);

  const passes = [exactEqual, rstripEqual, trimEqual, fuzzyEqual];

  for (const eq of passes) {
    for (let i = searchStart; i <= searchEnd; i++) {
      let ok = true;
      for (let p = 0; p < pattern.length; p++) {
        if (!eq(lines[i + p], pattern[p])) {
          ok = false;
          break;
        }
      }
      if (ok) return i;
    }
  }

  return undefined;
}

export function applyReplacements(
  lines: string[],
  replacements: Array<[number, number, string[]]>,
): string[] {
  const next = [...lines];

  for (const [start, oldLen, newSegment] of [...replacements].sort(
    (a, b) => b[0] - a[0],
  )) {
    next.splice(start, oldLen, ...newSegment);
  }

  return next;
}

export function deriveUpdatedContent(
  filePath: string,
  currentContent: string,
  chunks: UpdateChunk[],
): string {
  const originalLines = currentContent.split("\n");
  if (originalLines[originalLines.length - 1] === "") {
    originalLines.pop();
  }

  const replacements: Array<[number, number, string[]]> = [];
  let lineIndex = 0;

  for (const chunk of chunks) {
    if (chunk.changeContext !== undefined) {
      const ctxIndex = seekSequence(
        originalLines,
        [chunk.changeContext],
        lineIndex,
        false,
      );
      if (ctxIndex === undefined) {
        throw new Error(
          `Failed to find context '${chunk.changeContext}' in ${filePath}`,
        );
      }
      lineIndex = ctxIndex + 1;
    }

    if (chunk.oldLines.length === 0) {
      replacements.push([originalLines.length, 0, [...chunk.newLines]]);
      continue;
    }

    let pattern = chunk.oldLines;
    let newSlice = chunk.newLines;

    let found = seekSequence(
      originalLines,
      pattern,
      lineIndex,
      chunk.isEndOfFile,
    );
    if (found === undefined && pattern[pattern.length - 1] === "") {
      pattern = pattern.slice(0, -1);
      if (newSlice[newSlice.length - 1] === "") {
        newSlice = newSlice.slice(0, -1);
      }
      found = seekSequence(
        originalLines,
        pattern,
        lineIndex,
        chunk.isEndOfFile,
      );
    }

    if (found === undefined) {
      throw new Error(
        `Failed to find expected lines in ${filePath}:\n${chunk.oldLines.join("\n")}`,
      );
    }

    replacements.push([found, pattern.length, [...newSlice]]);
    lineIndex = found + pattern.length;
  }

  const newLines = applyReplacements(originalLines, replacements);
  if (newLines[newLines.length - 1] !== "") {
    newLines.push("");
  }
  return newLines.join("\n");
}

export function parseUpdateChunk(
  lines: string[],
  startIndex: number,
  lastContentLine: number,
  allowMissingContext: boolean,
): { chunk: UpdateChunk; nextIndex: number } {
  let i = startIndex;
  let changeContext: string | undefined;
  const first = lines[i].trimEnd();

  if (first === "@@") {
    i++;
  } else if (first.startsWith("@@ ")) {
    changeContext = first.slice(3);
    i++;
  } else if (!allowMissingContext) {
    throw new Error(
      `Expected update hunk to start with @@ context marker, got: '${lines[i]}'`,
    );
  }

  const oldLines: string[] = [];
  const newLines: string[] = [];
  let parsed = 0;
  let isEndOfFile = false;

  while (i <= lastContentLine) {
    const raw = lines[i];
    const trimmed = raw.trimEnd();

    if (trimmed === "*** End of File") {
      if (parsed === 0) {
        throw new Error("Update hunk does not contain any lines");
      }
      isEndOfFile = true;
      i++;
      break;
    }

    if (
      parsed > 0 &&
      (trimmed.startsWith("@@") || trimmed.startsWith("*** "))
    ) {
      break;
    }

    if (raw.length === 0) {
      oldLines.push("");
      newLines.push("");
      parsed++;
      i++;
      continue;
    }

    const marker = raw[0];
    const body = raw.slice(1);
    if (marker === " ") {
      oldLines.push(body);
      newLines.push(body);
    } else if (marker === "-") {
      oldLines.push(body);
    } else if (marker === "+") {
      newLines.push(body);
    } else if (parsed === 0) {
      throw new Error(
        `Unexpected line found in update hunk: '${raw}'. Every line should start with ' ', '+', or '-'.`,
      );
    } else {
      break;
    }

    parsed++;
    i++;
  }

  if (parsed === 0) {
    throw new Error("Update hunk does not contain any lines");
  }

  return {
    chunk: { changeContext, oldLines, newLines, isEndOfFile },
    nextIndex: i,
  };
}

export function parsePatch(patchText: string): PatchOperation[] {
  const lines = normalizeToLF(patchText).trim().split("\n");
  if (lines.length < 2) {
    throw new Error("Patch is empty or invalid");
  }
  if (lines[0].trim() !== "*** Begin Patch") {
    throw new Error("The first line of the patch must be '*** Begin Patch'");
  }
  if (lines[lines.length - 1].trim() !== "*** End Patch") {
    throw new Error("The last line of the patch must be '*** End Patch'");
  }

  const operations: PatchOperation[] = [];
  let i = 1;
  const lastContentLine = lines.length - 2;

  while (i <= lastContentLine) {
    if (lines[i].trim() === "") {
      i++;
      continue;
    }

    const line = lines[i].trim();
    if (line.startsWith("*** Add File: ")) {
      const path = line.slice("*** Add File: ".length);
      i++;
      const contentLines: string[] = [];
      while (i <= lastContentLine) {
        const next = lines[i];
        if (next.trim().startsWith("*** ")) break;
        if (!next.startsWith("+")) {
          throw new Error(
            `Invalid add-file line '${next}'. Add file lines must start with '+'`,
          );
        }
        contentLines.push(next.slice(1));
        i++;
      }
      operations.push({
        kind: "add",
        path,
        contents: contentLines.length > 0 ? `${contentLines.join("\n")}\n` : "",
      });
      continue;
    }

    if (line.startsWith("*** Delete File: ")) {
      const path = line.slice("*** Delete File: ".length);
      operations.push({ kind: "delete", path });
      i++;
      continue;
    }

    if (line.startsWith("*** Update File: ")) {
      const path = line.slice("*** Update File: ".length);
      i++;

      if (i <= lastContentLine && lines[i].trim().startsWith("*** Move to: ")) {
        throw new Error(
          "Patch move operations (*** Move to:) are not supported.",
        );
      }

      const chunks: UpdateChunk[] = [];
      while (i <= lastContentLine) {
        if (lines[i].trim() === "") {
          i++;
          continue;
        }
        if (lines[i].trim().startsWith("*** ")) {
          break;
        }

        const parsed = parseUpdateChunk(
          lines,
          i,
          lastContentLine,
          chunks.length === 0,
        );
        chunks.push(parsed.chunk);
        i = parsed.nextIndex;
      }

      if (chunks.length === 0) {
        throw new Error(`Update file hunk for path '${path}' is empty`);
      }

      operations.push({ kind: "update", path, chunks });
      continue;
    }

    throw new Error(
      `'${line}' is not a valid hunk header. Valid headers: '*** Add File:', '*** Delete File:', '*** Update File:'`,
    );
  }

  return operations;
}
