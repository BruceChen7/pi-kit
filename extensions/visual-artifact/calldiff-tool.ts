/**
 * Tool registration: `create_calldiff_artifact`.
 *
 * Runs the calldiff CLI in the session cwd (git repo required), converts
 * the structured JSON output into a VisualArtifactSpec (calldiff-bridge),
 * and opens it in a Glimpse window — reusing the same store/host pipeline
 * as `create_visual_artifact`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  type CalldiffRunOptions,
  runCalldiffJson,
} from "../shared/calldiff-runner.ts";
import { createLogger } from "../shared/logger.ts";
import { validate } from "./artifact-schema.ts";
import { writeArtifact } from "./artifact-store.ts";
import { calldiffResultToSpec, parseCalldiffJson } from "./calldiff-bridge.ts";
import { openVisualArtifactWindow } from "./glimpse-host.ts";
import {
  formatMermaidValidationErrors,
  validateMermaidNodesInSpec,
} from "./mermaid-boundary.ts";
import { deriveProjectName, getDefaultProjectRoot } from "./paths.ts";
import { errorResult, result } from "./tool-helpers.ts";

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

const toEntries = (value: unknown): string[] | undefined => {
  if (typeof value === "string") {
    return value.trim().length > 0 ? [value.trim()] : undefined;
  }
  if (Array.isArray(value)) {
    const entries = value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    return entries.length > 0 ? entries : undefined;
  }
  return undefined;
};

const toStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : undefined;
};

const toOptionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;

export const registerCalldiffTool = (pi: ExtensionAPI): void => {
  pi.registerTool({
    name: "create_calldiff_artifact",
    label: "Create Calldiff Artifact",
    description:
      "Visualize call-stack changes between git refs (calldiff: who-calls-whom diff, " +
      "22 languages, AST-based). Runs `calldiff diff --format json` in the current " +
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

      const runOptions: CalldiffRunOptions = {
        cwd,
        signal,
        mode:
          params.mode === "tree" || params.mode === "reach"
            ? params.mode
            : "diff",
        from: toOptionalString(params.from),
        to: toOptionalString(params.to),
        entries: toEntries(params.entry),
        target: toOptionalString(params.target),
        paths: toStringArray(params.paths),
        maxDepth:
          typeof params.maxDepth === "number" && params.maxDepth > 0
            ? params.maxDepth
            : undefined,
      };

      if (runOptions.mode !== "diff" && !runOptions.entries) {
        return errorResult(
          "calldiff tree/reach require --entry (functionName or ClassName.method).",
        );
      }
      if (runOptions.mode === "reach" && !runOptions.target) {
        return errorResult("calldiff reach requires a target symbol.");
      }

      const outcome = await runCalldiffJson(runOptions);
      if (outcome.status === "error") {
        if (outcome.code === "no-git-repo") {
          return errorResult(
            "calldiff needs a git work tree — this session is not inside one. " +
              "Run the tool from a git repository directory.",
          );
        }
        if (outcome.code === "aborted") {
          return errorResult("calldiff run aborted.");
        }
        log.warn(`calldiff failed (${outcome.code}): ${outcome.message}`);
        return errorResult(
          `calldiff failed (${outcome.code}): ${outcome.message} ` +
            "Install it with `npm install -g calldiff` or retry when a network " +
            "connection is available for the npx fallback.",
        );
      }

      const parsed = parseCalldiffJson(outcome.stdout);
      if (parsed.status === "error") {
        return errorResult(
          `calldiff output could not be parsed: ${parsed.error}`,
        );
      }

      const spec = calldiffResultToSpec(parsed.result, {
        title: toOptionalString(params.title),
        slug: toOptionalString(params.slug),
      });

      const validated = validate(spec);
      if (!validated.ok) {
        return errorResult(
          `Artifact validation failed:\n- ${(validated as { errors: string[] }).errors.join("\n- ")}`,
        );
      }

      const { errors: mermaidErrors } = await validateMermaidNodesInSpec(
        validated.spec,
      );
      if (mermaidErrors.length > 0) {
        log.warn(`Mermaid validation failed:\n${mermaidErrors.join("\n")}`);
        return errorResult(formatMermaidValidationErrors(mermaidErrors));
      }

      const projectRoot = getDefaultProjectRoot();
      const projectName = deriveProjectName(projectRoot);
      writeArtifact(projectRoot, projectName, validated.spec);

      try {
        await openVisualArtifactWindow({
          bootData: {
            view: "artifact",
            projectName,
            artifactSlug: validated.spec.slug,
            artifactSpec: validated.spec,
          },
          projectRoot,
          projectName,
          sendFeedback: async (text) => {
            pi.sendUserMessage(text, { deliverAs: "followUp" });
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error(`Failed to open Glimpse window: ${message}`);
        return errorResult(
          `Calldiff artifact saved, but failed to open Glimpse window: ${message}. ` +
            "It can be opened later via the /visual-artifact command.",
        );
      }

      const detail =
        parsed.result.mode === "diff"
          ? `${parsed.result.trees.length} entrypoint(s) with changed call trees`
          : parsed.result.mode === "tree"
            ? `${parsed.result.trees.length} entrypoint(s)`
            : `${parsed.result.paths.length} path(s)`;
      return result(
        `Calldiff artifact "${validated.spec.title}" created (${detail}). Slug: ${validated.spec.slug}`,
      );
    },
  });
};
