/**
 * LLM-facing contract: node type descriptions and limits.
 * Agents read this to learn what they can produce.
 */

import { LIMITS, NODE_TYPE_CATALOG } from "./artifact-schema.ts";

export const CONTRACT = {
  description:
    "Visual Artifact is a constrained JSON-to-UI runtime. " +
    "Agents emit a VisualArtifactSpec JSON; the renderer handles UI.",
  specShape: {
    slug: "string — unique kebab-case identifier",
    title: "string — page title",
    description: "string (optional) — page description",
    artifactType:
      '"explainer" | "dashboard" | "review" | "comparison" | "report" | "plan" | "diagram" | "idea" (optional)',
    topics: "string[] (optional) — discovery tags",
    layout: '"vertical" | "horizontal" (optional, default vertical)',
    data: "Record<string, array> (optional) — shared datasets referenced by dataKey",
    nodes: "ArtifactNode[] — the UI tree",
  },
  limits: {
    maxJsonBytes: `${LIMITS.maxJsonBytes} bytes`,
    maxTopLevelNodes: LIMITS.maxTopLevelNodes,
    maxTotalNodes: LIMITS.maxTotalNodes,
    maxDatasets: LIMITS.maxDatasets,
    maxNodeDepth: LIMITS.maxNodeDepth,
  },
  nodeTypes: NODE_TYPE_CATALOG.map((entry) => ({
    type: entry.type,
    label: entry.label,
    description: entry.description,
    props: entry.props,
    // Include per-type guidelines where defined (e.g., mermaid)
    ...(entry.guidelines ? { guidelines: entry.guidelines } : {}),
  })),
} as const;
