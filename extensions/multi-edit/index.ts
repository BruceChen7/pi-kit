/**
 * Multi-Edit Extension — replaces the built-in `edit` tool.
 *
 * Supports all original parameters (path, oldText, newText) plus:
 * - `multi`: array of {path, oldText, newText} edits applied in sequence
 * - `patch`: Codex-style apply_patch payload
 *
 * When both top-level params and `multi` are provided, the top-level edit
 * is treated as an implicit first item prepended to the multi list.
 *
 * A preflight pass is performed before mutating files:
 * - multi/top-level mode: preflight via virtualized built-in edit tool
 * - patch mode: preflight by applying patch operations on a virtual filesystem
 *
 * Concurrency: pi executes sibling tool calls from one assistant message in
 * parallel, so same-file mutations are serialized through the platform's
 * per-file mutation queue (`withFileMutationQueue`), shared with the built-in
 * edit/write tools. This guarantees concurrent same-file edits all land —
 * each read-modify-write sees the previous write. Edits that DEPEND on each
 * other (one's oldText is produced by another's newText) are not guaranteed
 * to land across separate parallel calls: express dependent edits as one
 * `multi` call instead.
 *
 * The pure engine (parameter classification, patch parsing, content
 * derivation, diff rendering) lives in `edit-engine.ts` and is tested
 * directly; this file is the imperative shell (IO + concurrency).
 */

