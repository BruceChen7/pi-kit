/**
 * Tool registration: `create_calldiff_artifact`.
 *
 * Thin wrapper: builds a single-node `calldiff-callflow` spec and funnels it
 * through the shared materialization pipeline (resolve → validate → write →
 * open window) that `create_visual_artifact` uses, so the standalone
 * "just show me the call flow" path stays available with exactly one
 * implementation. A failed calldiff run surfaces as an error result (never a
 * useless empty artifact), while embedded nodes inside larger artifacts
 * degrade to a callout instead.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createLogger } from "../shared/logger.ts";
import { materializeArtifact } from "./artifact-pipeline.ts";
import type { VisualArtifactSpec } from "./artifact-schema.ts";
import {
  toEntries,
  toOptionalString,
  toStringArray,
} from "./resolve-calldiff-node.ts";
import { errorResult, normalizeSlug, result } from "./tool-helpers.ts";

const log = createLogger("visual-artifact");

const CalldiffToolParams = Type.Object({
  mode: Type.Optional(
    Type.Union(
      [Type.Literal("diff"), Type.Literal("tree"), Type.Literal("reach")],
      {
        description:
          "diff: call-stack changes between two refs (default). tree: one call tree (requires entry). reach: call paths between two symbols (requires entry + target).",
      },
    ),
  ),
  from: Type.Optional(
    Type.String({
      description:
        "diff: before-ref (default HEAD). tree/reach: the tree ref (default worktree).",
    }),
  ),
  to: Type.Optional(
    Type.String({
      description: "diff: after-ref (default worktree). Unused by tree/reach.",
    }),
  ),
  entry: Type.Optional(
    Type.Union([Type.String(), Type.Array(Type.String())], {
      description:
        "Entrypoint(s): functionName or ClassName.method. Required for tree/reach.",
    }),
  ),
  target: Type.Optional(
    Type.String({
      description:
        "reach: target symbol to reach (functionName or ClassName.method).",
    }),
  ),
  paths: Type.Optional(
    Type.Array(Type.String(), {
      description: "Limit analysis to these path prefixes.",
    }),
  ),
  maxDepth: Type.Optional(
    Type.Number({
      description: "Max call-tree depth (default 12).",
    }),
  ),
  title: Type.Optional(
    Type.String({
      description: "Optional artifact title override.",
    }),
  ),
  slug: Type.Optional(
    Type.String({
      description: "Optional kebab-case artifact slug override.",
    }),
  ),
});

const firstSymbol = (value: unknown): string | undefined => {
  if (typeof value === "string") return toOptionalString(value);
  if (Array.isArray(value)) return toOptionalString(value[0]);
  return undefined;
};

const defaultSlug = (
  mode: string,
  from: string | undefined,
  to: string | undefined,
  entry: unknown,
  target: string | undefined,
): string => {
  if (mode === "tree") {
    return normalizeSlug(
      `calldiff-tree-${toOptionalString(from) ?? "WORKTREE"}`,
    );
  }
  if (mode === "reach") {
    // Reach paths run between symbols, not refs: entry → target. `from`/`to`
    // are refs here and must not leak "X → Y" placeholders into the slug.
    const src = firstSymbol(entry);
    const dst = toOptionalString(target);
    return src && dst
      ? normalizeSlug(`calldiff-reach-${src}-to-${dst}`)
      : "calldiff-reach";
  }
  return normalizeSlug(
    `calldiff-diff-${toOptionalString(from) ?? "HEAD"}-${toOptionalString(to) ?? "WORKTREE"}`,
  );
};

const defaultTitle = (
  mode: string,
  from: string | undefined,
  to: string | undefined,
  entry: unknown,
  target: string | undefined,
): string => {
  if (mode === "tree") {
    return `Call tree: ${toOptionalString(from) ?? "WORKTREE"}`;
  }
  if (mode === "reach") {
    const src = firstSymbol(entry);
    const dst = toOptionalString(target);
    return src && dst ? `Call paths: ${src} → ${dst}` : "Call paths";
  }
  return `Call-flow diff: ${toOptionalString(from) ?? "HEAD"} → ${toOptionalString(to) ?? "WORKTREE"}`;
};

export const registerCalldiffTool = (pi: ExtensionAPI): void => {
  pi.registerTool({
    name: "create_calldiff_artifact",
    label: "Create Calldiff Artifact",
    description:
      "Visualize call-stack changes between git refs (calldiff: who-calls-whom diff, " +
      "22 languages, AST-based). Runs `calldiff <mode> --format json` in the current " +
      "repo and renders the result as a visual artifact: per-entry mermaid call trees " +
      "colored by added/removed/same, a change summary table, and the raw ASCII diff. " +
      "Requires a git work tree; the calldiff binary is resolved from PATH with an " +
      "npx fallback (first run downloads tree-sitter grammars into ~/.cache/calldiff).",
    parameters: CalldiffToolParams,
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: unknown,
    ) {
      const cwd = (ctx as { cwd?: string }).cwd;
      if (!cwd) {
        return errorResult("Missing session cwd.");
      }

      const mode =
        params.mode === "tree" || params.mode === "reach"
          ? params.mode
          : "diff";
      const props: Record<string, unknown> = {
        mode,
        from: params.from,
        to: params.to,
        entry: toEntries(params.entry),
        target: toOptionalString(params.target),
        paths: toStringArray(params.paths),
        maxDepth:
          typeof params.maxDepth === "number" && params.maxDepth > 0
            ? params.maxDepth
            : undefined,
        title: toOptionalString(params.title),
      };

      const slug =
        normalizeSlug(String(params.slug ?? "")) ||
        defaultSlug(
          String(mode),
          toOptionalString(params.from),
          toOptionalString(params.to),
          params.entry,
          toOptionalString(params.target),
        );

      const spec: VisualArtifactSpec = {
        slug,
        title:
          toOptionalString(params.title) ??
          defaultTitle(
            String(mode),
            toOptionalString(params.from),
            toOptionalString(params.to),
            params.entry,
            toOptionalString(params.target),
          ),
        artifactType: "diagram",
        topics: ["calldiff", "call-flow"],
        nodes: [{ type: "calldiff-callflow", props }],
      };

      const outcome = await materializeArtifact(spec, {
        cwd,
        signal,
        strictCalldiff: true,
        baseText: `Calldiff artifact "${spec.title}" created. Slug: ${slug}`,
        log: {
          warn: (message: string) => log.warn(message),
          error: (message: string) => log.error(message),
        },
        sendFeedback: async (text) => {
          pi.sendUserMessage(text, { deliverAs: "followUp" });
        },
      });

      if (!outcome.ok) {
        return errorResult(outcome.text);
      }

      return result(outcome.text);
    },
  });
};
