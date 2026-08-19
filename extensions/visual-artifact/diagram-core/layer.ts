import {
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
  type Layer,
  type LayerDiagramInput,
  type LayerEdge,
  type LayerItem,
  label,
  MAX_ITEMS_PER_LAYER,
  MAX_LAYERS,
  nodeArray,
  parseDirection,
  rect,
  resultFromErrors,
  stringValue,
  text,
} from "./shared.ts";

function parseLayerInput(props: unknown): {
  input?: LayerDiagramInput;
  errors: DiagramError[];
} {
  if (!isRecord(props))
    return { errors: [error("props", "must be an object")] };
  const layersRaw = nodeArray(props.layers);
  const edgesRaw = nodeArray(props.edges) ?? [];
  const errors: DiagramError[] = [];
  if (!layersRaw) errors.push(error("layers", "must be an array"));
  if (layersRaw && layersRaw.length === 0)
    errors.push(error("layers", "must not be empty"));
  if (layersRaw && layersRaw.length > MAX_LAYERS)
    errors.push(error("layers", `must contain at most ${MAX_LAYERS} layers`));
  const layers: Layer[] = [];
  const ids = new Set<string>();
  const itemIds = new Set<string>();
  for (const [index, raw] of (layersRaw ?? []).entries()) {
    if (!isRecord(raw)) {
      errors.push(error(`layers[${index}]`, "must be an object"));
      continue;
    }
    const id = stringValue(raw.id);
    const layerLabel = stringValue(raw.label);
    const itemsRaw = nodeArray(raw.items) ?? [];
    if (!id) errors.push(error(`layers[${index}].id`, "is required"));
    if (!layerLabel)
      errors.push(error(`layers[${index}].label`, "is required"));
    if (id && ids.has(id))
      errors.push(error(`layers[${index}].id`, `duplicates layer id "${id}"`));
    if (id) ids.add(id);
    if (itemsRaw.length > MAX_ITEMS_PER_LAYER)
      errors.push(
        error(
          `layers[${index}].items`,
          `must contain at most ${MAX_ITEMS_PER_LAYER} items`,
        ),
      );
    const items: LayerItem[] = [];
    for (const [itemIndex, itemRaw] of itemsRaw.entries()) {
      const item =
        typeof itemRaw === "string" ? { id: itemRaw, label: itemRaw } : itemRaw;
      if (!isRecord(item)) {
        errors.push(
          error(
            `layers[${index}].items[${itemIndex}]`,
            "must be a string or object",
          ),
        );
        continue;
      }
      const itemId = stringValue(item.id);
      const itemLabel = stringValue(item.label) ?? itemId;
      if (!itemId)
        errors.push(
          error(`layers[${index}].items[${itemIndex}].id`, "is required"),
        );
      if (!itemLabel)
        errors.push(
          error(`layers[${index}].items[${itemIndex}].label`, "is required"),
        );
      if (itemId && itemIds.has(itemId))
        errors.push(
          error(
            `layers[${index}].items[${itemIndex}].id`,
            `duplicates item id "${itemId}"`,
          ),
        );
      if (itemId) itemIds.add(itemId);
      if (itemId && itemLabel)
        items.push({
          id: itemId,
          label: itemLabel,
          kind: item.kind as LayerItem["kind"],
          focal: item.focal === true,
        });
    }
    if (id && layerLabel) layers.push({ id, label: layerLabel, items });
  }
  const edges: LayerEdge[] = [];
  for (const [index, raw] of edgesRaw.entries()) {
    if (!isRecord(raw)) {
      errors.push(error(`edges[${index}]`, "must be an object"));
      continue;
    }
    const from = stringValue(raw.from);
    const to = stringValue(raw.to);
    if (!from) errors.push(error(`edges[${index}].from`, "is required"));
    if (!to) errors.push(error(`edges[${index}].to`, "is required"));
    if (from && !itemIds.has(from))
      errors.push(error(`edges[${index}].from`, `unknown item "${from}"`));
    if (to && !itemIds.has(to))
      errors.push(error(`edges[${index}].to`, `unknown item "${to}"`));
    if (from && to && itemIds.has(from) && itemIds.has(to))
      edges.push({
        from,
        to,
        label: stringValue(raw.label),
        style: raw.style as LayerEdge["style"],
      });
  }
  if (errors.length > 0) return { errors };
  return {
    errors,
    input: {
      layers,
      edges,
      direction: parseDirection(props.direction),
      title: stringValue(props.title),
      description: stringValue(props.description),
    },
  };
}