import { constants } from "node:fs";
import {
  access as fsAccess,
  readFile as fsReadFile,
  unlink as fsUnlink,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { isAbsolute, resolve as resolvePath } from "node:path";
import {
  type ExtensionAPI,
  type Theme,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import {
  type ClassicEditInput,
  deriveUpdatedContent,
  type EditItem,
  type EditResult,
  ensureTrailingNewline,
  formatResults,
  generateDiffString,
  getEditModeForRender,
  normalizeEditParams,
  type PatchOperation,
  type PatchOpResult,
  parsePatch,
  type RenderableEditArgs,
  resolvePatchPath,
} from "./edit-engine.ts";

const editItemSchema = Type.Object({
  path: Type.Optional(
    Type.String({
      description:
        "Path to the file to edit (relative or absolute). Inherits from top-level path if omitted.",
    }),
  ),
  oldText: Type.String({
    description: "Exact text to find and replace (must match exactly)",
  }),
  newText: Type.String({
    description: "New text to replace the old text with",
  }),
});

const multiEditSchema = Type.Object({
  path: Type.Optional(
    Type.String({
      description: "Path to the file to edit (relative or absolute)",
    }),
  ),
  oldText: Type.Optional(
    Type.String({
      description: "Exact text to find and replace (must match exactly)",
    }),
  ),
  newText: Type.Optional(
    Type.String({ description: "New text to replace the old text with" }),
  ),
  multi: Type.Optional(
    Type.Array(editItemSchema, {
      description:
        "Multiple edits to apply in sequence. Each item has path, oldText, and newText.",
    }),
  ),
  patch: Type.Optional(
    Type.String({
      description:
        "Codex-style apply_patch payload (*** Begin Patch ... *** End Patch). Mutually exclusive with path/oldText/newText/multi.",
    }),
  ),
});

interface Workspace {
  readText: (absolutePath: string) => Promise<string>;
  writeText: (absolutePath: string, content: string) => Promise<void>;
  deleteFile: (absolutePath: string) => Promise<void>;
  exists: (absolutePath: string) => Promise<boolean>;
  /** Check that the file is writable. Rejects if not. No-op on virtual workspaces. */
  checkWriteAccess: (absolutePath: string) => Promise<void>;
}

function createRealWorkspace(): Workspace {
  return {
    readText: (absolutePath: string) => fsReadFile(absolutePath, "utf-8"),
    writeText: (absolutePath: string, content: string) =>
      fsWriteFile(absolutePath, content, "utf-8"),
    deleteFile: (absolutePath: string) => fsUnlink(absolutePath),
    exists: async (absolutePath: string) => {
      try {
        await fsAccess(absolutePath, constants.F_OK);
        return true;
      } catch {
        return false;
      }
    },
    checkWriteAccess: (absolutePath: string) =>
      fsAccess(absolutePath, constants.R_OK | constants.W_OK),
  };
}

function createVirtualWorkspace(cwd: string): Workspace {
  const state = new Map<string, string | null>();

  async function ensureLoaded(absolutePath: string): Promise<void> {
    if (state.has(absolutePath)) return;
    try {
      const content = await fsReadFile(absolutePath, "utf-8");
      state.set(absolutePath, content);
    } catch {
      state.set(absolutePath, null);
    }
  }

  return {
    readText: async (absolutePath) => {
      await ensureLoaded(absolutePath);
      const content = state.get(absolutePath);
      if (content === null || content === undefined) {
        throw new Error(
          `File not found: ${absolutePath.replace(`${cwd}/`, "")}`,
        );
      }
      return content;
    },
    writeText: async (absolutePath, content) => {
      state.set(absolutePath, content);
    },
    deleteFile: async (absolutePath) => {
      await ensureLoaded(absolutePath);
      if (state.get(absolutePath) === null) {
        throw new Error(
          `File not found: ${absolutePath.replace(`${cwd}/`, "")}`,
        );
      }
      state.set(absolutePath, null);
    },
    exists: async (absolutePath) => {
      await ensureLoaded(absolutePath);
      return state.get(absolutePath) !== null;
    },
    checkWriteAccess: async () => {
      // No-op for virtual workspace — permission checks happen on the real pass.
    },
  };
}

async function applyPatchOperations(
  ops: PatchOperation[],
  workspace: Workspace,
  cwd: string,
  signal?: AbortSignal,
  options?: { collectDiff?: boolean },
): Promise<PatchOpResult[]> {
  const results: PatchOpResult[] = [];
  const collectDiff = options?.collectDiff ?? false;

  // Pi runs sibling tool calls from one assistant message in parallel; the
  // per-file mutation queue (shared with built-in edit/write) serializes
  // read-modify-write windows so concurrent same-file operations do not read
  // stale content and clobber each other.
  for (const op of ops) {
    if (signal?.aborted) {
      throw new Error("Operation aborted");
    }

    if (op.kind === "add") {
      const abs = resolvePatchPath(cwd, op.path);
      await withFileMutationQueue(abs, async () => {
        let oldText = "";
        if (collectDiff && (await workspace.exists(abs))) {
          oldText = await workspace.readText(abs);
        }
        const newText = ensureTrailingNewline(op.contents);
        await workspace.writeText(abs, newText);
        const result: PatchOpResult = {
          path: op.path,
          message: `Added file ${op.path}.`,
        };
        if (collectDiff) {
          const diffResult = generateDiffString(oldText, newText);
          result.diff = diffResult.diff;
          result.firstChangedLine = diffResult.firstChangedLine;
        }
        results.push(result);
      });
      continue;
    }

    if (op.kind === "delete") {
      const abs = resolvePatchPath(cwd, op.path);
      await withFileMutationQueue(abs, async () => {
        const exists = await workspace.exists(abs);
        if (!exists) {
          throw new Error(`Failed to delete ${op.path}: file does not exist`);
        }
        let oldText = "";
        if (collectDiff) {
          oldText = await workspace.readText(abs);
        }
        await workspace.deleteFile(abs);
        const result: PatchOpResult = {
          path: op.path,
          message: `Deleted file ${op.path}.`,
        };
        if (collectDiff) {
          const diffResult = generateDiffString(oldText, "");
          result.diff = diffResult.diff;
          result.firstChangedLine = diffResult.firstChangedLine;
        }
        results.push(result);
      });
      continue;
    }

    const sourceAbs = resolvePatchPath(cwd, op.path);
    await withFileMutationQueue(sourceAbs, async () => {
      const sourceText = await workspace.readText(sourceAbs);
      const updated = deriveUpdatedContent(op.path, sourceText, op.chunks);

      await workspace.writeText(sourceAbs, updated);
      const result: PatchOpResult = {
        path: op.path,
        message: `Updated ${op.path}.`,
      };
      if (collectDiff) {
        const diffResult = generateDiffString(sourceText, updated);
        result.diff = diffResult.diff;
        result.firstChangedLine = diffResult.firstChangedLine;
      }
      results.push(result);
    });
  }

  return results;
}

/**
 * Apply a list of classic edits (path/oldText/newText) sequentially via a Workspace.
 *
 * When multiple edits target the same file, they are sorted by their position in
 * the original file content (top-to-bottom) before applying.  This makes the
 * operation robust regardless of the order the model listed the edits.
 *
 * A forward cursor (`searchOffset`) advances after each replacement so that
 * duplicate oldText snippets are disambiguated by position.
 */
async function applyClassicEdits(
  edits: EditItem[],
  workspace: Workspace,
  cwd: string,
  signal?: AbortSignal,
  options?: {
    collectDiff?: boolean;
    formatMode?: "preflight" | "apply";
  },
): Promise<EditResult[]> {
  const collectDiff = options?.collectDiff ?? false;
  const formatMode = options?.formatMode ?? "apply";

  // Group edits by resolved absolute path, preserving order.
  const fileGroups = new Map<string, { index: number; edit: EditItem }[]>();
  const editOrder: string[] = []; // track insertion order of keys

  for (let i = 0; i < edits.length; i++) {
    const abs = isAbsolute(edits[i].path)
      ? resolvePath(edits[i].path)
      : resolvePath(cwd, edits[i].path);
    let group = fileGroups.get(abs);
    if (!group) {
      group = [];
      fileGroups.set(abs, group);
      editOrder.push(abs);
    }
    group.push({ index: i, edit: edits[i] });
  }

  const results: EditResult[] = new Array(edits.length);

  // Verify write access to all target files before mutating anything.
  for (const absPath of editOrder) {
    await workspace.checkWriteAccess(absPath);
  }

  for (const absPath of editOrder) {
    const group = fileGroups.get(absPath);
    if (!group) continue;

    // Fast-fail on abort before waiting on the queue (the check inside the
    // queued section only runs once the lock is acquired).
    if (signal?.aborted) {
      throw new Error("Operation aborted");
    }

    // Pi runs sibling tool calls from one assistant message in parallel; the
    // per-file mutation queue (shared with built-in edit/write) serializes
    // read-modify-write windows so concurrent same-file operations do not read
    // stale content and clobber each other.
    await withFileMutationQueue(absPath, async () => {
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      const originalContent = await workspace.readText(absPath);

      // Sort same-file edits by their position in the original content so
      // that the forward cursor always works, regardless of the order the
      // model listed them.  Edits whose oldText is not found sort to the
      // end and will produce an error during the apply loop below.
      if (group.length > 1) {
        const positions = new Map<{ index: number; edit: EditItem }, number>();
        for (const entry of group) {
          const pos = originalContent.indexOf(entry.edit.oldText);
          positions.set(entry, pos === -1 ? Number.MAX_SAFE_INTEGER : pos);
        }
        group.sort(
          (a, b) =>
            (positions.get(a) ?? Number.MAX_SAFE_INTEGER) -
            (positions.get(b) ?? Number.MAX_SAFE_INTEGER),
        );
      }

      let content = originalContent;
      let searchOffset = 0;

      // Track successfully applied oldText→newText pairs in this file so we
      // can detect redundant duplicate edits (model listed more replacements
      // than actual occurrences).
      const appliedPairs = new Set<string>();

      for (const { index, edit } of group) {
        if (signal?.aborted) {
          throw new Error("Operation aborted");
        }

        // Find oldText starting from the cursor position (positional ordering).
        const pos = content.indexOf(edit.oldText, searchOffset);

        if (pos === -1) {
          // If the exact same oldText→newText pair was already applied in
          // this file, the model likely just over-counted occurrences.
          // Skip gracefully instead of aborting the entire batch.
          const pairKey = `${edit.oldText}\0${edit.newText}`;
          if (appliedPairs.has(pairKey)) {
            results[index] = {
              path: edit.path,
              success: true,
              message: `Skipped redundant edit in ${edit.path} (already replaced all occurrences).`,
            };
            continue;
          }

          results[index] = {
            path: edit.path,
            success: false,
            message: `Could not find the exact text in ${edit.path}. The old text must match exactly including all whitespace and newlines.`,
          };
          // Fill remaining edits in this group as skipped.
          const filled = Array.from(
            { length: edits.length },
            (_, i) => results[i],
          ).filter(Boolean);
          throw new Error(formatResults(filled, edits.length, formatMode));
        }

        content =
          content.slice(0, pos) +
          edit.newText +
          content.slice(pos + edit.oldText.length);
        searchOffset = pos + edit.newText.length;
        appliedPairs.add(`${edit.oldText}\0${edit.newText}`);

        results[index] = {
          path: edit.path,
          success: true,
          message: `Edited ${edit.path}.`,
        };
      }

      // Write back the fully-edited file.
      await workspace.writeText(absPath, content);

      // Generate a single diff for all edits to this file; attach to first edit.
      if (collectDiff) {
        const diffResult = generateDiffString(originalContent, content);
        const firstIdx = group[0].index;
        results[firstIdx].diff = diffResult.diff;
        results[firstIdx].firstChangedLine = diffResult.firstChangedLine;
      }
    });
  }

  return results;
}

function buildClassicEdits({
  path,
  oldText,
  newText,
  multi,
}: ClassicEditInput): EditItem[] {
  const edits: EditItem[] = [];

  if (path !== undefined && oldText !== undefined && newText !== undefined) {
    edits.push({ path, oldText, newText });
  } else if (
    path !== undefined ||
    oldText !== undefined ||
    newText !== undefined
  ) {
    // When multi is present, only a bare top-level `path` (for inheritance) is allowed.
    // Any other partial combination (e.g. path+oldText, oldText+newText) is an error.
    const hasOnlyPath =
      path !== undefined && oldText === undefined && newText === undefined;
    if (!hasOnlyPath || multi === undefined) {
      const missing: string[] = [];
      if (path === undefined) missing.push("path");
      if (oldText === undefined) missing.push("oldText");
      if (newText === undefined) missing.push("newText");
      throw new Error(
        `Incomplete top-level edit: missing ${missing.join(", ")}. Provide all three (path, oldText, newText) or use only the multi parameter.`,
      );
    }
    // path-only top-level with multi is fine — path is inherited below.
  }

  if (multi) {
    for (const item of multi) {
      edits.push({
        path: item.path ?? path ?? "",
        oldText: item.oldText,
        newText: item.newText,
      });
    }
  }

  if (edits.length === 0) {
    throw new Error(
      "No edits provided. Supply path/oldText/newText, a multi array, or a patch.",
    );
  }

  for (let i = 0; i < edits.length; i++) {
    if (!edits[i].path) {
      throw new Error(
        `Edit ${i + 1} is missing a path. Provide a path on each multi item or set a top-level path to inherit.`,
      );
    }
  }

  return edits;
}

function formatPatchResult(applied: PatchOpResult[]) {
  const summary = applied.map((r, i) => `${i + 1}. ${r.message}`).join("\n");
  const combinedDiff = applied
    .filter((r) => r.diff)
    .map((r) => `File: ${r.path}\n${r.diff}`)
    .join("\n\n");
  const firstChangedLine = applied.find(
    (r) => r.firstChangedLine !== undefined,
  )?.firstChangedLine;

  return {
    content: [
      {
        type: "text" as const,
        text: `Applied patch with ${applied.length} operation(s).\n${summary}`,
      },
    ],
    details: {
      diff: combinedDiff,
      firstChangedLine,
    },
  };
}

function getRenderableClassicEditPaths({
  path,
  oldText,
  newText,
  multi,
}: ClassicEditInput): string[] {
  const paths: string[] = [];
  const inheritedPath = typeof path === "string" ? path : "";

  if (inheritedPath && oldText !== undefined && newText !== undefined) {
    paths.push(inheritedPath);
  }

  for (const item of multi ?? []) {
    paths.push(item.path ?? inheritedPath);
  }

  return paths.filter(Boolean);
}

function formatEditCall(args: RenderableEditArgs, theme: Theme): string {
  let text = theme.fg("toolTitle", theme.bold("edit "));
  text += theme.fg("muted", "⚡ multi-edit ");

  const mode = getEditModeForRender(args);
  if (mode === "patch") {
    return text + theme.fg("muted", "patch");
  }

  const paths = getRenderableClassicEditPaths(args);
  if (mode === "multi" || paths.length > 1) {
    const fileCount = new Set(paths).size;
    return (
      text +
      theme.fg("muted", `multi ${paths.length} edits / ${fileCount} files`)
    );
  }

  const targetPath =
    paths[0] ?? (typeof args.path === "string" ? args.path : "...");
  return text + theme.fg("muted", `single ${targetPath}`);
}

function formatClassicResult(results: EditResult[]) {
  if (results.length === 1) {
    const r = results[0];
    return {
      content: [{ type: "text" as const, text: r.message }],
      details: {
        diff: r.diff ?? "",
        firstChangedLine: r.firstChangedLine,
      },
    };
  }

  const combinedDiff = results
    .filter((r) => r.diff)
    .map((r) => r.diff)
    .join("\n");
  const firstChangedLine = results.find(
    (r) => r.firstChangedLine !== undefined,
  )?.firstChangedLine;
  const summary = results.map((r, i) => `${i + 1}. ${r.message}`).join("\n");

  return {
    content: [
      {
        type: "text" as const,
        text: `Applied ${results.length} edit(s) successfully.\n${summary}`,
      },
    ],
    details: {
      diff: combinedDiff,
      firstChangedLine,
    },
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "edit",
    label: "edit",
    description:
      "Edit a file by replacing exact text. The oldText must match exactly (including whitespace). Use this for precise, surgical edits. Supports a `multi` parameter for batch edits across one or more files, and a `patch` parameter for Codex-style patches.",
    promptSnippet:
      "Edit a file by replacing exact text. The oldText must match exactly (including whitespace). Use this for precise, surgical edits.",
    promptGuidelines: [
      "Use edit for precise changes (old text must match exactly)",
      "Use the `multi` parameter to apply multiple edits in a single tool call",
      "Use the `patch` parameter for Codex-style multi-file / hunk-based edits",
    ],
    parameters: multiEditSchema,

    renderCall(args, theme) {
      return new Text(formatEditCall(args, theme), 0, 0);
    },

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const plan = normalizeEditParams(params);

      if (plan.mode === "patch") {
        const ops = parsePatch(plan.patch);

        // Preflight on virtual filesystem before mutating real files.
        try {
          await applyPatchOperations(
            ops,
            createVirtualWorkspace(ctx.cwd),
            ctx.cwd,
            signal,
            { collectDiff: false },
          );
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(
            `Preflight failed before mutating files.\n${message}`,
          );
        }

        // Apply for real.
        const applied = await applyPatchOperations(
          ops,
          createRealWorkspace(),
          ctx.cwd,
          signal,
          { collectDiff: true },
        );
        return formatPatchResult(applied);
      }

      const edits = buildClassicEdits(plan);

      // Preflight pass on virtual workspace before mutating real files.
      // Uses sequential occurrence matching so same-file edits are resolved
      // in file order (positional ordering). Failures report preflight-mode
      // results: passing edits are marked "not applied", never "Edited".
      try {
        await applyClassicEdits(
          edits,
          createVirtualWorkspace(ctx.cwd),
          ctx.cwd,
          signal,
          { collectDiff: false, formatMode: "preflight" },
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Preflight failed before mutating files.\n${message}`);
      }

      // Apply for real.
      const results = await applyClassicEdits(
        edits,
        createRealWorkspace(),
        ctx.cwd,
        signal,
        { collectDiff: true },
      );

      return formatClassicResult(results);
    },
  });
}
