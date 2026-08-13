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

export type TypeGuidelines = {
  hints: string[];
  example?: string;
  commonMistakes?: string[];
};

export type NodeTypeEntry = {
  type: string;
  label: string;
  description: string;
  props: Record<string, string>;
  example?: Record<string, unknown>;
  /**
   * Agent-facing guidelines to help generate correct code for this node type.
   * These are included in the LLM-facing contract.
   */
  guidelines?: string[];
  /**
   * Per-subtype guidelines keyed by diagram/subtype identifier.
   * For mermaid, keys are diagram type keywords (flowchart, sequenceDiagram, etc.).
   */
  typeGuidelines?: Record<string, TypeGuidelines>;
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
    props: {
      headers: "string[] (preferred for inline rows)",
      columns:
        "string[] | { key?: string; label?: string; header?: string }[] (accepted as inline header aliases or with dataKey)",
      rows: "string[][]",
      dataKey: "string (optional dataset reference)",
    },
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
    guidelines: [
      'Always use double-quoted labels in square brackets: N["label text"] not N[label text]',
      "Never use parentheses () inside unquoted labels — they confuse the parser",
      'Use ::: class application on a separate line, NOT inline: write N["label"] then N:::class',
      "Avoid <br/> in labels — use shorter text or split into multiple nodes instead",
      'For sequenceDiagram, quote participant names with special chars: participant A as "my name"',
      "Keep diagram type declaration simple: flowchart LR, sequenceDiagram, stateDiagram-v2, etc.",
    ],
    typeGuidelines: {
      flowchart: {
        hints: [
          "Direction: LR (left→right) for architecture, TB (top→bottom) for processes",
          "Node shapes: [] for process, () for start/end, {} for decision, > for I/O",
          "Use subgraph for logical groupings: subgraph Title ... end",
          'Always quote labels with special chars: N["label with () or []"]',
          'For edge labels, use quoted pipe syntax: -->|"label"| Next',
        ],
        example: [
          "flowchart LR",
          '  START(["Start"]) --> PROC["Process"]',
          "  PROC --> DEC{Check?}",
          '  DEC -->|"Yes"| PASS["OK"]',
          '  DEC -->|"No"| FAIL["Fail"]',
        ].join("\n"),
      },
      sequenceDiagram: {
        hints: [
          'Define participants at the top: participant A as "Alias"',
          "Message arrows: -> for solid, ->> for dotted, --x for loss",
          "Use activate/deactivate for lifeline activation blocks",
          "Group with loop/alt/opt/par for structured logic",
          "Use Note over A,B: text for annotations",
        ],
        example: [
          "sequenceDiagram",
          '  participant U as "User"',
          '  participant S as "Service"',
          "  U->>S: Request",
          "  activate S",
          "  S-->>U: Response",
          "  deactivate S",
        ].join("\n"),
      },
      classDiagram: {
        hints: [
          "Use +/-/# for visibility: +public, -private, #protected",
          "Relations: <|-- inheritance, *-- composition, o-- aggregation",
          "Define members inside {}: class Name { +method() }",
          "Use <<interface>> or <<abstract>> stereotypes",
          "Use class A : BaseClass for inheritance declaration",
        ],
        example: [
          "classDiagram",
          "  class Animal {",
          "    +String name",
          "    +eat()",
          "  }",
          "  class Dog {",
          "    +bark()",
          "  }",
          "  Animal <|-- Dog",
        ].join("\n"),
      },
      stateDiagram: {
        hints: [
          "Use [*] for initial and final states: [*] --> Active",
          'Use state "Label" as Alias for multi-word state names',
          "Use --> for transitions, add labels: -->|event| NextState",
          "Nest composite states: state Composite { ... }",
          "Use note right of State: text for annotations",
        ],
        example: [
          "stateDiagram-v2",
          "  [*] --> Idle",
          "  Idle --> Processing: submit",
          "  Processing --> Success: complete",
          "  Processing --> Error: fail",
          "  Success --> [*]",
          "  Error --> Idle: retry",
        ].join("\n"),
      },
      erDiagram: {
        hints: [
          "Use ||--o{ for one-to-many, ||--|| for one-to-one",
          "Entity attributes inside {}: Entity { attribute type }",
          "Weak entity with: Entity }o--|| StrongEntity",
          "Use string quotes for multi-word entity names",
        ],
        example: [
          "erDiagram",
          '  CUSTOMER ||--o{ ORDER : "places"',
          '  ORDER ||--o{ LINE_ITEM : "contains"',
          "  CUSTOMER {",
          "    int id PK",
          "    string name",
          "  }",
          "  ORDER {",
          "    int id PK",
          "    date created",
          "  }",
        ].join("\n"),
      },
      gantt: {
        hints: [
          "Set dateFormat first: dateFormat YYYY-MM-DD",
          "Use title for chart title, axisFormat for x-axis style",
          "Task syntax: Task Name, id, startDate, duration",
          "Use crit for critical path tasks",
          "Use milestone for key checkpoints: Milestone, m1, 2024-01-15, 0d",
        ],
        example: [
          "gantt",
          "  title Project Timeline",
          "  dateFormat YYYY-MM-DD",
          "  section Planning",
          "  Research     : r1, 2024-01-01, 7d",
          "  Design       : d1, after r1, 5d",
          "  section Dev",
          "  Frontend     : f1, after d1, 10d",
          "  Backend      : b1, after d1, 10d",
          "  Launch       : m1, after f1, 0d",
        ].join("\n"),
      },
      mindmap: {
        hints: [
          "Use indentation for hierarchy (2 spaces per level)",
          "Root node: root((Title)) or root[Title]",
          "Leaf nodes use plain indent without brackets",
          "Icons: root::icon(fa fa-star) — use sparingly",
          "Keep branches shallow (max 3-4 levels for readability)",
        ],
        example: [
          "mindmap",
          "  root((Project))",
          "    Frontend",
          "      React",
          "      Styling",
          "    Backend",
          "      API",
          "      Database",
          "    DevOps",
          "      CI/CD",
          "      Monitoring",
        ].join("\n"),
      },
      gitGraph: {
        hints: [
          "Use commit for commits, branch for branching",
          "checkout before adding commits to a branch",
          "merge to integrate branches, with optional branch name",
          'Use commit id: "C1" or just commit for auto-id',
          "Cherry-pick: cherry-pick id on other branch (experimental)",
        ],
        example: [
          "gitGraph",
          "  commit",
          "  commit",
          "  branch feature",
          "  checkout feature",
          "  commit",
          "  commit",
          "  checkout main",
          '  merge feature tag: "v1.0"',
        ].join("\n"),
      },
    },
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
      variant: '"default" | "info" | "success" | "warning" | "danger"',
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
    description:
      "Collapsible groups of nested nodes. All items are expanded by default; " +
      "set defaultOpen: false on an item to start it collapsed.",
    props: {
      items:
        "{ title: string; nodes: ArtifactNode[]; defaultOpen?: boolean }[]",
    },
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
  {
    type: "side-by-side",
    label: "Side-by-Side",
    description:
      "Two columns of content rendered side by side for before/after or comparison views.",
    props: {
      left: "ArtifactNode[]",
      right: "ArtifactNode[]",
      leftLabel: "string (optional)",
      rightLabel: "string (optional)",
    },
    example: {
      type: "side-by-side",
      props: {
        leftLabel: "Before",
        rightLabel: "After",
        left: [{ type: "text", props: { text: "Old implementation" } }],
        right: [{ type: "text", props: { text: "New implementation" } }],
      },
    },
  },
  {
    type: "kpi-grid",
    label: "KPI Grid",
    description:
      "Dashboard-style grid of key performance indicators. Each item renders as a stat-card in a responsive grid.",
    props: {
      items:
        "{ label: string; value: string | number; trend?: 'up' | 'down' | 'neutral'; variant?: 'default' | 'info' | 'success' | 'warning' | 'danger' }[]",
      columns: "number (optional, default 2)",
    },
    example: {
      type: "kpi-grid",
      props: {
        columns: 3,
        items: [
          { label: "Files Changed", value: 12, trend: "up" },
          { label: "Lines Added", value: "340", trend: "up" },
          { label: "Tests", value: 8, trend: "neutral" },
        ],
      },
    },
  },
  {
    type: "calldiff-callflow",
    label: "Calldiff Call Flow",
    description:
      "Host-resolved macro node: declares a calldiff call-flow diff/tree/reach analysis embedded in this artifact. The extension runs `calldiff <mode> --format json` against the session git repo while processing the spec and expands this node into a KPI overview, per-entrypoint table, collapsible call trees, and a Raw view tab. All props are optional.",
    props: {
      mode: '"diff" | "tree" | "reach" (optional, default diff)',
      from: "string (optional) — diff: before-ref (default HEAD); tree/reach: the tree ref (default worktree)",
      to: "string (optional) — diff: after-ref (default worktree); unused by tree/reach",
      entry: "string | string[] (optional) — required for tree/reach",
      target: "string (optional) — reach target symbol; required for reach",
      paths: "string[] (optional) — limit analysis to path prefixes",
      maxDepth: "number (optional)",
      file: "string (optional) — diff mode only: keep only complete entry trees containing a changed node in this file (Lens-style filter; matched trees are never pruned)",
      title: "string (optional) — section title override",
      maxEntries: "number (optional, default 8)",
      maxNodesPerTree: "number (optional, default 80)",
      maxMermaidNodes:
        "number (optional, default 25) — larger call trees render ASCII only",
      maxAsciiLines: "number (optional, default 60; 0 = omit code-block)",
    },
    guidelines: [
      "Host-resolved: you declare parameters only — the extension runs the calldiff CLI and replaces this node with rendered KPI/table/tabs/accordion/code-block nodes. Nothing to hand-draw.",
      "Requires a git work tree; requires the calldiff binary on PATH (npx fallback, best-effort).",
      "When calldiff is unavailable or the session is not in a git repo, this node degrades to a 'Call-flow unavailable' callout — the rest of the artifact renders normally.",
      "When nothing changed, it expands to a 'No call-flow changes' callout instead of entry sections.",
      "tree/reach modes require entry; reach additionally requires target.",
      "file filters diff results to entry trees touching that file; in tree/reach modes it degrades to a callout.",
      "Expansion is budget-aware: the host caps maxEntries so the expanded artifact stays within the node limits; extra entrypoints are summarized with an '… N more' note.",
    ],
  },
];