export function renderLayerDiagram(
  props: unknown,
  options: DiagramRenderOptions = {},
): DiagramResult {
  const parsed = parseLayerInput(props);
  if (parsed.errors.length > 0 || !parsed.input)
    return resultFromErrors(parsed.errors);
  const input = parsed.input;
  const direction = input.direction ?? options.direction ?? "vertical";
  const normalizedLayers = input.layers.map((layer) => ({
    ...layer,
    items: layer.items.map((item) =>
      typeof item === "string" ? { id: item, label: item } : item,
    ),
  }));
  const isHorizontal = direction === "horizontal";
  const layerHeight = 74;
  const layerGap = 26;
  const layerWidth = 190;
  const layerColumnGap = 26;
  const width = isHorizontal
    ? Math.max(
        620,
        48 +
          normalizedLayers.length * layerWidth +
          (normalizedLayers.length - 1) * layerColumnGap,
      )
    : 620;
  const height = isHorizontal
    ? Math.max(
        300,
        56 +
          Math.max(
            ...normalizedLayers.map((layer) => 52 + layer.items.length * 44),
          ) +
          24,
      )
    : 56 + normalizedLayers.length * (layerHeight + layerGap) + 24;
  const itemBoxes = new Map<string, Box>();
  let body = arrowMarker(`${options.idPrefix ?? "layer"}-edge`);
  normalizedLayers.forEach((layer, layerIndex) => {
    if (isHorizontal) {
      const x = 24 + layerIndex * (layerWidth + layerColumnGap);
      const layerBox = {
        x,
        y: 56,
        width: layerWidth,
        height: height - 80,
      };
      body += `<rect x="${layerBox.x}" y="${layerBox.y}" width="${layerBox.width}" height="${layerBox.height}" rx="10" fill="${COLORS.mutedTint}" stroke="${COLORS.border}"/><text x="${layerBox.x + 16}" y="${layerBox.y + 22}" class="eyebrow">${escapeXml(label(layer.label, 30))}</text>`;
      layer.items.forEach((item, itemIndex) => {
        const itemBox = {
          x: layerBox.x + 14,
          y: layerBox.y + 34 + itemIndex * 44,
          width: layerBox.width - 28,
          height: 32,
        };
        itemBoxes.set(item.id, itemBox);
        body += rect(
          itemBox,
          `${item.focal ? `stroke="${COLORS.accent}" stroke-width="2"` : ""}`,
        );
        body += text(itemBox.x + 10, itemBox.y + 20, item.label, "sub");
      });
      return;
    }

    const y = 56 + layerIndex * (layerHeight + layerGap);
    const layerBox = { x: 24, y, width: width - 48, height: layerHeight };
    body += `<rect x="${layerBox.x}" y="${layerBox.y}" width="${layerBox.width}" height="${layerBox.height}" rx="10" fill="${COLORS.mutedTint}" stroke="${COLORS.border}"/><text x="${layerBox.x + 16}" y="${layerBox.y + 22}" class="eyebrow">${escapeXml(label(layer.label, 30))}</text>`;
    const itemWidth = Math.min(
      170,
      Math.max(
        112,
        (layerBox.width - 28 - (layer.items.length - 1) * 12) /
          Math.max(layer.items.length, 1),
      ),
    );
    layer.items.forEach((item, itemIndex) => {
      const x = layerBox.x + 14 + itemIndex * (itemWidth + 12);
      const box = { x, y: layerBox.y + 30, width: itemWidth, height: 32 };
      itemBoxes.set(item.id, box);
      body += rect(
        box,
        `${item.focal ? `stroke="${COLORS.accent}" stroke-width="2"` : ""}`,
      );
      body += text(x + 10, y + 50, item.label, "sub");
    });
  });
  for (const edge of input.edges ?? []) {
    const from = itemBoxes.get(edge.from);
    const to = itemBoxes.get(edge.to);
    if (!from || !to) continue;
    body += edgeMarkup(
      edgePath(from, to, direction),
      `${options.idPrefix ?? "layer"}-${edge.from}-${edge.to}`,
      edge.label,
      edge.style,
      `${options.idPrefix ?? "layer"}-edge`,
      edgeLabelPoint(from, to, direction),
    );
  }
  return {
    ok: true,
    value: {
      svg: baseSvg(
        options.idPrefix ?? "layer-diagram",
        input.title ?? options.title ?? "Layer diagram",
        input.description ??
          options.description ??
          "Stacked abstraction layers and their relationships.",
        width,
        height,
        body,
      ),
      width,
      height,
    },
  };
}

export function validateLayerProps(props: unknown): DiagramError[] {
  return parseLayerInput(props).errors;
}
