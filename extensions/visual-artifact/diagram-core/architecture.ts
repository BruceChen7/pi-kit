import {
  type ArchitectureDiagramInput,
  type ArchitectureEdge,
  type ArchitectureGroup,
  type ArchitectureNode,
  arrowMarker,
  type Box,
  baseSvg,
  COLORS,
  type DiagramError,
  type DiagramRenderOptions,
  type DiagramResult,
  edgeLabelPoint,
  edgeMarkup,
  edgePath,
  error,
  escapeXml,
  isRecord,
  label,
  MAX_ARCHITECTURE_NODES,
  nodeArray,
  parseDirection,
  positionInGrid,
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

export function renderArchitectureDiagram(
  props: unknown,
  options: DiagramRenderOptions = {},
): DiagramResult {
  const parsed = parseArchitectureInput(props);
  if (parsed.errors.length > 0 || !parsed.input)
    return resultFromErrors(parsed.errors);
  const input = parsed.input;
  const direction = input.direction ?? options.direction ?? "horizontal";
  const groups = input.groups ?? [];
  const groupedIds = new Set(groups.flatMap((group) => group.members));
  const ungrouped = input.nodes.filter((node) => !groupedIds.has(node.id));
  const horizontalWithGroups =
    direction === "horizontal" && groups.length > 0 && ungrouped.length > 0;
  // Leave a real routing lane between external nodes and grouped content.
  // Edge labels are rendered inside this lane, so a narrow gap makes their
  // background collide with both node borders (and becomes especially noisy
  // after the SVG is scaled to a wide viewport).
  const externalLaneWidth = 96;
  const groupOriginX = horizontalWithGroups ? 24 + 220 + externalLaneWidth : 24;
  const groupBoxes = positionInGrid(
    groups,
    direction === "vertical" ? 1 : Math.min(2, Math.max(1, groups.length)),
    300,
    148,
    52,
    42,
    groupOriginX,
    62,
  );
  const nodeBoxes = new Map<string, Box>();
  let maxGroupBottom = 0;
  let maxGroupRight = 0;
  let groupBody = "";
  for (const { item: group, box } of groupBoxes) {
    const members = group.members
      .map((member) => input.nodes.find((node) => node.id === member))
      .filter((node): node is ArchitectureNode => Boolean(node));
    const memberPositions = positionInGrid(
      members,
      1,
      244,
      48,
      0,
      28,
      box.x + 28,
      box.y + 46,
    );
    const lastMember = memberPositions.at(-1)?.box;
    const groupHeight = Math.max(
      box.height,
      lastMember ? lastMember.y + lastMember.height - box.y + 28 : 0,
    );
    const groupBox = { ...box, height: groupHeight };
    maxGroupBottom = Math.max(maxGroupBottom, groupBox.y + groupBox.height);
    maxGroupRight = Math.max(maxGroupRight, groupBox.x + groupBox.width);
    groupBody += `<rect x="${groupBox.x}" y="${groupBox.y}" width="${groupBox.width}" height="${groupBox.height}" rx="12" fill="${COLORS.mutedTint}" stroke="${COLORS.border}" stroke-dasharray="6 5"/><text x="${groupBox.x + 18}" y="${groupBox.y + 24}" class="eyebrow">${escapeXml(label(group.label, 32))}</text>`;
    for (const { item: node, box: memberBox } of memberPositions)
      nodeBoxes.set(node.id, memberBox);
  }

  if (horizontalWithGroups) {
    const outgoing = new Set(
      (input.edges ?? []).filter((edge) => edge.from).map((edge) => edge.from),
    );
    const incoming = new Set(
      (input.edges ?? []).filter((edge) => edge.to).map((edge) => edge.to),
    );
    const leftNodes: ArchitectureNode[] = [];
    const rightNodes: ArchitectureNode[] = [];
    for (const [index, node] of ungrouped.entries()) {
      if (outgoing.has(node.id) && !incoming.has(node.id)) {
        leftNodes.push(node);
      } else if (incoming.has(node.id) && !outgoing.has(node.id)) {
        rightNodes.push(node);
      } else if (index % 2 === 0) {
        leftNodes.push(node);
      } else {
        rightNodes.push(node);
      }
    }
    const placeExternal = (nodes: ArchitectureNode[], x: number): void => {
      for (const [index, node] of nodes.entries()) {
        nodeBoxes.set(node.id, {
          x,
          y: 104 + index * 96,
          width: 220,
          height: 64,
        });
      }
    };
    placeExternal(leftNodes, 24);
    placeExternal(rightNodes, maxGroupRight + externalLaneWidth);
  } else {
    const ungroupedPositions = positionInGrid(
      ungrouped,
      direction === "vertical" ? 1 : 3,
      220,
      58,
      28,
      28,
      24,
      groupBoxes.length > 0 ? maxGroupBottom + 44 : 62,
    );
    for (const { item: node, box } of ungroupedPositions)
      nodeBoxes.set(node.id, box);
  }
  const allBoxes = [...nodeBoxes.values()];
  const width = Math.max(
    420,
    (allBoxes.length
      ? Math.max(...allBoxes.map((box) => box.x + box.width))
      : 380) + 28,
  );
  const height = Math.max(
    180,
    (allBoxes.length
      ? Math.max(...allBoxes.map((box) => box.y + box.height))
      : 150) + 28,
  );
  let body =
    arrowMarker(`${options.idPrefix ?? "architecture"}-edge`) + groupBody;
  for (const edge of input.edges ?? []) {
    const from = nodeBoxes.get(edge.from);
    const to = nodeBoxes.get(edge.to);
    if (!from || !to) continue;
    body += edgeMarkup(
      edgePath(from, to, direction),
      `${options.idPrefix ?? "architecture"}-${edge.from}-${edge.to}`,
      edge.label,
      edge.style,
      `${options.idPrefix ?? "architecture"}-edge`,
      edgeLabelPoint(from, to, direction),
    );
  }
  for (const node of input.nodes) {
    const box = nodeBoxes.get(node.id);
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
    body += text(box.x + 14, box.y + (node.sublabel ? 28 : 35), node.label);
    if (node.sublabel)
      body += text(box.x + 14, box.y + 44, node.sublabel, "sub");
  }
  return {
    ok: true,
    value: {
      svg: baseSvg(
        options.idPrefix ?? "architecture-diagram",
        input.title ?? options.title ?? "Architecture diagram",
        input.description ??
          options.description ??
          "Components, boundaries, and connections.",
        width,
        height,
        body,
      ),
      width,
      height,
    },
  };
}

export function validateArchitectureProps(props: unknown): DiagramError[] {
  return parseArchitectureInput(props).errors;
}
