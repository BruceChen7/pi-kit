import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type VisualArtifactSpec, validate } from "./artifact-schema.ts";
import {
  listArtifacts,
  readArtifact,
  writeArtifact,
} from "./artifact-store.ts";
import { openVisualArtifactWindow } from "./glimpse-host.ts";
import {
  normalizeMermaidNodesInSpec,
  validateMermaidNodesInSpec,
} from "./mermaid-boundary.ts";
import { deriveProjectName, getDefaultProjectRoot } from "./paths.ts";

/* ------------------------------------------------------------------ */
/*  Parameter schemas (TypeBox)                                        */
/* ------------------------------------------------------------------ */

const CreateArtifactParams = Type.Object({
  slug: Type.String({
    description:
      "Unique kebab-case identifier for the artifact, e.g. 'auth-flow-review'",
  }),
  title: Type.String({
    description: "Page title displayed at the top of the artifact",
  }),
  description: Type.Optional(
    Type.String({ description: "Optional page description / subtitle" }),
  ),
  artifactType: Type.Optional(
    Type.String({
      description:
        "Optional type hint: explainer, dashboard, review, comparison, report, plan, diagram, idea",
    }),
  ),
  topics: Type.Optional(
    Type.String({
      description: "Optional comma-separated discovery tags",
    }),
  ),
  nodes: Type.String({
    description:
      "JSON string of ArtifactNode[]. Each node has type and props. " +
      "Available types: text, heading, card, stat-card, table, diff, code-block, " +
      "mermaid, log, badge, divider, card-grid, tabs, accordion, section, " +
      "svg-diagram, image, video, file-tree, link, timeline, step, quote, callout, blockquote.",
  }),
  data: Type.Optional(
    Type.String({
      description:
        "Optional JSON string of Record<string, array> for dataKey references",
    }),
  ),
});

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function normalizeSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function result(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: {},
    isError: false,
  };
}

function errorResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: {},
    isError: true,
  };
}

/* ------------------------------------------------------------------ */
/*  Extension entry point                                              */
/* ------------------------------------------------------------------ */

export default function visualArtifactExtension(pi: ExtensionAPI): void {
  /* ---- Tool: create_visual_artifact ---- */
  pi.registerTool({
    name: "create_visual_artifact",
    label: "Create Visual Artifact",
    description:
      "Create a visual artifact page from structured JSON data. " +
      "The artifact is stored locally and can be viewed in a Glimpse window.",
    parameters: CreateArtifactParams,
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: unknown,
    ) {
      const slug = normalizeSlug(String(params.slug ?? ""));
      if (!slug) {
        return errorResult("slug is required and must be a non-empty string.");
      }

      const title = String(params.title ?? "").trim();
      if (!title) {
        return errorResult("title is required and must be a non-empty string.");
      }

      const nodesRaw = String(params.nodes ?? "[]");
      const parsedNodes = tryParseJson(nodesRaw);
      if (!parsedNodes || !Array.isArray(parsedNodes)) {
        return errorResult("nodes must be a valid JSON array string");
      }

      const parsedData = params.data
        ? tryParseJson(String(params.data))
        : undefined;

      const spec: VisualArtifactSpec = normalizeMermaidNodesInSpec({
        slug,
        title,
        description: String(params.description ?? "").trim() || undefined,
        artifactType: String(params.artifactType ?? "").trim() || undefined,
        topics:
          String(params.topics ?? "")
            .split(",")
            .map((t: string) => t.trim())
            .filter(Boolean) || undefined,
        nodes: parsedNodes as VisualArtifactSpec["nodes"],
        data: parsedData
          ? (parsedData as Record<string, unknown[]>)
          : undefined,
      });

      const validated = validate(spec);
      if (!validated.ok) {
        return errorResult(
          `Validation failed:\n- ${(validated as { errors: string[] }).errors.join("\n- ")}`,
        );
      }

      const mermaidErrors = await validateMermaidNodesInSpec(validated.spec);
      if (mermaidErrors.length > 0) {
        return errorResult(
          `Mermaid validation failed:\n- ${mermaidErrors.join("\n- ")}`,
        );
      }

      const projectRoot = getDefaultProjectRoot();
      const projectName = deriveProjectName(projectRoot);

      writeArtifact(projectRoot, projectName, validated.spec);

      try {
        await openVisualArtifactWindow({
          bootData: {
            view: "artifact",
            projectName,
            artifactSlug: slug,
            artifactSpec: validated.spec,
          },
          projectRoot,
          projectName,
        });
      } catch {
        // Artifact creation should still succeed when Glimpse is unavailable.
      }

      return result(`Visual artifact "${title}" created. Slug: ${slug}`);
    },
  });

  /* ---- Command: /visual-artifact ---- */
  pi.registerCommand("visual-artifact", {
    description: "Manage visual artifacts: open, list, create",
    getArgumentCompletions(prefix: string) {
      const subcommands = ["open", "list"];
      return subcommands
        .filter((item) => item.startsWith(prefix))
        .map((item) => ({ label: item, value: item }));
    },
    async handler(args: string, ctx) {
      const projectRoot = getDefaultProjectRoot();
      const projectName = deriveProjectName(projectRoot);
      const [subcommand = "open", maybeSlug = ""] = args.trim().split(/\s+/u);

      if (subcommand === "list") {
        const artifacts = listArtifacts(projectRoot, projectName);
        const lines = artifacts.length
          ? artifacts.map((artifact) => artifact.slug).join("\n")
          : "(no artifacts yet)";
        ctx.ui.notify(`Visual Artifacts (${projectName}):\n${lines}`, "info");
        return;
      }

      if (subcommand !== "open") {
        ctx.ui.notify(
          `Unknown visual-artifact command: ${subcommand}. Use open or list.`,
          "warning",
        );
        return;
      }

      const artifacts = listArtifacts(projectRoot, projectName);
      const slug =
        maybeSlug || (artifacts.length === 1 ? artifacts[0].slug : "");
      const spec = slug ? readArtifact(projectRoot, projectName, slug) : null;

      try {
        await openVisualArtifactWindow({
          bootData: spec
            ? {
                view: "artifact",
                projectName,
                artifactSlug: slug,
                artifactSpec: spec,
              }
            : {
                view: artifacts.length > 0 ? "project" : "home",
                projectName,
              },
          projectRoot,
          projectName,
        });

        ctx.ui.notify(
          spec
            ? `Opened Visual Artifact: ${slug}`
            : `Opened Visual Artifact browser for ${projectName}`,
          "info",
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Failed to open Glimpse: ${message}`, "error");
      }
    },
  });
}
