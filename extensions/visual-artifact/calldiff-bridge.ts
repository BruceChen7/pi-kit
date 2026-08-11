/**
 * Pure conversion core: calldiff JSON → VisualArtifactSpec (mermaid trees,
 * change tables, ascii code-blocks). No IO — testable in isolation
 * (Functional Core). The shared JSON shapes/parsing live in
 * shared/calldiff-json.ts; the CLI shell lives in shared/calldiff-runner.ts.
 */

import {
  type CalldiffNode,
  type CalldiffResult,
  countDiffStatuses,
  type DiffStatusCounts,
} from "../shared/calldiff-json.ts";
import { truncateAscii } from "../shared/callflow.ts";
import type { ArtifactNode, VisualArtifactSpec } from "./artifact-schema.ts";
import { normalizeSlug } from "./tool-helpers.ts";

/* ------------------------------------------------------------------ */

export type MermaidOptions = {
  /** Hard cap on rendered nodes per tree (default 80). */
  maxNodes?: number;
};

const STATUS_CLASSES = [
  "classDef added fill:#dcfce7,stroke:#16a34a,color:#14532d",
  "classDef removed fill:#fee2e2,stroke:#dc2626,color:#7f1d1d",
  "classDef same fill:#f1f5f9,stroke:#94a3b8,color:#334155",
  "classDef branch fill:#fef3c7,stroke:#d97706,color:#78350f",
] as const;

const BRANCH_CLASS_ONLY = [
  "classDef branch fill:#fef3c7,stroke:#d97706,color:#78350f",
] as const;

