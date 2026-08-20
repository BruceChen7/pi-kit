import type {
  ArchitectureDiagramInput,
  ArchitectureEdge,
  ArchitectureNode,
  Box,
  DiagramDirection,
  Point,
} from "../shared.ts";

export type ArchitectureLayoutTheme = {
  canvasPadding: number;
  groupPadding: number;
  groupHeader: number;
  groupGap: number;
  nodeGap: number;
  laneGap: number;
  minNodeWidth: number;
  maxNodeWidth: number;
  nodeHeight: number;
  nodeHeightWithSublabel: number;
  labelClearance: number;
};

export const ARCHITECTURE_THEME: ArchitectureLayoutTheme = {
  canvasPadding: 28,
  groupPadding: 28,
  groupHeader: 44,
  groupGap: 36,
  nodeGap: 28,
  laneGap: 112,
  minNodeWidth: 180,
  maxNodeWidth: 300,
  nodeHeight: 56,
  nodeHeightWithSublabel: 68,
  labelClearance: 8,
};

export type LayoutLabel = {
  text: string;
  box: Box;
  point: Point;
  edgeId: string;
};

export type LayoutEdge = {
  source: ArchitectureEdge;
  points: Point[];
  label?: LayoutLabel;
};

export type ArchitectureLayout = {
  direction: DiagramDirection;
  nodes: Map<string, Box>;
  groups: Map<string, Box>;
  edges: LayoutEdge[];
  bounds: Box;
  warnings: string[];
};

function textWidth(value: string, mono = false): number {
  return value.length * (mono ? 6.2 : 8.1);
}

function nodeSize(node: ArchitectureNode, theme: ArchitectureLayoutTheme): Box {
  const kind = (node.kind ?? "component").toUpperCase();
  const contentWidth = Math.max(
    textWidth(node.label),
    node.sublabel ? textWidth(node.sublabel, true) : 0,
  );
  const width = Math.max(
    theme.minNodeWidth,
    Math.min(theme.maxNodeWidth, contentWidth + textWidth(kind, true) + 58),
  );
  return {
    x: 0,
    y: 0,
    width,
    height: node.sublabel ? theme.nodeHeightWithSublabel : theme.nodeHeight,
  };
}

function placeVertical<T>(
  items: T[],
  x: number,
  y: number,
  gap: number,
  sizes: (item: T) => Box,
): Array<{ item: T; box: Box }> {
  let cursor = y;
  return items.map((item) => {
    const size = sizes(item);
    const box = { ...size, x, y: cursor };
    cursor += size.height + gap;
    return { item, box };
  });
}

