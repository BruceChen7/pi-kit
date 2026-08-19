import {
  arrowMarker,
  baseSvg,
  COLORS,
  type DiagramError,
  type DiagramRenderOptions,
  type DiagramResult,
  type ErDiagramInput,
  type ErEntity,
  type ErField,
  type ErRelationship,
  edgeLabelPoint,
  edgeMarkup,
  edgePath,
  error,
  isRecord,
  MAX_ENTITIES,
  nodeArray,
  parseDirection,
  positionInGrid,
  rect,
  resultFromErrors,
  stringValue,
  text,
} from "./shared.ts";

function parseErInput(props: unknown): {
  input?: ErDiagramInput;
  errors: DiagramError[];
} {
  if (!isRecord(props))
    return { errors: [error("props", "must be an object")] };
  const entitiesRaw = nodeArray(props.entities);
  const relationshipsRaw = nodeArray(props.relationships) ?? [];
  const errors: DiagramError[] = [];
  if (!entitiesRaw) errors.push(error("entities", "must be an array"));
  if (entitiesRaw && entitiesRaw.length === 0)
    errors.push(error("entities", "must not be empty"));
  if (entitiesRaw && entitiesRaw.length > MAX_ENTITIES)
    errors.push(
      error("entities", `must contain at most ${MAX_ENTITIES} entities`),
    );

  const entities: ErEntity[] = [];
  const ids = new Set<string>();
  for (const [index, raw] of (entitiesRaw ?? []).entries()) {
    if (!isRecord(raw)) {
      errors.push(error(`entities[${index}]`, "must be an object"));
      continue;
    }
    const id = stringValue(raw.id);
    const name = stringValue(raw.name) ?? id;
    const fieldsRaw = nodeArray(raw.fields) ?? [];
    if (!id) errors.push(error(`entities[${index}].id`, "is required"));
    if (id && ids.has(id))
      errors.push(
        error(`entities[${index}].id`, `duplicates entity id "${id}"`),
      );
    if (id) ids.add(id);
    if (!name) errors.push(error(`entities[${index}].name`, "is required"));
    if (fieldsRaw.length > 32)
      errors.push(
        error(`entities[${index}].fields`, "must contain at most 32 fields"),
      );
    const fields: ErField[] = [];
    for (const [fieldIndex, fieldRaw] of fieldsRaw.entries()) {
      if (!isRecord(fieldRaw)) {
        errors.push(
          error(
            `entities[${index}].fields[${fieldIndex}]`,
            "must be an object",
          ),
        );
        continue;
      }
      const fieldName = stringValue(fieldRaw.name);
      if (!fieldName)
        errors.push(
          error(`entities[${index}].fields[${fieldIndex}].name`, "is required"),
        );
      const fieldKey = fieldRaw.key;
      if (
        fieldKey !== undefined &&
        fieldKey !== "PK" &&
        fieldKey !== "FK" &&
        fieldKey !== "UK"
      ) {
        errors.push(
          error(
            `entities[${index}].fields[${fieldIndex}].key`,
            "must be PK, FK, or UK",
          ),
        );
      }
      if (fieldName)
        fields.push({
          name: fieldName,
          type: stringValue(fieldRaw.type),
          key: fieldKey as ErField["key"],
        });
    }
    if (id && name) entities.push({ id, name, fields });
  }

  const relationships: ErRelationship[] = [];
  for (const [index, raw] of relationshipsRaw.entries()) {
    if (!isRecord(raw)) {
      errors.push(error(`relationships[${index}]`, "must be an object"));
      continue;
    }
    const from = stringValue(raw.from);
    const to = stringValue(raw.to);
    if (!from)
      errors.push(error(`relationships[${index}].from`, "is required"));
    if (!to) errors.push(error(`relationships[${index}].to`, "is required"));
    if (from && !ids.has(from))
      errors.push(
        error(`relationships[${index}].from`, `unknown entity "${from}"`),
      );
    if (to && !ids.has(to))
      errors.push(
        error(`relationships[${index}].to`, `unknown entity "${to}"`),
      );
    const cardinality = raw.cardinality;
    if (
      cardinality !== undefined &&
      cardinality !== "one-to-one" &&
      cardinality !== "one-to-many" &&
      cardinality !== "many-to-many"
    ) {
      errors.push(
        error(
          `relationships[${index}].cardinality`,
          "must be one-to-one, one-to-many, or many-to-many",
        ),
      );
    }
    if (from && to && ids.has(from) && ids.has(to))
      relationships.push({
        from,
        to,
        label: stringValue(raw.label),
        cardinality: cardinality as ErRelationship["cardinality"],
      });
  }

  if (errors.length > 0) return { errors };
  return {
    errors,
    input: {
      entities,
      relationships,
      direction: parseDirection(props.direction),
      title: stringValue(props.title),
      description: stringValue(props.description),
    },
  };
}