const SUPPORTED_NODE_TYPES = new Set(
  NODE_TYPE_CATALOG.map((entry) => entry.type),
);

const REQUIRED_NODE_PROPS: Record<string, string[]> = {
  text: ["text"],
  heading: ["text", "level"],
  list: ["items"],
  table: ["rows"],
  "code-block": ["code"],
  link: ["text"],
  log: ["lines"],
  badge: ["text"],
  diff: ["before", "after"],
  "stat-card": ["label", "value"],
  "side-by-side": ["left", "right"],
  "kpi-grid": ["items"],
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

/**
 * Node-group keys that hold arrays of nodes directly (one nesting level:
 * `props.nodes`, `props.left`, `props.right`). Single source of truth for
 * the schema's nesting rules — shared with the calldiff-callflow resolver
 * (resolve-calldiff-node.ts) and the validator.
 */
export const NESTED_GROUP_KEYS = ["nodes", "left", "right"] as const;

/**
 * Container keys that hold arrays of `{ ..., nodes }` records (two nesting
 * levels: accordion items, tabs, card-grid cards).
 */
export const CONTAINER_GROUP_KEYS = ["tabs", "items", "cards"] as const;

export function getNestedNodeGroups(
  props: Record<string, unknown>,
): ArtifactNode[][] {
  const groups: ArtifactNode[][] = [];

  for (const key of NESTED_GROUP_KEYS) {
    if (Array.isArray(props[key])) {
      groups.push(props[key] as ArtifactNode[]);
    }
  }

  for (const key of CONTAINER_GROUP_KEYS) {
    const list = props[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (isRecord(item) && Array.isArray(item.nodes)) {
        groups.push(item.nodes as ArtifactNode[]);
      }
    }
  }

  return groups;
}

function countNodes(
  node: ArtifactNode,
  depth: number,
): { count: number; maxDepth: number } {
  let count = 1;
  let maxDepth = depth;

  for (const children of getNestedNodeGroups(node.props ?? {})) {
    for (const child of children) {
      if (isRecord(child) && typeof child.type === "string") {
        const childStats = countNodes(child as ArtifactNode, depth + 1);
        count += childStats.count;
        maxDepth = Math.max(maxDepth, childStats.maxDepth);
      }
    }
  }

  return { count, maxDepth };
}

function validateNodeProps(
  type: string,
  props: Record<string, unknown>,
  errors: string[],
  path?: string,
): void {
  const suffix = path ? ` at ${path}` : "";

  if (!SUPPORTED_NODE_TYPES.has(type)) {
    errors.push(`Unsupported node type: "${type}"${suffix}.`);
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
          `(legacy prop "${legacyName}" is not supported)${suffix}.`,
      );
      continue;
    }

    errors.push(`Node "${type}" requires prop "${propName}"${suffix}.`);
  }

  if (
    type === "table" &&
    props.headers === undefined &&
    props.columns === undefined
  ) {
    errors.push(`Node "table" requires prop "headers" or "columns"${suffix}.`);
  }

  if (
    type === "mermaid" &&
    props.definition === undefined &&
    props.code === undefined
  ) {
    if (props.chart !== undefined) {
      errors.push(
        'Node "mermaid" requires prop "definition" ' +
          `(legacy prop "chart" is not supported)${suffix}.`,
      );
    } else {
      errors.push(`Node "mermaid" requires prop "definition"${suffix}.`);
    }
  }
}

