import type { VisualArtifactSpec } from "./artifact-schema.ts";

type MermaidValidationResult = { ok: true } | { ok: false; error: string };

let mermaidModule: {
  initialize(config: Record<string, unknown>): void;
  parse(code: string): Promise<unknown>;
} | null = null;

function detectDiagramType(code: string): string | undefined {
  for (const line of code.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("%%")) continue;
    return trimmed.split(/\s+/u)[0];
  }
  return undefined;
}

function escapeQuotedLabel(label: string): string {
  return label
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("<br/>")
    .replace(/"/g, "&quot;");
}

function normalizeLinkText(code: string): string {
  return code.replace(
    /(-->|==>|-->>|==>>|-\.->|-\.>>|--o|--x)\|([^"|][^|]*[()][^|]*)\|/gu,
    (_match, arrow: string, text: string) => {
      return `${arrow}|"${text}"|`;
    },
  );
}

function normalizeFlowchartSquareLabels(code: string): string {
  const lines = code.split(/\r?\n/u);
  const out: string[] = [];
  let multilineBuffer: {
    prefix: string;
    depth: number;
    labelParts: string[];
    placeholderIndex: number;
  } | null = null;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];

    // Subgraph, note, etc. might contain arbitrary brackets — skip
    const trimmed = line.trim();
    if (
      trimmed.startsWith("subgraph ") ||
      trimmed === "subgraph" ||
      trimmed.startsWith("note ") ||
      trimmed === "note" ||
      trimmed.startsWith("end ") ||
      trimmed === "end"
    ) {
      out.push(line);
      continue;
    }

    // Handle multiline continuation
    if (multilineBuffer) {
      const { prefix, labelParts } = multilineBuffer;

      for (let ci = 0; ci < line.length; ci += 1) {
        const ch = line[ci];
        if (ch === "[") {
          multilineBuffer.depth += 1;
        } else if (ch === "]") {
          multilineBuffer.depth -= 1;
          if (multilineBuffer.depth === 0) {
            labelParts.push(line.slice(0, ci));
            const suffix = line.slice(ci + 1);
            const rawLabel = labelParts.join("\n");
            const quotingNeeded =
              rawLabel.includes("[") || rawLabel.includes("|");

            if (quotingNeeded) {
              out[multilineBuffer.placeholderIndex] =
                `${prefix}["${escapeQuotedLabel(rawLabel)}"]${suffix}`;
            } else {
              // Reconstruct original multiline text
              const originalFirstSeg = prefix.slice(
                prefix.lastIndexOf("\n") + 1,
              );
              out[multilineBuffer.placeholderIndex] =
                `${originalFirstSeg}[${rawLabel}]${suffix}`;
            }

            multilineBuffer = null;
            // No more processing on this line after the close
            break;
          }
        }
      }

      if (multilineBuffer) {
        labelParts.push(line);
        out.push(""); // placeholder, will be overwritten
        continue;
      }

      // If multiline closed mid-line and there's more after, still needs processing
      // But for simplicity, move on
      continue;
    }

    // Normal line processing: scan for all node brackets
    const parts: string[] = [];
    let scanPos = 0;

    while (scanPos < line.length) {
      const remaining = line.slice(scanPos);
      const match = remaining.match(/\b([A-Za-z0-9_]+)\[(?!["])/u);
      if (!match) {
        parts.push(remaining);
        break;
      }

      const nodeName = match[1];
      const beforeNode = remaining.slice(0, match.index! + nodeName.length);
      parts.push(beforeNode);

      let depth = 1;
      const labelBuffer: string[] = [];
      let foundClose = false;
      const afterBracketIdx = scanPos + match.index! + nodeName.length + 1;

      // First try to close on the same line
      for (let ci = afterBracketIdx; ci < line.length; ci += 1) {
        const ch = line[ci];
        if (ch === "[") {
          depth += 1;
          labelBuffer.push(ch);
        } else if (ch === "]") {
          depth -= 1;
          if (depth === 0) {
            const rawLabel = labelBuffer.join("");
            const quotingNeeded =
              rawLabel.includes("[") || rawLabel.includes("|");
            if (quotingNeeded) {
              parts.push(`["${escapeQuotedLabel(rawLabel)}"]`);
            } else {
              parts.push(`[${rawLabel}]`);
            }
            scanPos = ci + 1;
            foundClose = true;
            break;
          }
          labelBuffer.push(ch);
        } else {
          labelBuffer.push(ch);
        }
      }

      if (!foundClose) {
        // Multiline: store in buffer
        const prefix = parts.join("");
        multilineBuffer = {
          prefix,
          depth,
          labelParts: [labelBuffer.join("")],
          placeholderIndex: out.length,
        };
        out.push(""); // placeholder
        scanPos = line.length; // move past current line
      }
    }

    // If no multiline buffer was started, push result
    if (!multilineBuffer && parts.length > 0) {
      out.push(parts.join(""));
    } else if (!multilineBuffer && parts.length === 0) {
      out.push(line);
    }
  }

  return out.join("\n");
}

export function normalizeMermaidCode(code: string): string {
  const normalized = code.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const diagramType = detectDiagramType(normalized);
  if (diagramType !== "graph" && diagramType !== "flowchart") {
    return normalized;
  }

  return normalizeFlowchartSquareLabels(normalizeLinkText(normalized));
}

function normalizeUnknown(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeUnknown(entry));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const record = value as Record<string, unknown>;
  const cloned: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    cloned[key] = normalizeUnknown(entry);
  }

  if (
    cloned.type === "mermaid" &&
    cloned.props &&
    typeof cloned.props === "object" &&
    !Array.isArray(cloned.props)
  ) {
    const props = { ...(cloned.props as Record<string, unknown>) };
    if (typeof props.code === "string") {
      props.code = normalizeMermaidCode(props.code);
    }
    cloned.props = props;
  }

  return cloned;
}

export function normalizeMermaidNodesInSpec<T extends VisualArtifactSpec>(
  spec: T,
): T {
  return normalizeUnknown(spec) as T;
}

async function ensureDom(): Promise<void> {
  if (typeof window !== "undefined" && typeof document !== "undefined") return;
  const { parseHTML } = await import("linkedom");
  const dom = parseHTML("<!DOCTYPE html><html><body></body></html>");
  const g = globalThis as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.document;
  g.HTMLElement = dom.window.HTMLElement;
}

async function getMermaid() {
  if (!mermaidModule) {
    await ensureDom();
    mermaidModule = (await import("mermaid")).default as typeof mermaidModule;
  }
  return mermaidModule;
}

function formatMermaidError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\n+\.\.*[\s\S]*?\^\n*/u, " ")
    .replace(/Parse error on line \d+:\s*/u, "")
    .trim();
}

export async function validateMermaidCode(
  code: string,
): Promise<MermaidValidationResult> {
  try {
    const mermaid = await getMermaid();
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "loose",
    });
    await mermaid.parse(code);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: formatMermaidError(error),
    };
  }
}