export function renderErDiagram(
  props: unknown,
  options: DiagramRenderOptions = {},
): DiagramResult {
  const parsed = parseErInput(props);
  if (parsed.errors.length > 0 || !parsed.input)
    return resultFromErrors(parsed.errors);
  const input = parsed.input;
  const direction = input.direction ?? options.direction ?? "horizontal";
  const columns =
    direction === "vertical"
      ? 1
      : Math.min(3, Math.max(1, input.entities.length));
  const positioned = positionInGrid(input.entities, columns, 220, 76, 42, 36);
  const fieldsById = new Map(
    input.entities.map((entity, index) => [
      entity.id,
      { ...positioned[index], entity },
    ]),
  );
  const rows = Math.ceil(input.entities.length / columns);
  const width =
    direction === "vertical" ? 360 : columns * 220 + (columns - 1) * 42 + 48;
  const height = 56 + rows * 76 + Math.max(0, rows - 1) * 36 + 24;
  let body = arrowMarker(`${options.idPrefix ?? "er"}-edge`);
  for (const relationship of input.relationships) {
    const from = fieldsById.get(relationship.from);
    const to = fieldsById.get(relationship.to);
    if (!from || !to) continue;
    const path = edgePath(from.box, to.box, direction);
    const edgeId = `${options.idPrefix ?? "er"}-${relationship.from}-${relationship.to}`;
    body += edgeMarkup(
      path,
      edgeId,
      relationship.label ?? relationship.cardinality,
      "solid",
      `${options.idPrefix ?? "er"}-edge`,
      edgeLabelPoint(from.box, to.box, direction),
    );
  }
  for (const { entity, box } of positioned.map((entry) => ({
    entity: entry.item,
    box: entry.box,
  }))) {
    const focal = entity.fields.some((field) => field.key === "PK");
    body += rect(box, focal ? `stroke="${COLORS.accent}"` : "");
    body += text(box.x + 14, box.y + 22, entity.name ?? entity.id, "", "start");
    body += `<line x1="${box.x}" y1="${box.y + 32}" x2="${box.x + box.width}" y2="${box.y + 32}" stroke="${COLORS.border}"/>`;
    if (entity.fields.length === 0)
      body += text(box.x + 14, box.y + 54, "No fields", "sub");
    for (const [fieldIndex, field] of entity.fields.slice(0, 2).entries()) {
      const key = field.key ? `${field.key} ` : "";
      body += text(
        box.x + 14,
        box.y + 51 + fieldIndex * 15,
        `${key}${field.name}${field.type ? `: ${field.type}` : ""}`,
        "sub",
      );
    }
    if (entity.fields.length > 2)
      body += text(
        box.x + 14,
        box.y + 68,
        `+${entity.fields.length - 2} more`,
        "sub",
      );
  }
  return {
    ok: true,
    value: {
      svg: baseSvg(
        options.idPrefix ?? "er-diagram",
        input.title ?? options.title ?? "Entity relationship diagram",
        input.description ??
          options.description ??
          "Entities, fields, and relationships.",
        width,
        height,
        body,
      ),
      width,
      height,
    },
  };
}

export function validateErProps(props: unknown): DiagramError[] {
  return parseErInput(props).errors;
}
