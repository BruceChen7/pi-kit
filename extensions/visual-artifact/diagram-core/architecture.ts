import {
  layoutArchitectureDiagram,
  orthogonalPath,
} from "./layout/architecture.ts";
import {
  type ArchitectureDiagramInput,
  type ArchitectureEdge,
  type ArchitectureGroup,
  type ArchitectureNode,
  arrowMarker,
  baseSvg,
  COLORS,
  type DiagramError,
  type DiagramRenderOptions,
  type DiagramResult,
  edgeMarkup,
  error,
  isRecord,
  MAX_ARCHITECTURE_NODES,
  nodeArray,
  parseDirection,
  rect,
  resultFromErrors,
  stringValue,
  text,
} from "./shared.ts";

function parseArchitectureInput(props: unknown): {
  input?: ArchitectureDiagramInput;
  errors: DiagramError[];
} {
  if (!isRecord(props))
    return { errors: [error("props", "must be an object")] };
  const nodesRaw = nodeArray(props.nodes);
  const groupsRaw = nodeArray(props.groups) ?? [];
  const edgesRaw = nodeArray(props.edges) ?? [];
  const errors: DiagramError[] = [];
  if (!nodesRaw) errors.push(error("nodes", "must be an array"));
  if (nodesRaw && nodesRaw.length === 0)
    errors.push(error("nodes", "must not be empty"));
  if (nodesRaw && nodesRaw.length > MAX_ARCHITECTURE_NODES)
    errors.push(
      error("nodes", `must contain at most ${MAX_ARCHITECTURE_NODES} nodes`),
    );
  const nodes: ArchitectureNode[] = [];
  const ids = new Set<string>();
  for (const [index, raw] of (nodesRaw ?? []).entries()) {
    if (!isRecord(raw)) {
      errors.push(error(`nodes[${index}]`, "must be an object"));
      continue;
    }
    const id = stringValue(raw.id);
    const nodeLabel = stringValue(raw.label);
    if (!id) errors.push(error(`nodes[${index}].id`, "is required"));
    if (!nodeLabel) errors.push(error(`nodes[${index}].label`, "is required"));
    if (id && ids.has(id))
      errors.push(error(`nodes[${index}].id`, `duplicates node id "${id}"`));
    if (id) ids.add(id);
    const kind = raw.kind;
    if (
      kind !== undefined &&
      !["service", "store", "external", "actor", "queue", "boundary"].includes(
        String(kind),
      )
    )
      errors.push(
        error(`nodes[${index}].kind`, "is not a supported node kind"),
      );
    if (id && nodeLabel)
      nodes.push({
        id,
        label: nodeLabel,
        kind: kind as ArchitectureNode["kind"],
        sublabel: stringValue(raw.sublabel),
        focal: raw.focal === true,
      });
  }
  const groups: ArchitectureGroup[] = [];
  const groupIds = new Set<string>();
  for (const [index, raw] of groupsRaw.entries()) {
    if (!isRecord(raw)) {
      errors.push(error(`groups[${index}]`, "must be an object"));
      continue;
    }
    const id = stringValue(raw.id);
    const groupLabel = stringValue(raw.label);
    const members =
      nodeArray(raw.members)?.filter(
        (member): member is string => typeof member === "string",
      ) ?? [];
    if (!id) errors.push(error(`groups[${index}].id`, "is required"));
    if (!groupLabel)
      errors.push(error(`groups[${index}].label`, "is required"));
    if (id && groupIds.has(id))
      errors.push(error(`groups[${index}].id`, `duplicates group id "${id}"`));
    if (id) groupIds.add(id);
    for (const member of members)
      if (!ids.has(member))
        errors.push(
          error(`groups[${index}].members`, `unknown node "${member}"`),
        );
    if (id && groupLabel) groups.push({ id, label: groupLabel, members });
  }
  const edges: ArchitectureEdge[] = [];
  for (const [index, raw] of edgesRaw.entries()) {
    if (!isRecord(raw)) {
      errors.push(error(`edges[${index}]`, "must be an object"));
      continue;
    }
    const from = stringValue(raw.from);
    const to = stringValue(raw.to);
    if (!from) errors.push(error(`edges[${index}].from`, "is required"));
    if (!to) errors.push(error(`edges[${index}].to`, "is required"));
    if (from && !ids.has(from))
      errors.push(error(`edges[${index}].from`, `unknown node "${from}"`));
    if (to && !ids.has(to))
      errors.push(error(`edges[${index}].to`, `unknown node "${to}"`));
    if (from && to && ids.has(from) && ids.has(to))
      edges.push({
        from,
        to,
        label: stringValue(raw.label),
        style: raw.style as ArchitectureEdge["style"],
      });
  }
  if (errors.length > 0) return { errors };
  return {
    errors,
    input: {
      nodes,
      groups,
      edges,
      direction: parseDirection(props.direction),
      title: stringValue(props.title),
      description: stringValue(props.description),
    },
  };
}

