/**
 * Shared type definitions, resource limits, and validation for VisualArtifactSpec.
 */

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type ArtifactNodeType = string;

export type ArtifactNode = {
  type: ArtifactNodeType;
  props: Record<string, unknown>;
  metadata?: {
    id?: string;
    label?: string;
  };
};

export type Dataset = unknown[];

export type VisualArtifactSpec = {
  slug: string;
  title: string;
  description?: string;
  artifactType?: string;
  topics?: string[];
  layout?: "vertical" | "horizontal";
  data?: Record<string, Dataset>;
  nodes: ArtifactNode[];
};

/* ------------------------------------------------------------------ */
/*  Resource Limits                                                    */
/* ------------------------------------------------------------------ */

export const LIMITS = {
  /** Max raw/final JSON size in bytes */
  maxJsonBytes: 2 * 1024 * 1024,
  /** Max top-level nodes */
  maxTopLevelNodes: 30,
  /** Max total nodes (recursive) */
  maxTotalNodes: 100,
  /** Max datasets */
  maxDatasets: 20,
  /** Max node nesting depth */
  maxNodeDepth: 8,
  /** Max file-tree items */
  maxFileTreeItems: 500,
  /** Max file-tree depth */
  maxFileTreeDepth: 12,
  /** Max sourced content per file (bytes) */
  maxSourcedContentPerFile: 512 * 1024,
  /** Max aggregate sourced content (bytes) */
  maxSourcedContentAggregate: 1024 * 1024,
} as const;

/* ------------------------------------------------------------------ */
/*  Node type catalog for contract export                               */
/* ------------------------------------------------------------------ */

export type NodeTypeEntry = {
  type: string;
  label: string;
  description: string;
  props: Record<string, string>;
  example?: Record<string, unknown>;
};

export const NODE_TYPE_CATALOG: NodeTypeEntry[] = [
  {
    type: "text",
    label: "Text",
    description: "A block of prose text with optional size variants.",
    props: { text: "string", size: '"sm" | "md" | "lg" | "xl"' },
    example: { type: "text", props: { text: "Hello world.", size: "lg" } },
  },
  {
    type: "heading",
    label: "Heading",
    description: "Section heading with level.",
    props: { text: "string", level: '"h1" | "h2" | "h3" | "h4"' },
  },
  {
    type: "list",
    label: "List",
    description: "Bulleted or numbered list of prose items.",
    props: {
      items: '(string | { content: string; type?: "bullet" | "number" })[]',
      ordered: "boolean",
    },
    example: {
      type: "list",
      props: {
        items: [
          { type: "bullet", content: "First item" },
          { type: "bullet", content: "Second item" },
        ],
      },
    },
  },
  {
    type: "card",
    label: "Card",
    description: "Bordered container with optional title and description.",
    props: { title: "string", description: "string", nodes: "ArtifactNode[]" },
  },
  {
    type: "stat-card",
    label: "Stat Card",
    description: "A single metric with label and optional trend indicator.",
    props: {
      label: "string",
      value: "string | number",
      trend: '"up" | "down" | "neutral"',
    },
  },
  {
    type: "table",
    label: "Table",
    description: "Rows and columns of data.",
    props: { headers: "string[]", rows: "string[][]" },
  },
  {
    type: "diff",
    label: "Diff",
    description: "Side-by-side or inline code diff.",
    props: { before: "string", after: "string", language: "string" },
  },
  {
    type: "code-block",
    label: "Code Block",
    description: "Syntax-highlighted code block.",
    props: { code: "string", language: "string", showLineNumbers: "boolean" },
  },
  {
    type: "mermaid",
    label: "Mermaid Diagram",
    description: "Mermaid diagram definition rendered as SVG.",
    props: { definition: "string" },
  },
  {
    type: "log",
    label: "Log",
    description: "Timestamped log lines.",
    props: {
      lines: "{ timestamp?: string; level?: string; message: string }[]",
    },
  },
  {
    type: "badge",
    label: "Badge",
    description: "Short colored label.",
    props: {
      text: "string",
      variant: '"default" | "success" | "warning" | "danger"',
    },
  },
  {
    type: "divider",
    label: "Divider",
    description: "Horizontal separator between sections.",
    props: {},
  },
  {
    type: "link",
    label: "Link",
    description: "A link or link-like text row.",
    props: { text: "string", href: "string" },
  },
  {
    type: "file-tree",
    label: "File Tree",
    description: "Nested file/directory tree.",
    props: { items: "FileTreeItem[]" },
  },
  {
    type: "card-grid",
    label: "Card Grid",
    description: "Grid layout containing cards or nested nodes.",
    props: { cards: "array", nodes: "ArtifactNode[]" },
  },
  {
    type: "tabs",
    label: "Tabs",
    description: "Tabbed groups of nested nodes.",
    props: { tabs: "{ label: string; nodes: ArtifactNode[] }[]" },
  },
  {
    type: "accordion",
    label: "Accordion",
    description: "Collapsible groups of nested nodes.",
    props: { items: "{ title: string; nodes: ArtifactNode[] }[]" },
  },
  {
    type: "section",
    label: "Section",
    description: "Semantic section with nested nodes.",
    props: { title: "string", nodes: "ArtifactNode[]" },
  },
  {
    type: "svg-diagram",
    label: "SVG Diagram",
    description: "Inline SVG diagram.",
    props: { svg: "string" },
  },
  {
    type: "image",
    label: "Image",
    description: "Image media block.",
    props: { src: "string", alt: "string" },
  },
  {
    type: "video",
    label: "Video",
    description: "Video media block.",
    props: { src: "string", title: "string" },
  },
  {
    type: "timeline",
    label: "Timeline",
    description: "Timeline with ordered events.",
    props: { items: "array" },
  },
  {
    type: "step",
    label: "Step",
    description: "Single process step.",
    props: { title: "string", description: "string" },
  },
  {
    type: "quote",
    label: "Quote",
    description: "Quoted prose.",
    props: { text: "string", attribution: "string" },
  },
  {
    type: "callout",
    label: "Callout",
    description: "Highlighted note/warning/info block.",
    props: { title: "string", text: "string", variant: "string" },
  },
  {
    type: "blockquote",
    label: "Blockquote",
    description: "Indented quote/prose block.",
    props: { text: "string" },
  },
];

