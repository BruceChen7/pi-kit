export type DiagramDirection = "horizontal" | "vertical";

export type DiagramRenderResult = {
  svg: string;
  width: number;
  height: number;
};

export type DiagramError = {
  path: string;
  message: string;
};

export type DiagramResult =
  | { ok: true; value: DiagramRenderResult }
  | { ok: false; errors: DiagramError[] };

export type DiagramRenderOptions = {
  idPrefix?: string;
  direction?: DiagramDirection;
  title?: string;
  description?: string;
};

export type ErField = {
  name: string;
  type?: string;
  key?: "PK" | "FK" | "UK";
};

export type ErEntity = {
  id: string;
  name?: string;
  fields: ErField[];
};

export type ErRelationship = {
  from: string;
  to: string;
  label?: string;
  cardinality?: "one-to-one" | "one-to-many" | "many-to-many";
};

export type ErDiagramInput = {
  entities: ErEntity[];
  relationships: ErRelationship[];
  direction?: DiagramDirection;
  title?: string;
  description?: string;
};

export type ArchitectureNode = {
  id: string;
  label: string;
  kind?: "service" | "store" | "external" | "actor" | "queue" | "boundary";
  sublabel?: string;
  focal?: boolean;
};

export type ArchitectureGroup = {
  id: string;
  label: string;
  members: string[];
};

export type ArchitectureEdge = {
  from: string;
  to: string;
  label?: string;
  style?: "solid" | "dashed" | "dotted";
};

export type ArchitectureDiagramInput = {
  nodes: ArchitectureNode[];
  groups?: ArchitectureGroup[];
  edges?: ArchitectureEdge[];
  direction?: DiagramDirection;
  title?: string;
  description?: string;
};

export type LayerItem = {
  id: string;
  label: string;
  kind?: "service" | "store" | "external" | "platform";
  focal?: boolean;
};

export type Layer = {
  id: string;
  label: string;
  items: Array<string | LayerItem>;
};

export type LayerEdge = {
  from: string;
  to: string;
  label?: string;
  style?: "solid" | "dashed" | "dotted";
};

export type LayerDiagramInput = {
  layers: Layer[];
  edges?: LayerEdge[];
  direction?: DiagramDirection;
  title?: string;
  description?: string;
};

export type Point = { x: number; y: number };
export type Box = { x: number; y: number; width: number; height: number };

export const COLORS = {
  paper: "var(--card, #ffffff)",
  ink: "var(--foreground, #141413)",
  muted: "var(--muted-foreground, #6b6a63)",
  border: "var(--border, #d1cfc5)",
  accent: "var(--clay, #d97757)",
  accentTint: "color-mix(in srgb, var(--clay, #d97757) 12%, transparent)",
  mutedTint: "color-mix(in srgb, var(--muted, #f0eee6) 72%, transparent)",
};

