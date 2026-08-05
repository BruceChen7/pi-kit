/**
 * Minimal decoder for the TOON output emitted by the `lavish-axi` CLI.
 *
 * `lavish-axi open`/`poll` serialize their results with
 * `@toon-format/toon`'s `encode` (via the axi-sdk-js `runAxiCli`), so the
 * raw stdout is TOON — never JSON. This module decodes the subset of TOON
 * those two commands produce:
 *
 * - nested objects (`key:` + indented child lines)
 * - scalar key/value lines (`key: value`, values may be quoted strings with
 *   `\n \t \r \\ \" \uXXXX` escapes, numbers, booleans, `null`)
 * - empty arrays (`key: []`)
 * - tabular arrays (`key[N]{f1,f2,...}:` + indented comma-separated rows,
 *   values quoted only when they contain the delimiter)
 * - list-item arrays (`key[N]:` + `- item` lines)
 *
 * Unknown/unparsable input returns `null` so callers keep their previous
 * fallback behavior instead of crashing.
 */

export type ToonValue =
  | string
  | number
  | boolean
  | null
  | ToonValue[]
  | ToonObject;

export type ToonObject = { [key: string]: ToonValue };

const charAt = (text: string, index: number): string =>
  index < text.length ? (text[index] ?? "") : "";

const parseToonScalar = (raw: string): ToonValue => {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return "";
  }
  if (trimmed === "null") {
    return null;
  }
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }
  if (trimmed.startsWith('"')) {
    return unescapeToonString(trimmed);
  }
  return trimmed;
};

/** Unescape a TOON quoted string; `raw` includes the surrounding quotes. */
const unescapeToonString = (raw: string): string => {
  let out = "";
  let i = 1; // skip the opening quote
  while (i < raw.length) {
    const ch = charAt(raw, i);
    if (ch === '"') {
      return out;
    }
    if (ch !== "\\") {
      out += ch;
      i += 1;
      continue;
    }
    const next = charAt(raw, i + 1);
    if (next === "n") {
      out += "\n";
      i += 2;
    } else if (next === "t") {
      out += "\t";
      i += 2;
    } else if (next === "r") {
      out += "\r";
      i += 2;
    } else if (next === "\\") {
      out += "\\";
      i += 2;
    } else if (next === '"') {
      out += '"';
      i += 2;
    } else if (next === "u") {
      const hex = raw.slice(i + 2, i + 6);
      if (/^[0-9a-f]{4}$/i.test(hex)) {
        out += String.fromCodePoint(Number.parseInt(hex, 16));
        i += 6;
      } else {
        out += next;
        i += 2;
      }
    } else {
      out += next;
      i += 2;
    }
  }
  return out;
};

/** Splits a tabular row on delimiters that are outside quoted sections. */
const splitToonRow = (text: string): string[] => {
  const parts: string[] = [];
  let current = "";
  let inQuote = false;
  let i = 0;
  while (i < text.length) {
    const ch = charAt(text, i);
    if (inQuote) {
      if (ch === "\\" && i + 1 < text.length) {
        current += ch + charAt(text, i + 1);
        i += 2;
        continue;
      }
      if (ch === '"') {
        inQuote = false;
      }
      current += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuote = true;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === ",") {
      parts.push(current.trim());
      current = "";
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  parts.push(current.trim());
  return parts;
};

type ToonLine = {
  indent: number;
  text: string;
};

const toonLines = (text: string): ToonLine[] =>
  text
    .split("\n")
    .map((line) => {
      const match = /^(\s*)(.*)$/.exec(line);
      return { indent: match?.[1]?.length ?? 0, text: match?.[2] ?? "" };
    })
    .filter((line) => line.text.length > 0 && !line.text.startsWith("#"));

const parseKeyValue = (text: string): { key: string; rest: string } | null => {
  const match = /^([^:]+):(?:\s*(.*))?$/.exec(text);
  if (!match || match[1] === undefined) {
    return null;
  }
  return { key: match[1].trim(), rest: match[2] ?? "" };
};

const TABULAR_ARRAY_HEADER = /^(.+)\[(\d+)\]\{([^}]*)\}$/;
const LIST_ARRAY_HEADER = /^(.+)\[(\d+)\]$/;

/**
 * Decode a TOON document (as printed by `lavish-axi`). Returns `null` when
 * the input does not look like TOON (e.g. a bare error message).
 */
export const decodeToon = (text: string): ToonObject | null => {
  const lines = toonLines(text);
  if (lines.length === 0) {
    return null;
  }

  let pos = 0;

  const parseScalarOrEmptyArray = (raw: string): ToonValue => {
    if (raw.trim() === "[]") {
      return [];
    }
    return parseToonScalar(raw);
  };

  const parseArrayItems = (
    minIndent: number,
    fields: string[] | undefined,
  ): ToonValue[] => {
    const items: ToonValue[] = [];
    while (pos < lines.length) {
      const line = lines[pos];
      if (!line || line.indent < minIndent) {
        break;
      }
      if (fields) {
        const values = splitToonRow(line.text);
        const row: ToonObject = {};
        fields.forEach((field, index) => {
          const cell = values[index];
          row[field] = cell !== undefined ? parseToonScalar(cell) : "";
        });
        items.push(row);
        pos += 1;
        continue;
      }
      if (!line.text.startsWith("-")) {
        pos += 1;
        continue;
      }
      const itemText = line.text.slice(1).trim();
      const kv = parseKeyValue(itemText);
      if (!kv) {
        items.push(parseScalarOrEmptyArray(itemText));
        pos += 1;
        continue;
      }
      pos += 1;
      if (kv.rest !== "") {
        const item: ToonObject = {
          [kv.key]: parseScalarOrEmptyArray(kv.rest),
        };
        Object.assign(item, parseObject(line.indent + 1));
        items.push(item);
        continue;
      }
      items.push({ [kv.key]: parseObject(line.indent + 1) });
    }
    return items;
  };

  const parseObject = (minIndent: number): ToonObject => {
    const obj: ToonObject = {};
    while (pos < lines.length) {
      const line = lines[pos];
      if (!line || line.indent < minIndent) {
        break;
      }
      const kv = parseKeyValue(line.text);
      if (!kv) {
        pos += 1;
        continue;
      }
      const { key, rest } = kv;
      if (rest !== "") {
        obj[key] = parseScalarOrEmptyArray(rest);
        pos += 1;
        continue;
      }

      const tabular = TABULAR_ARRAY_HEADER.exec(key);
      if (tabular && tabular[1] !== undefined && tabular[3] !== undefined) {
        const fields = tabular[3]
          .split(",")
          .map((field) => field.trim())
          .filter(Boolean);
        pos += 1;
        obj[tabular[1].trim()] = parseArrayItems(line.indent + 1, fields);
        continue;
      }

      const listMatch = LIST_ARRAY_HEADER.exec(key);
      if (listMatch && listMatch[1] !== undefined) {
        pos += 1;
        obj[listMatch[1].trim()] = parseArrayItems(line.indent + 1, undefined);
        continue;
      }

      pos += 1;
      obj[key] = parseObject(line.indent + 1);
    }
    return obj;
  };

  return parseObject(0);
};
