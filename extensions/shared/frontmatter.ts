/**
 * Frontmatter 解析（Functional Core）。
 *
 * 只处理 pi-kit 需要的子集：`---` 包裹的 `key: value`、`|`/`>` 块标量、值两侧的引号。
 * 不做 YAML 嵌套、数组语法、锚点 —— 需要这些的场景应该换成真正的 YAML 解析器，
 * 而不是往这里加分支。
 */

export type FrontmatterFields = Record<string, string>;

export interface ParsedFrontmatter {
  /** frontmatter 里的 name，缺失时回落为 fallbackName。 */
  name: string;
  /** 折叠空白后的单行 description。 */
  description: string;
  /** 其余键值，值保留原始形态（块标量保留换行，引号已剥）。 */
  fields: FrontmatterFields;
  /** 闭合 `---` 之后的内容。 */
  body: string;
}

const isBlockScalar = (value: string): boolean =>
  value.startsWith("|") || value.startsWith(">");

const unquote = (value: string): string => {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' || first === "'") && first === last) {
    return value.slice(1, -1);
  }
  return value;
};

const normalizeDescription = (value: string): string =>
  value.replace(/\s+/g, " ").trim();

function readBlockScalar(
  lines: string[],
  startIndex: number,
): { value: string; nextIndex: number } {
  let indent: number | null = null;
  const blockLines: string[] = [];
  let index = startIndex;

  for (; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) {
      blockLines.push("");
      continue;
    }

    const match = /^(\s+)(.*)$/.exec(line);
    if (!match) break;

    const currentIndent = match[1].length;
    if (indent === null) {
      indent = currentIndent;
    }

    if (currentIndent < indent) break;

    blockLines.push(line.slice(indent));
  }

  return { value: blockLines.join("\n"), nextIndex: index };
}

export function parseFrontmatter(
  content: string,
  fallbackName: string,
): ParsedFrontmatter {
  const empty: ParsedFrontmatter = {
    name: fallbackName,
    description: "",
    fields: {},
    body: content,
  };

  if (!content.startsWith("---")) return empty;

  const endIndex = content.indexOf("\n---", 3);
  if (endIndex === -1) return empty;

  const lines = content.slice(4, endIndex).split("\n");
  const fields: FrontmatterFields = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    // 缩进行属于上一个键的嵌套块（如 `metadata:` 下的 author/version）。
    // 当成顶层键会让嵌套的 model/tools 悄悄覆盖真正的顶层值。
    if (/^\s/.test(line)) continue;

    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    if (!key) continue;

    const rawValue = line.slice(colonIndex + 1).trim();

    if (isBlockScalar(rawValue)) {
      const { value, nextIndex } = readBlockScalar(lines, i + 1);
      fields[key] = value;
      i = nextIndex - 1;
      continue;
    }

    fields[key] = unquote(rawValue);
  }

  return {
    name: fields.name || fallbackName,
    description: normalizeDescription(fields.description ?? ""),
    fields,
    body: content.slice(endIndex + 4).replace(/^\s*\n/, ""),
  };
}