export const FONT_SANS = "var(--font-sans, Inter, Arial, sans-serif)";
export const FONT_MONO = "var(--font-mono, ui-monospace, monospace)";
export const MAX_LABEL = 42;
export const MAX_ENTITIES = 24;
export const MAX_ARCHITECTURE_NODES = 32;
export const MAX_LAYERS = 12;
export const MAX_ITEMS_PER_LAYER = 16;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function safeId(value: string, fallback = "diagram"): string {
  const normalized = value
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

export function label(value: string, max = MAX_LABEL): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

export function error(path: string, message: string): DiagramError {
  return { path, message };
}

export function nodeArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

export function parseDirection(value: unknown): DiagramDirection | undefined {
  return value === "horizontal" || value === "vertical" ? value : undefined;
}

export function baseSvg(
  idPrefix: string,
  title: string,
  description: string,
  width: number,
  height: number,
  body: string,
): string {
  const id = safeId(idPrefix, "diagram");
  const titleId = `${id}-title`;
  const descId = `${id}-desc`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="${titleId} ${descId}"><title id="${titleId}">${escapeXml(title)}</title><desc id="${descId}">${escapeXml(description)}</desc><style>text{font-family:${FONT_SANS};fill:${COLORS.ink}}.sub{font-family:${FONT_MONO};font-size:11px;fill:${COLORS.muted}}.eyebrow{font-family:${FONT_MONO};font-size:10px;letter-spacing:1px;text-transform:uppercase;fill:${COLORS.muted}}.edge-label{font-family:${FONT_MONO};font-size:10px;fill:${COLORS.muted}}</style>${body}</svg>`;
}

export function rect(box: Box, attrs = ""): string {
  return `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="8" fill="${COLORS.paper}" stroke="${COLORS.border}" stroke-width="1.5" ${attrs}/>`;
}

export function text(
  x: number,
  y: number,
  value: string,
  className = "",
  anchor = "start",
): string {
  return `<text x="${x}" y="${y}" class="${className}" text-anchor="${anchor}">${escapeXml(label(value))}</text>`;
}

export function arrowMarker(id: string): string {
  return `<defs><marker id="${safeId(id)}-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="${COLORS.muted}"/></marker></defs>`;
}

export function edgePath(
  from: Box,
  to: Box,
  direction: DiagramDirection,
): string {
  const fromRight = from.x + from.width;
  const fromBottom = from.y + from.height;
  const toRight = to.x + to.width;
  const toBottom = to.y + to.height;
  const isBelow = to.y >= fromBottom;
  const isAbove = toBottom <= from.y;
  const isRight = to.x >= fromRight;
  const isLeft = toRight <= from.x;

  if (isBelow) {
    const start = { x: from.x + from.width / 2, y: fromBottom };
    const end = { x: to.x + to.width / 2, y: to.y };
    const midY = (start.y + end.y) / 2;
    return `M ${start.x} ${start.y} V ${midY} H ${end.x} V ${end.y}`;
  }
  if (isAbove) {
    const start = { x: from.x + from.width / 2, y: from.y };
    const end = { x: to.x + to.width / 2, y: toBottom };
    const midY = (start.y + end.y) / 2;
    return `M ${start.x} ${start.y} V ${midY} H ${end.x} V ${end.y}`;
  }
  if (isRight) {
    const start = { x: fromRight, y: from.y + from.height / 2 };
    const end = { x: to.x, y: to.y + to.height / 2 };
    const midX = (start.x + end.x) / 2;
    return `M ${start.x} ${start.y} H ${midX} V ${end.y} H ${end.x}`;
  }
  if (isLeft) {
    const start = { x: from.x, y: from.y + from.height / 2 };
    const end = { x: toRight, y: to.y + to.height / 2 };
    const midX = (start.x + end.x) / 2;
    return `M ${start.x} ${start.y} H ${midX} V ${end.y} H ${end.x}`;
  }

  // Overlapping boxes are malformed or intentionally layered. Preserve the
  // requested axis as a deterministic fallback rather than drawing through a
  // box using the old direction-only attachment rule.
  if (direction === "vertical") {
    const start = { x: from.x + from.width / 2, y: fromBottom };
    const end = { x: to.x + to.width / 2, y: to.y };
    const midY = (start.y + end.y) / 2;
    return `M ${start.x} ${start.y} V ${midY} H ${end.x} V ${end.y}`;
  }
  const start = { x: fromRight, y: from.y + from.height / 2 };
  const end = { x: to.x, y: to.y + to.height / 2 };
  const midX = (start.x + end.x) / 2;
  return `M ${start.x} ${start.y} H ${midX} V ${end.y} H ${end.x}`;
}

export function edgeLabelPoint(
  from: Box,
  to: Box,
  direction: DiagramDirection,
): Point {
  const fromRight = from.x + from.width;
  const fromBottom = from.y + from.height;
  const toRight = to.x + to.width;
  const toBottom = to.y + to.height;
  const isBelow = to.y >= fromBottom;
  const isAbove = toBottom <= from.y;
  const isRight = to.x >= fromRight;
  const isLeft = toRight <= from.x;

  if (isBelow || isAbove) {
    return {
      x: (from.x + from.width / 2 + to.x + to.width / 2) / 2,
      y: (isBelow ? fromBottom + to.y : toBottom + from.y) / 2,
    };
  }
  if (isRight || isLeft) {
    return {
      x: (isRight ? fromRight + to.x : toRight + from.x) / 2,
      // Put the label on the routed horizontal lane instead of above the
      // nodes. edgeMarkup paints a paper-colored backing, so the connector
      // remains legible without the label drifting into group headings.
      y: (from.y + from.height / 2 + to.y + to.height / 2) / 2 + 3,
    };
  }
  return direction === "vertical"
    ? { x: (from.x + to.x) / 2, y: (fromBottom + to.y) / 2 }
    : { x: (fromRight + to.x) / 2, y: Math.min(from.y, to.y) - 6 };
}

export function edgeMarkup(
  path: string,
  id: string,
  labelValue?: string,
  style: string = "solid",
  markerId = id,
  labelPoint: Point = { x: 12, y: 18 },
): string {
  const dash =
    style === "dashed"
      ? ' stroke-dasharray="7 5"'
      : style === "dotted"
        ? ' stroke-dasharray="2 4"'
        : "";
  const labelText = labelValue ? label(labelValue, 28) : "";
  const labelWidth = Math.max(34, labelText.length * 6 + 12);
  const labelMarkup = labelValue
    ? `<rect x="${labelPoint.x - labelWidth / 2}" y="${labelPoint.y - 12}" width="${labelWidth}" height="15" rx="3" fill="${COLORS.paper}" opacity="0.94"/><text x="${labelPoint.x}" y="${labelPoint.y}" class="edge-label" text-anchor="middle"><tspan>${escapeXml(labelText)}</tspan></text>`
    : "";
  return `<g data-edge="${safeId(id)}"><path d="${path}" fill="none" stroke="${COLORS.muted}" stroke-width="1.5" marker-end="url(#${safeId(markerId)}-arrow)"${dash}/>${labelMarkup}</g>`;
}

export function positionInGrid<T>(
  items: T[],
  columns: number,
  width: number,
  height: number,
  gapX: number,
  gapY: number,
  originX = 24,
  originY = 56,
): Array<{ item: T; box: Box }> {
  return items.map((item, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    return {
      item,
      box: {
        x: originX + column * (width + gapX),
        y: originY + row * (height + gapY),
        width,
        height,
      },
    };
  });
}

export function resultFromErrors(errors: DiagramError[]): DiagramResult {
  return { ok: false, errors };
}