function center(box: Box): Point {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function routeEdge(from: Box, to: Box, direction: DiagramDirection): Point[] {
  const fromRight = from.x + from.width;
  const fromBottom = from.y + from.height;
  const toRight = to.x + to.width;
  const toBottom = to.y + to.height;
  if (to.x >= fromRight) {
    const start = { x: fromRight, y: center(from).y };
    const end = { x: to.x, y: center(to).y };
    const mid = (start.x + end.x) / 2;
    return [start, { x: mid, y: start.y }, { x: mid, y: end.y }, end];
  }
  if (toRight <= from.x) {
    const start = { x: from.x, y: center(from).y };
    const end = { x: toRight, y: center(to).y };
    const mid = (start.x + end.x) / 2;
    return [start, { x: mid, y: start.y }, { x: mid, y: end.y }, end];
  }
  if (to.y >= fromBottom) {
    const start = { x: center(from).x, y: fromBottom };
    const end = { x: center(to).x, y: to.y };
    const mid = (start.y + end.y) / 2;
    return [start, { x: start.x, y: mid }, { x: end.x, y: mid }, end];
  }
  if (toBottom <= from.y) {
    const start = { x: center(from).x, y: from.y };
    const end = { x: center(to).x, y: toBottom };
    const mid = (start.y + end.y) / 2;
    return [start, { x: start.x, y: mid }, { x: end.x, y: mid }, end];
  }
  // Invalid overlapping inputs still get a deterministic path.
  return direction === "vertical"
    ? [
        { x: center(from).x, y: fromBottom },
        { x: center(to).x, y: to.y },
      ]
    : [
        { x: fromRight, y: center(from).y },
        { x: to.x, y: center(to).y },
      ];
}

function labelForPath(
  edge: ArchitectureEdge,
  points: Point[],
  edgeId: string,
  theme: ArchitectureLayoutTheme,
): LayoutLabel | undefined {
  if (!edge.label) return undefined;
  const label = edge.label.trim().slice(0, 28);
  const width = Math.max(34, textWidth(label, true) + 16);
  const horizontal = points
    .map((point, index) => {
      const next = points[index + 1];
      return next &&
        Math.abs(next.x - point.x) > Math.abs(next.y - point.y) &&
        Math.abs(next.x - point.x) >= width + theme.labelClearance * 2
        ? { point, next, length: Math.abs(next.x - point.x) }
        : undefined;
    })
    .filter(Boolean)
    .sort((a, b) => (b?.length ?? 0) - (a?.length ?? 0))[0];
  const vertical = points
    .map((point, index) => {
      const next = points[index + 1];
      return next && Math.abs(next.y - point.y) > Math.abs(next.x - point.x)
        ? { point, next, length: Math.abs(next.y - point.y) }
        : undefined;
    })
    .filter(Boolean)
    .sort((a, b) => (b?.length ?? 0) - (a?.length ?? 0))[0];
  if (horizontal) {
    const point = {
      x: (horizontal.point.x + horizontal.next.x) / 2,
      y: horizontal.point.y - theme.labelClearance - 7,
    };
    return {
      text: label,
      point,
      edgeId,
      box: { x: point.x - width / 2, y: point.y - 12, width, height: 15 },
    };
  }
  if (vertical) {
    // A routed vertical edge has two short vertical legs separated by a
    // horizontal elbow. Treat them as one label lane; choosing either leg's
    // midpoint can place the mask against the source node.
    const ys = points.map((point) => point.y);
    const laneY = (Math.min(...ys) + Math.max(...ys)) / 2;
    const point = {
      x: vertical.point.x + theme.labelClearance + width / 2,
      y: laneY,
    };
    return {
      text: label,
      point,
      edgeId,
      box: { x: point.x - width / 2, y: point.y - 12, width, height: 15 },
    };
  }
  return undefined;
}

function overlaps(a: Box, b: Box, clearance = 0): boolean {
  return !(
    a.x + a.width + clearance <= b.x ||
    b.x + b.width + clearance <= a.x ||
    a.y + a.height + clearance <= b.y ||
    b.y + b.height + clearance <= a.y
  );
}

function boundsOf(boxes: Box[], padding: number): Box {
  if (boxes.length === 0) return { x: 0, y: 0, width: 420, height: 180 };
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return {
    x: left - padding,
    y: top - padding,
    width: Math.max(420, right - left + padding * 2),
    height: Math.max(180, bottom - top + padding * 2),
  };
}

function segmentIntersectsBox(a: Point, b: Point, box: Box): boolean {
  if (a.x === b.x)
    return (
      a.x > box.x &&
      a.x < box.x + box.width &&
      Math.max(Math.min(a.y, b.y), box.y) <
        Math.min(Math.max(a.y, b.y), box.y + box.height)
    );
  if (a.y === b.y)
    return (
      a.y > box.y &&
      a.y < box.y + box.height &&
      Math.max(Math.min(a.x, b.x), box.x) <
        Math.min(Math.max(a.x, b.x), box.x + box.width)
    );
  return false;
}

export function verifyArchitectureLayout(layout: ArchitectureLayout): string[] {
  const warnings: string[] = [];
  const nodes = [...layout.nodes.entries()];
  for (let index = 0; index < nodes.length; index += 1) {
    for (let other = index + 1; other < nodes.length; other += 1) {
      if (overlaps(nodes[index][1], nodes[other][1]))
        warnings.push(
          `nodes "${nodes[index][0]}" and "${nodes[other][0]}" overlap`,
        );
    }
  }
  const labels = layout.edges.flatMap((edge) =>
    edge.label ? [edge.label] : [],
  );
  for (let index = 0; index < labels.length; index += 1) {
    for (const [nodeId, node] of nodes) {
      if (overlaps(labels[index].box, node))
        warnings.push(
          `edge label "${labels[index].text}" overlaps node "${nodeId}"`,
        );
    }
    for (let other = index + 1; other < labels.length; other += 1) {
      if (overlaps(labels[index].box, labels[other].box))
        warnings.push(
          `edge labels "${labels[index].text}" and "${labels[other].text}" overlap`,
        );
    }
  }
  for (const edge of layout.edges) {
    for (let index = 0; index < edge.points.length - 1; index += 1) {
      for (const [nodeId, node] of nodes) {
        if (nodeId === edge.source.from || nodeId === edge.source.to) continue;
        if (
          segmentIntersectsBox(edge.points[index], edge.points[index + 1], node)
        )
          warnings.push(
            `edge "${edge.source.from} → ${edge.source.to}" crosses node "${nodeId}"`,
          );
      }
    }
  }
  return warnings;
}

export function layoutArchitectureDiagram(
  input: ArchitectureDiagramInput,
  direction: DiagramDirection,
  theme: ArchitectureLayoutTheme = ARCHITECTURE_THEME,
  idPrefix = "architecture",
): ArchitectureLayout {
  const nodes = new Map<string, Box>();
  const groups = new Map<string, Box>();
  const grouped = new Set(
    input.groups?.flatMap((group) => group.members) ?? [],
  );
  const ungrouped = input.nodes.filter((node) => !grouped.has(node.id));
  const sizeOf = (node: ArchitectureNode) => nodeSize(node, theme);
  const warnings: string[] = [];

  const groupStartX =
    direction === "horizontal" && ungrouped.length > 0
      ? theme.canvasPadding +
        Math.max(...ungrouped.map((node) => sizeOf(node).width), 220) +
        theme.laneGap
      : theme.canvasPadding;
  let cursorY = 62;
  for (const group of input.groups ?? []) {
    const members = group.members
      .map((id) => input.nodes.find((node) => node.id === id))
      .filter((node): node is ArchitectureNode => Boolean(node));
    const memberRows = placeVertical(
      members,
      groupStartX + theme.groupPadding,
      cursorY + theme.groupHeader,
      theme.nodeGap,
      sizeOf,
    );
    for (const row of memberRows) nodes.set(row.item.id, row.box);
    const memberBottom = memberRows.at(-1)?.box;
    const groupHeight = Math.max(
      148,
      (memberBottom
        ? memberBottom.y + memberBottom.height - cursorY
        : theme.groupHeader) + theme.groupPadding,
    );
    groups.set(group.id, {
      x: groupStartX,
      y: cursorY,
      width: Math.max(
        300,
        Math.max(...memberRows.map((row) => row.box.width), 244) +
          theme.groupPadding * 2,
      ),
      height: groupHeight,
    });
    cursorY += groupHeight + theme.groupGap;
  }

  if (direction === "horizontal" && input.groups?.length && ungrouped.length) {
    const groupRight = Math.max(
      ...[...groups.values()].map((box) => box.x + box.width),
    );
    const outgoing = new Set((input.edges ?? []).map((edge) => edge.from));
    const incoming = new Set((input.edges ?? []).map((edge) => edge.to));
    const left = ungrouped.filter(
      (node) => outgoing.has(node.id) && !incoming.has(node.id),
    );
    const right = ungrouped.filter(
      (node) => incoming.has(node.id) && !outgoing.has(node.id),
    );
    const unclassified = ungrouped.filter(
      (node) => !left.includes(node) && !right.includes(node),
    );
    unclassified.forEach((node, index) => {
      (index % 2 ? right : left).push(node);
    });
    for (const row of placeVertical(
      left,
      theme.canvasPadding,
      104,
      theme.nodeGap,
      sizeOf,
    ))
      nodes.set(row.item.id, row.box);
    for (const row of placeVertical(
      right,
      groupRight + theme.laneGap,
      104,
      theme.nodeGap,
      sizeOf,
    ))
      nodes.set(row.item.id, row.box);
  } else {
    const columns = direction === "vertical" ? 1 : 3;
    ungrouped.forEach((node, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const size = sizeOf(node);
      nodes.set(node.id, {
        ...size,
        x: theme.canvasPadding + column * (size.width + theme.nodeGap),
        y: (groups.size ? cursorY : 62) + row * (size.height + theme.nodeGap),
      });
    });
  }

  const edges: LayoutEdge[] = [];
  for (const [index, edge] of (input.edges ?? []).entries()) {
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (!from || !to) continue;
    const points = routeEdge(from, to, direction);
    const edgeId = `${idPrefix}-${edge.from}-${edge.to}-${index}`;
    edges.push({
      source: edge,
      points,
      label: labelForPath(edge, points, edgeId, theme),
    });
  }

  const nodeBoxes = [...nodes.values()];
  const groupBoxes = [...groups.values()];
  const labelBoxes = edges.flatMap((edge) =>
    edge.label ? [edge.label.box] : [],
  );
  const provisional: ArchitectureLayout = {
    direction,
    nodes,
    groups,
    edges,
    bounds: boundsOf(
      [...nodeBoxes, ...groupBoxes, ...labelBoxes],
      theme.canvasPadding,
    ),
    warnings: [],
  };
  warnings.push(...verifyArchitectureLayout(provisional));
  if (edges.length > 32)
    warnings.push("diagram exceeds the recommended edge budget");
  return {
    direction,
    nodes,
    groups,
    edges,
    bounds: provisional.bounds,
    warnings,
  };
}

export function orthogonalPath(points: Point[]): string {
  if (points.length === 0) return "";
  return points.reduce(
    (path, point, index) =>
      index === 0
        ? `M ${point.x} ${point.y}`
        : `${path} L ${point.x} ${point.y}`,
    "",
  );
}
