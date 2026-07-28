type LooseArtifactNode = {
  type: string;
  props?: Record<string, unknown>;
  children?: unknown;
  metadata?: { id?: string; label?: string };
};

export type Dataset = unknown[];

export type UiArtifactNode = {
  type: string;
  props: Record<string, unknown>;
  metadata?: { id?: string; label?: string };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toNodeArray(value: unknown): LooseArtifactNode[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry): LooseArtifactNode[] => {
    if (!isRecord(entry) || typeof entry.type !== "string") {
      return [];
    }
    return [entry as LooseArtifactNode];
  });
}

function normalizeHeadingLevel(level: unknown): string {
  if (typeof level === "number" && Number.isInteger(level)) {
    return `h${Math.min(4, Math.max(1, level))}`;
  }

  if (typeof level === "string") {
    const normalized = level.trim().toLowerCase();
    if (["h1", "h2", "h3", "h4"].includes(normalized)) {
      return normalized;
    }
    if (/^[1-4]$/u.test(normalized)) {
      return `h${normalized}`;
    }
  }

  return "h2";
}

function normalizeTextSize(size: unknown): string {
  if (typeof size !== "string") {
    return "md";
  }

  const normalized = size.trim().toLowerCase();
  if (normalized === "base") {
    return "md";
  }
  if (["sm", "md", "lg", "xl"].includes(normalized)) {
    return normalized;
  }

  return "md";
}

function isMdTable(text: string): boolean {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 2) return false;
  // First line must start with |
  if (!lines[0].trim().startsWith("|")) return false;
  // Second line must be a separator row: |---|---|
  const sep = lines[1].trim();
  if (!sep.startsWith("|") || !sep.endsWith("|")) return false;
  return /^\|[|\- :]+\|$/u.test(sep);
}

function parseMdTable(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const headers = lines[0]
    .split("|")
    .map((c) => c.trim())
    .filter(Boolean);
  const rows: string[][] = [];
  for (let i = 2; i < lines.length; i += 1) {
    const cells = lines[i]
      .split("|")
      .map((c) => c.trim())
      .filter(Boolean);
    if (cells.length > 0) {
      rows.push(cells);
    }
  }
  return { headers, rows };
}

function createTableFromMd(text: string): UiArtifactNode {
  const { headers, rows } = parseMdTable(text);
  return { type: "table", props: { headers, rows } };
}

function createTextNode(text: string): UiArtifactNode {
  return {
    type: "text",
    props: {
      text,
      size: "md",
    },
  };
}

function normalizeAccordionItems(
  value: unknown,
  data?: Record<string, Dataset>,
): unknown {
  if (!Array.isArray(value)) {
    return value;
  }

  return value.map((item) => {
    if (!isRecord(item)) {
      return item;
    }

    const nodes = Array.isArray(item.nodes)
      ? normalizeArtifactNodes(item.nodes, data)
      : normalizeArtifactNodes(item.children, data);

    return {
      ...item,
      nodes,
    };
  });
}

function normalizeTabs(
  value: unknown,
  data?: Record<string, Dataset>,
): unknown {
  if (!Array.isArray(value)) {
    return value;
  }

  return value.map((tab) => {
    if (!isRecord(tab)) {
      return tab;
    }

    const nodes = Array.isArray(tab.nodes)
      ? normalizeArtifactNodes(tab.nodes, data)
      : normalizeArtifactNodes(tab.children, data);

    return {
      ...tab,
      nodes,
    };
  });
}

function normalizeCardGridCards(
  value: unknown,
  data?: Record<string, Dataset>,
): unknown {
  if (!Array.isArray(value)) {
    return value;
  }

  return value.map((card) => {
    if (!isRecord(card)) {
      return card;
    }

    const nodes = Array.isArray(card.nodes)
      ? normalizeArtifactNodes(card.nodes, data)
      : normalizeArtifactNodes(card.children, data);

    if (nodes.length > 0) {
      return {
        ...card,
        nodes,
      };
    }

    if (typeof card.content === "string" && card.content.trim().length > 0) {
      return {
        ...card,
        nodes: [
          isMdTable(card.content)
            ? createTableFromMd(card.content)
            : createTextNode(card.content),
        ],
      };
    }

    return card;
  });
}