async function collectMermaidErrors(
  value: unknown,
  path: string,
): Promise<string[]> {
  if (Array.isArray(value)) {
    const nested = await Promise.all(
      value.map((entry, index) =>
        collectMermaidErrors(entry, `${path}[${index}]`),
      ),
    );
    return nested.flat();
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;
  const errors: string[] = [];

  if (
    record.type === "mermaid" &&
    record.props &&
    typeof record.props === "object" &&
    !Array.isArray(record.props)
  ) {
    const props = record.props as Record<string, unknown>;
    if (typeof props.code === "string") {
      const result = await validateMermaidCode(props.code);
      if (!result.ok) {
        errors.push(
          `${path}<mermaid>: ${(result as { ok: false; error: string }).error}`,
        );
      }
    }
  }

  for (const [key, entry] of Object.entries(record)) {
    if (key === "type" || key === "props") continue;
    errors.push(...(await collectMermaidErrors(entry, `${path}.${key}`)));
  }

  if (
    record.props &&
    typeof record.props === "object" &&
    !Array.isArray(record.props)
  ) {
    for (const [key, entry] of Object.entries(
      record.props as Record<string, unknown>,
    )) {
      errors.push(
        ...(await collectMermaidErrors(entry, `${path}.props.${key}`)),
      );
    }
  }

  return errors;
}

export async function validateMermaidNodesInSpec(
  spec: VisualArtifactSpec,
): Promise<string[]> {
  return collectMermaidErrors(spec.nodes, "nodes");
}
