import type { VisualArtifactSpec } from "./artifact-schema.ts";

export type MermaidParser = {
  initialize(config: Record<string, unknown>): void;
  parse(code: string): Promise<unknown>;
};

let mermaidModule: MermaidParser | null = null;

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
    .join("\n")
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

            const multilineQuotingNeeded =
              quotingNeeded || rawLabel.includes("(") || rawLabel.includes(")");

            if (multilineQuotingNeeded) {
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
      const matchIndex = match.index as number;
      const beforeNode = remaining.slice(0, matchIndex + nodeName.length);
      parts.push(beforeNode);

      let depth = 1;
      const labelBuffer: string[] = [];
      let foundClose = false;
      const afterBracketIdx = scanPos + matchIndex + nodeName.length + 1;

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
              rawLabel.includes("[") ||
              rawLabel.includes("|") ||
              rawLabel.includes("(") ||
              rawLabel.includes(")");
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

/* ------------------------------------------------------------------ */
/*  Auto-fix helpers for common mermaid parsing failures               */
/* ------------------------------------------------------------------ */

/**
 * Wrap unquoted diamond `{...}` labels in `{"..."}` when they contain
 * special characters that confuse the mermaid parser.
 *
 * Before:  A{text <br/> more}
 * After:   A{"text <br/> more"}
 */
function fixDiamondLabels(code: string): string {
  return code.replace(
    /\b([A-Za-z0-9_]+)\{([^}]*[|<>{}[\]()"'][^}]*)\}/gu,
    (_match, nodeName: string, label: string) => {
      // Already quoted with {"..."} ? skip
      if (label.startsWith('"') && label.endsWith('"')) return _match;
      return `${nodeName}{${escapeQuotedLabel(label)}}`;
    },
  );
}

/**
 * Wrap ALL arrow link text in quotes (not just those with parentheses).
 * Mermaid requires quoted link text when it contains special characters.
 *
 * Before:  -->|text with | pipe or [bracket]|
 * After:   -->|"text with | pipe or [bracket]"|
 *
 * NOTE: If the link text itself contains `|`, the regex uses a non-greedy
 *       `.+?` so it matches the FIRST closing `|` that is followed by a
 *       word boundary (node name) or end-of-line — which is the heuristic
 *       for "this | closes the link text, not a character inside it".
 */
function wrapAllLinkText(code: string): string {
  return code.replace(
    /(-->|==>|-->>|==>>|-\.->|-\.>>|--o|--x)\|(.+?)\|(?=\b|$)/gu,
    (_match, arrow: string, text: string) => {
      const trimmed = text.trim();
      // Already quoted? skip
      if (/^"[^"]*"$/u.test(trimmed)) return _match;
      return `${arrow}|"${trimmed}"|`;
    },
  );
}

/**
 * Aggressively quote all square-bracket labels that aren't already
 * quoted with `["...""]`.  This is a broader version of
 * `normalizeFlowchartSquareLabels` — it doesn't check for specific
 * special characters; it quotes everything.
 */
function aggressiveQuoteLabels(code: string): string {
  return code.replace(
    /\b([A-Za-z0-9_]+)\[(?!["`])([^\]]+)\]/gu,
    (_match, nodeName: string, label: string) => {
      return `${nodeName}["${escapeQuotedLabel(label)}"]`;
    },
  );
}

/**
 * HTML entities inside mermaid labels can confuse the parser.
 * Decode common entities to literal characters.
 */
function decodeLabelHtmlEntities(code: string): string {
  return code
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"');
}

/** Auto-fix strategies, ordered from least to most invasive. */
const FIX_STRATEGIES: ((code: string) => string)[] = [
  (c) => normalizeFlowchartSquareLabels(normalizeLinkText(fixDiamondLabels(c))),
  (c) => normalizeFlowchartSquareLabels(wrapAllLinkText(fixDiamondLabels(c))),
  (c) => aggressiveQuoteLabels(wrapAllLinkText(fixDiamondLabels(c))),
  (c) =>
    decodeLabelHtmlEntities(
      aggressiveQuoteLabels(wrapAllLinkText(fixDiamondLabels(c))),
    ),
];

/**
 * Try each auto-fix strategy until one produces valid mermaid.
 * Returns the fixed code, or null if none worked.
 */
export async function autoFixMermaidCode(
  code: string,
  mermaid: MermaidParser,
): Promise<string | null> {
  mermaid.initialize({ startOnLoad: false, securityLevel: "loose" });

  for (const strategy of FIX_STRATEGIES) {
    try {
      const fixed = strategy(code);
      if (fixed === code) continue; // no change — skip
      await mermaid.parse(fixed);
      return fixed; // this strategy produced valid mermaid
    } catch {}
  }

  return null;
}

export function normalizeMermaidCode(code: string): string {
  const normalized = code.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const diagramType = detectDiagramType(normalized);

  // Step 1: Handle structural fixes for flowchart/graph types
  if (diagramType === "graph" || diagramType === "flowchart") {
    const bracketFixed = normalizeFlowchartSquareLabels(
      normalizeLinkText(normalized),
    );
    // Step 2: Preventive aggressive quoting — wraps ALL unquoted [label] in ["label"]
    // This prevents parse failures from (), [], |, and other special chars
    return aggressiveQuoteLabels(bracketFixed);
  }

  // For non-flowchart types (sequenceDiagram, stateDiagram, etc.), still apply
  // preventive quoting for any square-bracket labels
  return aggressiveQuoteLabels(normalized);
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

async function getMermaid(): Promise<MermaidParser> {
  if (!mermaidModule) {
    await ensureDom();
    mermaidModule = (await import("mermaid")).default as MermaidParser;
  }
  return mermaidModule;
}

/** Get the mermaid parser instance for dependency injection. Ensures DOM is set up. */
export async function getMermaidRuntime(): Promise<MermaidParser> {
  return getMermaid();
}

function formatMermaidError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\n+\.\.*[\s\S]*?\^\n*/u, " ")
    .replace(/Parse error on line \d+:\s*/u, "")
    .trim();
}

export type MermaidValidationResultWithFix =
  | { ok: true; fixedCode?: string }
  | { ok: false; error: string; fixedCode?: string };

/**
 * Validate a mermaid code string against the real parser.
 *
 * This is the **shell** — it acquires the mermaid dependency and delegates
 * to the pure(er) core. Prefer injecting mermaid via {@link validateMermaidCodeWith}
 * when testing or when the caller already has a mermaid instance.
 */
export async function validateMermaidCode(
  code: string,
): Promise<MermaidValidationResultWithFix> {
  const mermaid = await getMermaid();
  return validateMermaidCodeWith(code, mermaid);
}

/**
 * Validate a mermaid code string against a provided mermaid parser instance.
 *
 * This is the **core decision function**: given code and a parser,
 * return whether it parses (with optional auto-fix).
 * No IO, no global state — just the mermaid instance you pass in.
 */
export async function validateMermaidCodeWith(
  code: string,
  mermaid: MermaidParser,
): Promise<MermaidValidationResultWithFix> {
  try {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "loose",
    });
    await mermaid.parse(code);
    return { ok: true };
  } catch (error) {
    const originalError = formatMermaidError(error);

    // Try auto-fix strategies
    const fixed = await autoFixMermaidCode(code, mermaid);
    if (fixed) {
      return { ok: true, fixedCode: fixed };
    }

    return {
      ok: false,
      error: originalError,
    };
  }
}

type CollectedErrors = {
  errors: string[];
  /** Deep clone of the spec with auto-fixed mermaid code applied. */
  fixedSpec: VisualArtifactSpec | null;
};

async function collectMermaidErrors(
  value: unknown,
  path: string,
  mermaid: MermaidParser,
): Promise<CollectedErrors> {
  if (Array.isArray(value)) {
    const results = await Promise.all(
      value.map((entry, index) =>
        collectMermaidErrors(entry, `${path}[${index}]`, mermaid),
      ),
    );
    const allErrors = results.flatMap((r) => r.errors);
    let mergedFixed: unknown;
    let hasFix = false;
    for (let i = 0; i < results.length; i++) {
      if (results[i].fixedSpec) {
        if (!mergedFixed) mergedFixed = [...value];
        (mergedFixed as unknown[])[i] = results[i].fixedSpec;
        hasFix = true;
      }
    }
    // If any child was fixed but we didn't track the fix
    if (hasFix) {
      return {
        errors: allErrors,
        fixedSpec: mergedFixed as VisualArtifactSpec | null,
      };
    }
    return { errors: allErrors, fixedSpec: null };
  }

  if (!value || typeof value !== "object") {
    return { errors: [], fixedSpec: null };
  }

  const record = value as Record<string, unknown>;
  const errors: string[] = [];
  let mutated: Record<string, unknown> | null = null;

  // Check mermaid nodes
  if (
    record.type === "mermaid" &&
    record.props &&
    typeof record.props === "object" &&
    !Array.isArray(record.props)
  ) {
    const props = record.props as Record<string, unknown>;
    const codeKey =
      typeof props.code === "string"
        ? "code"
        : typeof props.definition === "string"
          ? "definition"
          : null;
    if (codeKey) {
      const originalCode = props[codeKey] as string;
      const result = await validateMermaidCodeWith(originalCode, mermaid);
      if (!result.ok) {
        errors.push(
          `${path}<mermaid>: ${(result as { ok: false; error: string }).error}`,
        );
      }
      // Even if ok returned with fixedCode, apply the fix
      if (
        "fixedCode" in result &&
        result.fixedCode &&
        result.fixedCode !== originalCode
      ) {
        if (!mutated) {
          mutated = { ...record, props: { ...props } };
        }
        (mutated.props as Record<string, unknown>)[codeKey] = result.fixedCode;
      }
    }
  }

  // Recurse into other keys — apply any fixes found in children
  for (const [key, entry] of Object.entries(record)) {
    if (key === "type" || key === "props") continue;
    const childResult = await collectMermaidErrors(
      entry,
      `${path}.${key}`,
      mermaid,
    );
    errors.push(...childResult.errors);
    if (childResult.fixedSpec) {
      if (!mutated) mutated = { ...record };
      (mutated as Record<string, unknown>)[key] = childResult.fixedSpec;
    }
  }

  // Recurse into props
  if (
    record.props &&
    typeof record.props === "object" &&
    !Array.isArray(record.props)
  ) {
    const propsResult = await collectMermaidErrors(
      record.props as Record<string, unknown>,
      `${path}.props`,
      mermaid,
    );
    errors.push(...propsResult.errors);
    if (propsResult.fixedSpec) {
      if (!mutated) mutated = { ...record };
      (mutated as Record<string, unknown>).props = propsResult.fixedSpec;
    }
  }

  return {
    errors,
    fixedSpec: mutated ? (mutated as VisualArtifactSpec) : null,
  };
}

/**
 * Validate all mermaid nodes in a spec.
 *
 * Shell: acquires mermaid once, threads it through recursive validation.
 * Core: {@link validateMermaidCodeWith} does the actual parse + auto-fix.
 */
export async function validateMermaidNodesInSpec(
  spec: VisualArtifactSpec,
): Promise<{
  errors: string[];
  fixedSpec: VisualArtifactSpec | null;
}> {
  const mermaid = await getMermaid();
  const result = await collectMermaidErrors(spec, "", mermaid);
  // When the top-level spec itself was mutated, return it
  const fixedTopLevel =
    result.fixedSpec && "nodes" in (result.fixedSpec as Record<string, unknown>)
      ? (result.fixedSpec as VisualArtifactSpec)
      : null;
  return { errors: result.errors, fixedSpec: fixedTopLevel };
}