const SUPPORTED_NODE_TYPES = new Set(
  NODE_TYPE_CATALOG.map((entry) => entry.type),
);

const REQUIRED_NODE_PROPS: Record<string, string[]> = {
  text: ["text"],
  heading: ["text", "level"],
  list: ["items"],
  table: ["headers", "rows"],
  "code-block": ["code"],
  link: ["text"],
  log: ["lines"],
  badge: ["text"],
  diff: ["before", "after"],
  "stat-card": ["label", "value"],
};

const LEGACY_PROP_NAMES: Record<string, Record<string, string>> = {
  text: { text: "content" },
  mermaid: { definition: "chart" },
  link: { text: "label", href: "url" },
  card: { description: "content" },
};

/* ------------------------------------------------------------------ */
/*  Validation                                                          */
/* ------------------------------------------------------------------ */

export type ValidationResult =
  | { ok: true; spec: VisualArtifactSpec }
  | { ok: false; errors: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function estimateJsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function countNodes(node: ArtifactNode, depth: number): number {
  let count = 1;
  if (depth > LIMITS.maxNodeDepth) return count;
  const children = node.props?.nodes;
  if (Array.isArray(children)) {
    for (const child of children) {
      if (isRecord(child) && typeof child.type === "string") {
        count += countNodes(child as ArtifactNode, depth + 1);
      }
    }
  }
  return count;
}

function validateNodeProps(
  type: string,
  props: Record<string, unknown>,
  errors: string[],
): void {
  if (!SUPPORTED_NODE_TYPES.has(type)) {
    errors.push(`Unsupported node type: "${type}".`);
    return;
  }

  const requiredProps = REQUIRED_NODE_PROPS[type] ?? [];
  const legacyProps = LEGACY_PROP_NAMES[type] ?? {};

  for (const propName of requiredProps) {
    if (props[propName] !== undefined) continue;

    const legacyName = legacyProps[propName];
    if (legacyName && props[legacyName] !== undefined) {
      errors.push(
        `Node "${type}" requires prop "${propName}" ` +
          `(legacy prop "${legacyName}" is not supported).`,
      );
      continue;
    }

    errors.push(`Node "${type}" requires prop "${propName}".`);
  }

  if (
    type === "mermaid" &&
    props.definition === undefined &&
    props.code === undefined
  ) {
    if (props.chart !== undefined) {
      errors.push(
        'Node "mermaid" requires prop "definition" ' +
          '(legacy prop "chart" is not supported).',
      );
    } else {
      errors.push('Node "mermaid" requires prop "definition".');
    }
  }
}

function _countFileTreeDepth(items: unknown[], currentDepth: number): number {
  let maxDepth = currentDepth;
  for (const item of items) {
    if (isRecord(item) && Array.isArray(item.children)) {
      const d = _countFileTreeDepth(item.children, currentDepth + 1);
      if (d > maxDepth) maxDepth = d;
    }
  }
  return maxDepth;
}

function _countFileTreeItems(items: unknown[]): number {
  let count = items.length;
  for (const item of items) {
    if (isRecord(item) && Array.isArray(item.children)) {
      count += _countFileTreeItems(item.children);
    }
  }
  return count;
}

export function validate(input: unknown): ValidationResult {
  const errors: string[] = [];

  if (!isRecord(input)) {
    return { ok: false, errors: ["Input must be a JSON object."] };
  }

  /* -- json size -- */
  const rawBytes = estimateJsonBytes(input);
  if (rawBytes > LIMITS.maxJsonBytes) {
    errors.push(
      `JSON exceeds size limit: ${rawBytes} bytes > ${LIMITS.maxJsonBytes} bytes`,
    );
  }

  /* -- required fields -- */
  if (typeof input.slug !== "string" || input.slug.trim().length === 0) {
    errors.push("slug is required and must be a non-empty string.");
  }
  if (typeof input.title !== "string" || input.title.trim().length === 0) {
    errors.push("title is required and must be a non-empty string.");
  }

  /* -- nodes -- */
  const nodes = input.nodes;
  if (!Array.isArray(nodes)) {
    errors.push("nodes must be an array.");
    return { ok: false, errors };
  }

  if (nodes.length > LIMITS.maxTopLevelNodes) {
    errors.push(
      `Too many top-level nodes: ${nodes.length} > ${LIMITS.maxTopLevelNodes}`,
    );
  }

  /* -- validate each node -- */
  let totalNodes = 0;
  for (const node of nodes) {
    if (!isRecord(node) || typeof node.type !== "string") {
      errors.push("Each node must have a type property.");
      continue;
    }
    if (!isRecord(node.props)) {
      errors.push(`Node "${node.type}" is missing props.`);
    } else {
      validateNodeProps(node.type, node.props, errors);
    }
    totalNodes += countNodes(node as ArtifactNode, 1);
  }

  if (totalNodes > LIMITS.maxTotalNodes) {
    errors.push(
      `Too many total nodes: ${totalNodes} > ${LIMITS.maxTotalNodes}`,
    );
  }

  /* -- data -- */
  if (input.data !== undefined) {
    if (!isRecord(input.data)) {
      errors.push("data must be a record of datasets.");
    } else {
      const datasetKeys = Object.keys(input.data);
      if (datasetKeys.length > LIMITS.maxDatasets) {
        errors.push(
          `Too many datasets: ${datasetKeys.length} > ${LIMITS.maxDatasets}`,
        );
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  /* -- build typed spec -- */
  const spec: VisualArtifactSpec = {
    slug: String(input.slug),
    title: String(input.title),
    description:
      typeof input.description === "string" ? input.description : undefined,
    artifactType:
      typeof input.artifactType === "string" ? input.artifactType : undefined,
    topics: Array.isArray(input.topics)
      ? (input.topics as string[])
      : undefined,
    layout: input.layout === "horizontal" ? "horizontal" : "vertical",
    data: isRecord(input.data)
      ? (input.data as Record<string, Dataset>)
      : undefined,
    nodes: nodes as ArtifactNode[],
  };

  return { ok: true, spec };
}