function validateNestedNodes(
  props: Record<string, unknown>,
  parentPath: string,
  errors: string[],
): void {
  const validateGroup = (value: unknown, groupPath: string): void => {
    if (!Array.isArray(value)) return;
    for (const [index, child] of value.entries()) {
      validateNodeTree(child, `${groupPath}.${index}`, errors, true);
    }
  };

  validateGroup(props.nodes, `${parentPath}.props.nodes`);
  validateGroup(props.left, `${parentPath}.props.left`);
  validateGroup(props.right, `${parentPath}.props.right`);

  for (const containerName of CONTAINER_GROUP_KEYS) {
    const containers = props[containerName];
    if (!Array.isArray(containers)) continue;
    for (const [containerIndex, container] of containers.entries()) {
      if (!isRecord(container)) continue;
      validateGroup(
        container.nodes,
        `${parentPath}.props.${containerName}.${containerIndex}.nodes`,
      );
    }
  }
}

function validateNodeTree(
  value: unknown,
  path: string,
  errors: string[],
  includePath: boolean,
): void {
  if (!isRecord(value) || typeof value.type !== "string") {
    errors.push(
      includePath
        ? `Each node must have a type property at ${path}.`
        : "Each node must have a type property.",
    );
    return;
  }

  if (!isRecord(value.props)) {
    errors.push(
      includePath
        ? `Node "${value.type}" is missing props at ${path}.`
        : `Node "${value.type}" is missing props.`,
    );
    return;
  }

  validateNodeProps(
    value.type,
    value.props,
    errors,
    includePath ? path : undefined,
  );
  validateNestedNodes(value.props, path, errors);
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
  let maxNodeDepth = 0;
  for (const [nodeIndex, node] of nodes.entries()) {
    validateNodeTree(node, `nodes.${nodeIndex}`, errors, false);
    if (!isRecord(node) || typeof node.type !== "string") continue;
    const nodeStats = countNodes(node as ArtifactNode, 1);
    totalNodes += nodeStats.count;
    maxNodeDepth = Math.max(maxNodeDepth, nodeStats.maxDepth);
  }

  if (totalNodes > LIMITS.maxTotalNodes) {
    errors.push(
      `Too many total nodes: ${totalNodes} > ${LIMITS.maxTotalNodes}`,
    );
  }

  if (maxNodeDepth > LIMITS.maxNodeDepth) {
    errors.push(
      `Node nesting depth ${maxNodeDepth} exceeds limit ${LIMITS.maxNodeDepth}`,
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