function architectureNodeStyle(kind: ArchitectureNode["kind"]): string {
  if (kind === "store") return `fill="${COLORS.mutedTint}"`;
  if (kind === "external") return `fill="none" stroke-dasharray="5 4"`;
  if (kind === "queue")
    return `fill="${COLORS.mutedTint}" stroke-dasharray="3 3"`;
  return "";
}

function renderArchitectureLayout(
  input: ArchitectureDiagramInput,
  direction: "horizontal" | "vertical",
  options: DiagramRenderOptions,
): DiagramResult {
  const idPrefix = options.idPrefix ?? "architecture";
  const layout = layoutArchitectureDiagram(
    input,
    direction,
    undefined,
    idPrefix,
  );
  let body = arrowMarker(`${idPrefix}-edge`);
  for (const group of input.groups ?? []) {
    const box = layout.groups.get(group.id);
    if (!box) continue;
    body += `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="12" fill="${COLORS.mutedTint}" stroke="${COLORS.border}" stroke-dasharray="6 5"/>`;
    body += text(box.x + 18, box.y + 25, group.label, "eyebrow");
  }
  for (const [index, edge] of layout.edges.entries()) {
    body += edgeMarkup(
      orthogonalPath(edge.points),
      `${idPrefix}-${edge.source.from}-${edge.source.to}-${index}`,
      edge.label?.text,
      edge.source.style,
      `${idPrefix}-edge`,
      edge.label?.point,
    );
  }
  for (const node of input.nodes) {
    const box = layout.nodes.get(node.id);
    if (!box) continue;
    body += rect(
      box,
      `${architectureNodeStyle(node.kind)} ${node.focal ? `stroke="${COLORS.accent}" stroke-width="2"` : ""}`,
    );
    body += text(
      box.x + box.width - 12,
      box.y + 16,
      (node.kind ?? "component").toUpperCase(),
      "eyebrow",
      "end",
    );
    body += text(box.x + 14, box.y + (node.sublabel ? 30 : 35), node.label);
    if (node.sublabel)
      body += text(box.x + 14, box.y + 50, node.sublabel, "sub");
  }
  return {
    ok: true,
    value: {
      svg: baseSvg(
        idPrefix,
        input.title ?? options.title ?? "Architecture diagram",
        input.description ??
          options.description ??
          "Components, boundaries, and connections.",
        Math.ceil(layout.bounds.width),
        Math.ceil(layout.bounds.height),
        body,
      ),
      width: Math.ceil(layout.bounds.width),
      height: Math.ceil(layout.bounds.height),
      warnings: layout.warnings,
    },
  };
}

export function renderArchitectureDiagram(
  props: unknown,
  options: DiagramRenderOptions = {},
): DiagramResult {
  const parsed = parseArchitectureInput(props);
  if (parsed.errors.length > 0 || !parsed.input)
    return resultFromErrors(parsed.errors);
  const input = parsed.input;
  const direction = input.direction ?? options.direction ?? "horizontal";
  return renderArchitectureLayout(input, direction, options);
}

export function validateArchitectureProps(props: unknown): DiagramError[] {
  return parseArchitectureInput(props).errors;
}