const escapeMermaidLabel = (label: string): string => {
  const cleaned = label
    .replace(/[\r\n]+/g, " ")
    .replace(/"/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 0 ? cleaned : "?";
};

type MermaidBuildState = {
  lines: string[];
  nextId: number;
  maxNodes: number;
  truncated: boolean;
};

const emitMermaidNode = (
  state: MermaidBuildState,
  node: CalldiffNode,
  parentId: string | null,
  withStatus: boolean,
): void => {
  if (state.nextId >= state.maxNodes) {
    state.truncated = true;
    return;
  }
  const id = `n${state.nextId}`;
  state.nextId += 1;
  state.lines.push(`${id}["${escapeMermaidLabel(node.label)}"]`);

  if (node.kind === "branch") {
    state.lines.push(`class ${id} branch`);
  } else if (withStatus && node.status !== undefined) {
    state.lines.push(`class ${id} ${node.status}`);
  }

  if (parentId !== null) {
    state.lines.push(`${parentId} --> ${id}`);
  }

  for (const child of node.children) {
    emitMermaidNode(state, child, id, withStatus);
  }
};

/**
 * Convert a calldiff call tree into a mermaid flowchart definition.
 * `withStatus=true` colors nodes by diff status (added/removed/same);
 * `withStatus=false` renders a plain call tree (tree/reach modes).
 */
export const callNodeToMermaid = (
  root: CalldiffNode,
  options: MermaidOptions = {},
): string => {
  const state: MermaidBuildState = {
    lines: [],
    nextId: 0,
    maxNodes: options.maxNodes ?? 80,
    truncated: false,
  };
  emitMermaidNode(state, root, null, false);
  if (state.truncated) {
    const id = `n${state.nextId}`;
    state.nextId += 1;
    state.lines.push(`${id}["… ${state.maxNodes}+ more nodes omitted"]`);
    state.lines.push(`n0 --> ${id}`);
  }
  const header = "flowchart TD";
  return [header, ...BRANCH_CLASS_ONLY, ...state.lines].join("\n");
};

export const diffNodeToMermaid = (
  root: CalldiffNode,
  options: MermaidOptions = {},
): string => {
  const state: MermaidBuildState = {
    lines: [],
    nextId: 0,
    maxNodes: options.maxNodes ?? 80,
    truncated: false,
  };
  emitMermaidNode(state, root, null, true);
  if (state.truncated) {
    const id = `n${state.nextId}`;
    state.nextId += 1;
    state.lines.push(`${id}["… ${state.maxNodes}+ more nodes omitted"]`);
    state.lines.push(`n0 --> ${id}`);
  }
  const header = "flowchart TD";
  return [header, ...STATUS_CLASSES, ...state.lines].join("\n");
};

/* ------------------------------------------------------------------ */
/*  Spec assembly                                                      */
/* ------------------------------------------------------------------ */

/**
 * Render knobs shared by the standalone calldiff artifact and embedded
 * `calldiff-callflow` node expansion — single source of truth so the macro
 * node props (resolve-calldiff-node.ts) and the bridge options can't drift
 * apart on these fields.
 */
export type CalldiffRenderOptions = {
  title?: string;
  /** Max per-entry call trees rendered as detailed sections (default 8). */
  maxEntries?: number;
  /** Max mermaid nodes per tree (default 80). */
  maxNodesPerTree?: number;
  /** Max ascii lines per code-block (default 60; 0 = omit code-block). */
  maxAsciiLines?: number;
};

export type CalldiffArtifactOptions = CalldiffRenderOptions & {
  slug?: string;
  description?: string;
};

const DEFAULT_MAX_ENTRIES = 8;
const DEFAULT_MAX_ASCII_LINES = 60;

const asciiCodeBlock = (
  ascii: string,
  maxLines: number,
): ArtifactNode | null => {
  if (maxLines <= 0 || ascii.trim().length === 0) {
    return null;
  }
  return {
    type: "code-block",
    props: { code: truncateAscii(ascii, maxLines), language: "text" },
  };
};

const entrySection = (
  entry: string,
  ascii: string,
  mermaid: string,
  options: CalldiffArtifactOptions,
): ArtifactNode => ({
  type: "section",
  props: {
    title: entry,
    nodes: [
      { type: "mermaid", props: { definition: mermaid } },
      ...(asciiCodeBlock(
        ascii,
        options.maxAsciiLines ?? DEFAULT_MAX_ASCII_LINES,
      )
        ? [
            asciiCodeBlock(
              ascii,
              options.maxAsciiLines ?? DEFAULT_MAX_ASCII_LINES,
            ),
          ]
        : []),
    ],
  },
});

const defaultSlug = (result: CalldiffResult): string => {
  if (result.mode === "diff") {
    return `calldiff-diff-${result.from}-${result.to}`;
  }
  if (result.mode === "tree") {
    return `calldiff-tree-${result.ref}`;
  }
  return `calldiff-reach-${result.from}-to-${result.to}`;
};
// NOTE: kept in sync with calldiff-tool.ts `defaultSlug`/`defaultTitle`,
// which derive the same values from the *requested* params before the run
// (the tool result message needs them early).

const capEntries = (count: number, options: CalldiffArtifactOptions): number =>
  Math.max(0, Math.min(count, options.maxEntries ?? DEFAULT_MAX_ENTRIES));

export const diffResultToSpec = (
  result: Extract<CalldiffResult, { mode: "diff" }>,
  options: CalldiffArtifactOptions = {},
): VisualArtifactSpec => {
  const entries = capEntries(result.trees.length, options);
  const total = result.trees.reduce<DiffStatusCounts>(
    (acc, entry) => {
      const counts = countDiffStatuses(entry.tree);
      acc.added += counts.added;
      acc.removed += counts.removed;
      acc.same += counts.same;
      return acc;
    },
    { added: 0, removed: 0, same: 0 },
  );

  const nodes: ArtifactNode[] = [
    {
      type: "heading",
      props: {
        text: options.title ?? `Call-flow diff: ${result.from} → ${result.to}`,
        level: "h1",
      },
    },
    {
      type: "text",
      props: {
        text:
          options.description ??
          `calldiff diff \`${result.from}\` \`${result.to}\` — ${
            result.trees.length
          } entrypoint(s) with changed call trees (${total.added} added, ${total.removed} removed, ${total.same} unchanged).`,
      },
    },
  ];

  if (result.trees.length === 0) {
    nodes.push({
      type: "callout",
      props: {
        title: "No call-flow changes",
        text:
          result.message ??
          "No exported function call trees changed between the two refs.",
        variant: "info",
      },
    });
    return {
      slug: normalizeSlug(options.slug ?? defaultSlug(result)),
      title: options.title ?? `Call-flow diff: ${result.from} → ${result.to}`,
      description: options.description,
      artifactType: "review",
      topics: ["calldiff", "call-flow", "diff"],
      nodes,
    };
  }

  nodes.push({
    type: "table",
    props: {
      headers: ["Entry", "Added", "Removed", "Unchanged"],
      rows: result.trees.map((entry) => {
        const counts = countDiffStatuses(entry.tree);
        return [
          entry.entry,
          String(counts.added),
          String(counts.removed),
          String(counts.same),
        ];
      }),
    },
  });

  for (const entry of result.trees.slice(0, entries)) {
    nodes.push(
      entrySection(
        entry.entry,
        entry.ascii,
        diffNodeToMermaid(entry.tree, { maxNodes: options.maxNodesPerTree }),
        options,
      ),
    );
  }

  if (result.trees.length > entries) {
    nodes.push({
      type: "text",
      props: {
        text: `… ${result.trees.length - entries} more entrypoint(s) listed above (detail sections capped at ${entries}).`,
        size: "sm",
      },
    });
  }

  return {
    slug: normalizeSlug(options.slug ?? defaultSlug(result)),
    title: options.title ?? `Call-flow diff: ${result.from} → ${result.to}`,
    description: options.description,
    artifactType: "review",
    topics: ["calldiff", "call-flow", "diff"],
    nodes,
  };
};

export const treeResultToSpec = (
  result: Extract<CalldiffResult, { mode: "tree" }>,
  options: CalldiffArtifactOptions = {},
): VisualArtifactSpec => {
  const entries = capEntries(result.trees.length, options);
  const nodes: ArtifactNode[] = [
    {
      type: "heading",
      props: { text: options.title ?? `Call tree: ${result.ref}`, level: "h1" },
    },
    {
      type: "text",
      props: {
        text:
          options.description ??
          `calldiff tree \`${result.ref}\` — ${result.trees.length} entrypoint(s).`,
      },
    },
  ];
  for (const entry of result.trees.slice(0, entries)) {
    nodes.push(
      entrySection(
        entry.entry,
        entry.ascii,
        callNodeToMermaid(entry.tree, { maxNodes: options.maxNodesPerTree }),
        options,
      ),
    );
  }
  return {
    slug: normalizeSlug(options.slug ?? defaultSlug(result)),
    title: options.title ?? `Call tree: ${result.ref}`,
    description: options.description,
    artifactType: "diagram",
    topics: ["calldiff", "call-tree"],
    nodes,
  };
};

export const reachResultToSpec = (
  result: Extract<CalldiffResult, { mode: "reach" }>,
  options: CalldiffArtifactOptions = {},
): VisualArtifactSpec => {
  const entries = capEntries(result.paths.length, options);
  const nodes: ArtifactNode[] = [
    {
      type: "heading",
      props: {
        text: options.title ?? `Call paths: ${result.from} → ${result.to}`,
        level: "h1",
      },
    },
    {
      type: "text",
      props: {
        text:
          options.description ??
          `calldiff reach \`${result.from}\` → \`${result.to}\` at \`${result.ref}\` — ${result.paths.length} path(s).`,
      },
    },
  ];
  for (const entry of result.paths.slice(0, entries)) {
    nodes.push(
      entrySection(
        entry.entry,
        entry.ascii,
        callNodeToMermaid(entry.tree, { maxNodes: options.maxNodesPerTree }),
        options,
      ),
    );
  }
  return {
    slug: normalizeSlug(options.slug ?? defaultSlug(result)),
    title: options.title ?? `Call paths: ${result.from} → ${result.to}`,
    description: options.description,
    artifactType: "diagram",
    topics: ["calldiff", "call-paths"],
    nodes,
  };
};

export const calldiffResultToSpec = (
  result: CalldiffResult,
  options: CalldiffArtifactOptions = {},
): VisualArtifactSpec => {
  if (result.mode === "diff") {
    return diffResultToSpec(result, options);
  }
  if (result.mode === "tree") {
    return treeResultToSpec(result, options);
  }
  return reachResultToSpec(result, options);
};

export type {
  CalldiffNode,
  CalldiffResult,
  CalldiffTreeResult,
  CallNodeKind,
  DiffStatus,
  DiffStatusCounts,
  ParseCalldiffResult,
} from "../shared/calldiff-json.ts";
export {
  countDiffStatuses,
  parseCalldiffJson,
} from "../shared/calldiff-json.ts";
