/**
 * Pure conversion core: calldiff JSON → VisualArtifactSpec (mermaid trees,
 * change tables, ascii code-blocks). No IO — testable in isolation
 * (Functional Core). The shared JSON shapes/parsing live in
 * shared/calldiff-json.ts; the CLI shell lives in shared/calldiff-runner.ts.
 */

import {
  type CalldiffNode,
  type CalldiffResult,
  type CalldiffTreeResult,
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

/** `file:line` suffix for changed, source-located nodes (diff rendering). */
const nodeLocationSuffix = (node: CalldiffNode): string => {
  if (!node.file) return "";
  return `${node.file}${node.line ? `:${node.line}` : ""}`;
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

  let label = escapeMermaidLabel(node.label);
  if (withStatus && node.status !== undefined && node.status !== "same") {
    const location = nodeLocationSuffix(node);
    if (location) label = `${label} (${location})`;
  }
  state.lines.push(`${id}["${label}"]`);

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
/*  Pure helpers: node counts, file impacts, file filter               */
/* ------------------------------------------------------------------ */

/**
 * Total node count of a call tree (recursive).
 */
export const countNodes = (root: CalldiffNode): number => {
  let total = 1;
  for (const child of root.children) {
    total += countNodes(child);
  }
  return total;
};

/**
 * Aggregate diff-status counts deduped by node key across all entry trees
 * (the KPI/description semantics): a symbol reachable through several entry
 * trees is one step — the same dedup rule {@link buildFileImpacts} applies
 * per file, so the "Changed steps" KPI, the description, and the file-impacts
 * table stay comparable. Per-entry tables still use {@link countDiffStatuses}.
 */
export const countChangedSteps = (
  result: Extract<CalldiffResult, { mode: "diff" }>,
): DiffStatusCounts => {
  const counts: DiffStatusCounts = { added: 0, removed: 0, same: 0 };
  const seen = new Set<string>();
  const visit = (node: CalldiffNode): void => {
    if (!seen.has(node.key)) {
      seen.add(node.key);
      if (node.status === "added") counts.added += 1;
      else if (node.status === "removed") counts.removed += 1;
      else counts.same += 1;
    }
    for (const child of node.children) {
      visit(child);
    }
  };
  for (const tree of result.trees) {
    visit(tree.tree);
  }
  return counts;
};

/** Aggregated per-file impact of a diff result (the `fileImpacts` view). */
export type FileImpact = {
  file: string;
  /** Entry trees containing at least one changed node in this file. */
  entries: string[];
  /** Unique changed nodes in this file (deduped by node key). */
  changedNodes: number;
  added: number;
  removed: number;
};

/**
 * Reverse index: changed files → affected entries → changed-step counts.
 * Nodes are deduped by (file, key) so a node reachable through several
 * entry trees counts once. Sorted by changedNodes desc, then file name.
 */
export const buildFileImpacts = (
  result: Extract<CalldiffResult, { mode: "diff" }>,
): FileImpact[] => {
  const byFile = new Map<string, FileImpact>();
  const seenKeys = new Map<string, Set<string>>();

  const visit = (node: CalldiffNode, entry: string): void => {
    if (node.status !== undefined && node.status !== "same" && node.file) {
      let impact = byFile.get(node.file);
      if (!impact) {
        impact = {
          file: node.file,
          entries: [],
          changedNodes: 0,
          added: 0,
          removed: 0,
        };
        byFile.set(node.file, impact);
      }
      if (!impact.entries.includes(entry)) {
        impact.entries.push(entry);
      }
      let seen = seenKeys.get(node.file);
      if (!seen) {
        seen = new Set();
        seenKeys.set(node.file, seen);
      }
      if (!seen.has(node.key)) {
        seen.add(node.key);
        impact.changedNodes += 1;
        if (node.status === "added") impact.added += 1;
        else impact.removed += 1;
      }
    }
    for (const child of node.children) {
      visit(child, entry);
    }
  };

  for (const tree of result.trees) {
    visit(tree.tree, tree.entry);
  }

  return [...byFile.values()].sort(
    (a, b) => b.changedNodes - a.changedNodes || a.file.localeCompare(b.file),
  );
};

/**
 * Lens-style file filter: keep only entry trees containing at least one
 * changed node in `file`. Filtering happens only at the entry boundary —
 * matched trees are kept complete, never pruned. Returns the same result
 * (trees possibly empty) so callers can degrade to a per-file empty state.
 */
export const filterDiffResultForFile = (
  result: Extract<CalldiffResult, { mode: "diff" }>,
  file: string,
): Extract<CalldiffResult, { mode: "diff" }> => {
  const treeTouchesFile = (node: CalldiffNode): boolean => {
    if (
      node.status !== undefined &&
      node.status !== "same" &&
      node.file === file
    ) {
      return true;
    }
    return node.children.some((child) => treeTouchesFile(child));
  };
  return {
    ...result,
    trees: result.trees.filter((tree) => treeTouchesFile(tree.tree)),
  };
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
  /**
   * Max call-tree nodes that still render as a mermaid diagram (default 25).
   * Larger trees render ASCII only — mermaid layouts degrade badly past
   * roughly 30 nodes.
   */
  maxMermaidNodes?: number;
  /**
   * Diff mode only: keep only complete entry trees containing a changed
   * node in this file (Lens-style filter; matched trees are never pruned).
   */
  file?: string;
};

export type CalldiffArtifactOptions = CalldiffRenderOptions & {
  slug?: string;
  description?: string;
};

const DEFAULT_MAX_ENTRIES = 8;
const DEFAULT_MAX_ASCII_LINES = 60;
const DEFAULT_MAX_MERMAID_NODES = 25;

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

/**
 * One accordion item per entry: mermaid (when the tree is small enough),
 * then the per-entry ASCII block. Large trees skip the diagram — a short
 * note replaces it so the section still explains what happened.
 */
const entryAccordionItem = (
  entry: string,
  ascii: string,
  tree: CalldiffNode,
  options: CalldiffArtifactOptions,
  withStatus: boolean,
): { title: string; nodes: ArtifactNode[]; defaultOpen: boolean } => {
  const maxMermaidNodes = options.maxMermaidNodes ?? DEFAULT_MAX_MERMAID_NODES;
  const nodes: ArtifactNode[] = [];
  const nodeCount = countNodes(tree);

  if (nodeCount <= maxMermaidNodes) {
    nodes.push({
      type: "mermaid",
      props: {
        definition: (withStatus ? diffNodeToMermaid : callNodeToMermaid)(tree, {
          maxNodes: options.maxNodesPerTree,
        }),
      },
    });
  } else {
    nodes.push({
      type: "text",
      props: {
        text: `Diagram omitted: ${nodeCount} nodes exceeds the ${maxMermaidNodes} node diagram limit; ASCII below.`,
        size: "sm",
      },
    });
  }

  const asciiNode = asciiCodeBlock(
    ascii,
    options.maxAsciiLines ?? DEFAULT_MAX_ASCII_LINES,
  );
  if (asciiNode) {
    nodes.push(asciiNode);
  }

  return { title: entry, nodes, defaultOpen: false };
};

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

/** "Paths" tab: per-entry table + collapsible trees + qualification. */
const diffPathsTab = (
  trees: Extract<CalldiffResult, { mode: "diff" }>["trees"],
  total: DiffStatusCounts,
  entries: number,
  options: CalldiffArtifactOptions,
): ArtifactNode[] => {
  const nodes: ArtifactNode[] = [
    {
      type: "table",
      props: {
        headers: ["Entry", "Added", "Removed", "Unchanged"],
        rows: trees.map((entry) => {
          const counts = countDiffStatuses(entry.tree);
          return [
            entry.entry,
            String(counts.added),
            String(counts.removed),
            String(counts.same),
          ];
        }),
      },
    },
    {
      type: "accordion",
      props: {
        items: trees
          .slice(0, entries)
          .map((entry) =>
            entryAccordionItem(
              entry.entry,
              entry.ascii,
              entry.tree,
              options,
              true,
            ),
          ),
      },
    },
  ];

  if (trees.length > entries) {
    nodes.push({
      type: "text",
      props: {
        text: `… ${trees.length - entries} more entrypoint(s) listed above (detail sections capped at ${entries}).`,
        size: "sm",
      },
    });
  }

  if (total.added + total.removed > 0) {
    nodes.push({
      type: "callout",
      props: {
        title: "Syntactic analysis",
        text:
          "CallDiff is syntactic evidence, not a runtime trace: no type or import resolution, " +
          "dataflow, or dynamic dispatch. Moves or reorderings can appear as remove/add pairs, " +
          "and duplicate bare symbol names can be ambiguous.",
        variant: "info",
      },
    });
  }

  return nodes;
};

/** "Raw" tab: the whole canonical CallDiff rendering (bounded, copyable). */
const rawTab = (
  ascii: string,
  options: CalldiffArtifactOptions,
): ArtifactNode[] => {
  const codeBlock = asciiCodeBlock(
    ascii,
    options.maxAsciiLines ?? DEFAULT_MAX_ASCII_LINES,
  );
  if (codeBlock) {
    return [codeBlock];
  }
  return [
    {
      type: "text",
      props: { text: "No raw output.", size: "sm" },
    },
  ];
};

const entryTabSpec = (
  entries: number,
  treeEntry: CalldiffTreeResult[],
  ascii: string,
  options: CalldiffArtifactOptions,
): ArtifactNode[] => {
  const nodes: ArtifactNode[] = [
    {
      type: "tabs",
      props: {
        tabs: [
          {
            label: "Paths",
            nodes: [
              {
                type: "accordion",
                props: {
                  items: treeEntry
                    .slice(0, entries)
                    .map((entry) =>
                      entryAccordionItem(
                        entry.entry,
                        entry.ascii,
                        entry.tree,
                        options,
                        false,
                      ),
                    ),
                },
              },
            ],
          },
          { label: "Raw", nodes: rawTab(ascii, options) },
        ],
      },
    },
  ];
  if (treeEntry.length > entries) {
    nodes.push({
      type: "text",
      props: {
        text: `… ${treeEntry.length - entries} more entrypoint(s) listed above (detail sections capped at ${entries}).`,
        size: "sm",
      },
    });
  }
  return nodes;
};

export const diffResultToSpec = (
  result: Extract<CalldiffResult, { mode: "diff" }>,
  options: CalldiffArtifactOptions = {},
): VisualArtifactSpec => {
  const file = options.file;
  const trees = file
    ? filterDiffResultForFile(result, file).trees
    : result.trees;
  const entries = capEntries(trees.length, options);
  // Aggregate counts deduped by node key (see countChangedSteps) so the
  // description and KPI stay comparable with the file-impacts table.
  const total = countChangedSteps({ ...result, trees });
  const impacts = buildFileImpacts({ ...result, trees });

  const defaultDescription = file
    ? `calldiff diff \`${result.from}\` \`${result.to}\` — ${trees.length} entrypoint(s) with changed call trees touching \`${file}\` (${total.added} added, ${total.removed} removed, ${total.same} unchanged).`
    : `calldiff diff \`${result.from}\` \`${result.to}\` — ${trees.length} entrypoint(s) with changed call trees (${total.added} added, ${total.removed} removed, ${total.same} unchanged).`;

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
        text: options.description ?? defaultDescription,
      },
    },
  ];

  if (trees.length === 0) {
    nodes.push({
      type: "callout",
      props: {
        title: "No call-flow changes",
        text: file
          ? `No changed call trees touch \`${file}\`.`
          : (result.message ??
            "No exported function call trees changed between the two refs."),
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
    type: "kpi-grid",
    props: {
      columns: 4,
      items: [
        { label: "Changed steps", value: total.added + total.removed },
        { label: "Impacted files", value: impacts.length },
        { label: "Added", value: total.added },
        { label: "Removed", value: total.removed },
      ],
    },
  });

  const pathsTabNodes = diffPathsTab(trees, total, entries, options);
  if (impacts.length > 0) {
    pathsTabNodes.unshift({
      type: "table",
      props: {
        headers: ["File", "Affected entries", "Added", "Removed"],
        rows: impacts.map((impact) => [
          impact.file,
          impact.entries.join(", "),
          String(impact.added),
          String(impact.removed),
        ]),
      },
    });
  }
  nodes.push({
    type: "tabs",
    props: {
      tabs: [
        { label: "Paths", nodes: pathsTabNodes },
        { label: "Raw", nodes: rawTab(result.ascii, options) },
      ],
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
    ...entryTabSpec(entries, result.trees, result.ascii, options),
  ];
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
    ...entryTabSpec(entries, result.paths, result.ascii, options),
  ];
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