export function normalizeArtifactNode(
  node: LooseArtifactNode,
  data?: Record<string, Dataset>,
): UiArtifactNode {
  let type = node.type;
  const props = isRecord(node.props) ? { ...node.props } : {};
  const children = normalizeArtifactNodes(node.children, data);

  if (type === "separator") {
    type = "divider";
  }

  if (type === "heading") {
    props.level = normalizeHeadingLevel(props.level);
  }

  if (type === "text") {
    props.size = normalizeTextSize(props.size);
  }

  if (type === "mermaid") {
    if (
      typeof props.definition !== "string" &&
      typeof props.code === "string"
    ) {
      props.definition = props.code;
    }
  }

  if (type === "badge") {
    if (typeof props.text !== "string" && typeof props.label === "string") {
      props.text = props.label;
    }
  }

  if (type === "link") {
    if (typeof props.text !== "string" && typeof props.label === "string") {
      props.text = props.label;
    }
  }

  if (type === "callout") {
    if (typeof props.text !== "string" && typeof props.content === "string") {
      props.text = props.content;
    }
    if (typeof props.variant !== "string" && typeof props.type === "string") {
      props.variant = props.type;
    }
  }

  if (type === "quote" || type === "blockquote") {
    if (typeof props.text !== "string" && typeof props.content === "string") {
      props.text = props.content;
    }
  }

  if (type === "card" || type === "section") {
    const propNodes = normalizeArtifactNodes(props.nodes, data);
    const contentNodes = normalizeArtifactNodes(props.content, data);

    if (propNodes.length > 0) {
      props.nodes = propNodes;
    } else if (children.length > 0) {
      props.nodes = children;
    } else if (contentNodes.length > 0) {
      props.nodes = contentNodes;
    } else if (
      typeof props.content === "string" &&
      props.content.trim().length > 0
    ) {
      if (isMdTable(props.content)) {
        props.nodes = [createTableFromMd(props.content)];
      } else {
        props.nodes = [createTextNode(props.content)];
      }
    }
  }

  if (type === "accordion") {
    props.items = normalizeAccordionItems(props.items, data);
  }

  if (type === "tabs") {
    props.tabs = normalizeTabs(props.tabs, data);
  }

  if (type === "card-grid") {
    props.cards = normalizeCardGridCards(props.cards, data);
  }

  const normalized: UiArtifactNode = {
    type,
    props,
    ...(node.metadata ? { metadata: node.metadata } : {}),
  };

  // Table aliasing and data resolution
  if (type === "data-table" || type === "comparison-table") {
    normalized.type = "table";
  }

  if (normalized.type === "table") {
    // Preserve caption and statusKey
    if (typeof normalized.props.statusKey === "string") {
      normalized.props.caption =
        normalized.props.caption ?? normalized.props.statusKey;
    }
    return resolveTableFromData(data, normalized);
  }

  return normalized;
}

function resolveTableFromData(
  data: Record<string, Dataset> | undefined,
  node: UiArtifactNode,
): UiArtifactNode {
  const props = node.props;

  // Already has inline headers+rows, nothing to resolve
  if (Array.isArray(props.headers)) {
    return node;
  }

  const dataKey = typeof props.dataKey === "string" ? props.dataKey : undefined;
  const columns = Array.isArray(props.columns) ? props.columns : undefined;

  if (!dataKey || !columns || !data || !Array.isArray(data[dataKey])) {
    return node;
  }

  const rows = data[dataKey] as Record<string, unknown>[];
  const headers: string[] = columns.map((col: unknown) => {
    if (isRecord(col) && typeof col.label === "string") {
      return col.label;
    }
    if (isRecord(col) && typeof col.key === "string") {
      return col.key;
    }
    if (isRecord(col) && typeof col.header === "string") {
      return col.header;
    }
    return String(col);
  });

  const resolvedRows: string[][] = rows.map((row: Record<string, unknown>) =>
    columns.map((col: unknown) => {
      const key =
        isRecord(col) && typeof col.key === "string" ? col.key : String(col);
      return row[key] !== undefined ? String(row[key]) : "";
    }),
  );

  const caption = typeof props.caption === "string" ? props.caption : undefined;

  return {
    ...node,
    props: { headers, rows: resolvedRows, ...(caption ? { caption } : {}) },
  };
}

export function normalizeArtifactNodes(
  value: unknown,
  data?: Record<string, Dataset>,
): UiArtifactNode[] {
  return toNodeArray(value).map((node) => normalizeArtifactNode(node, data));
}
