/**
 * Pure Mermaid code normalization functions.
 *
 * These are string-to-string transformations with zero dependencies on the
 * mermaid module, DOM, or IO.  They can be used by:
 *   - visual-artifact extension (mermaid-boundary.ts)
 *   - plan-mode / plannotator-auto (plan-review.ts)
 *
 * Architecture: Functional Core, Imperative Shell.
 * This is the **core** — no IO, no mermaid module, no global state.
 */

/* ------------------------------------------------------------------ */
/*  Diagram type detection                                             */
/* ------------------------------------------------------------------ */

/**
 * Detect the Mermaid diagram type from code.
 * Returns the first non-empty, non-comment token (e.g. "flowchart", "sequenceDiagram").
 */
export function detectDiagramType(code: string): string | undefined {
  for (const line of code.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("%%")) continue;
    return trimmed.split(/\s+/u)[0];
  }
  return undefined;
}

/**
 * Known Tier 1 Mermaid diagram type strings, normalised for comparison.
 * Used for type-aware branching in normalise / validation / advice.
 */
export const TIER_1_DIAGRAM_TYPES = new Set([
  "flowchart",
  "graph",
  "sequenceDiagram",
  "classDiagram",
  "stateDiagram",
  "stateDiagram-v2",
  "erDiagram",
  "gantt",
  "mindmap",
  "gitGraph",
]);

/* ------------------------------------------------------------------ */
/*  Label escaping helpers                                             */
/* ------------------------------------------------------------------ */

function escapeQuotedLabel(label: string): string {
  return label
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .replace(/"/g, "&quot;");
}

/* ------------------------------------------------------------------ */
/*  Link-text normalisation (flowchart / graph only)                   */
/* ------------------------------------------------------------------ */

export function normalizeLinkText(code: string): string {
  return code.replace(
    /(-->|==>|-->>|==>>|-\.->|-\.>>|--o|--x)\|([^"|][^|]*[()][^|]*)\|/gu,
    (_match, arrow: string, text: string) => {
      return `${arrow}|"${text}"|`;
    },
  );
}

/* ------------------------------------------------------------------ */
/*  Flowchart square-bracket label normalisation (flowchart / graph)   */
/* ------------------------------------------------------------------ */

/**
 * Normalise square-bracket labels in flowchart/graph diagrams.
 * Handles multiline labels, nested brackets, and pipe characters.
 */
export function normalizeFlowchartSquareLabels(code: string): string {
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
export function fixDiamondLabels(code: string): string {
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
export function wrapAllLinkText(code: string): string {
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
export function aggressiveQuoteLabels(code: string): string {
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
export function decodeLabelHtmlEntities(code: string): string {
  return code
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"');
}

/* ------------------------------------------------------------------ */
/*  Sequence diagram participant alias quoting                         */
/* ------------------------------------------------------------------ */

/**
 * Quote participant aliases in sequence diagrams when they contain
 * special characters that confuse the mermaid parser.
 *
 * Before (alias with dots):
 *   participant T as guidance.test.ts
 * After:
 *   participant T as "guidance.test.ts"
 *
 * Before (bare name with dots):
 *   participant guidance.test.ts
 * After:
 *   participant "guidance.test.ts"
 *
 * Skips already-quoted aliases.
 */
function quoteParticipantAliases(code: string): string {
  // Match `participant NAME as ALIAS` — quote ALIAS if it contains
  // special characters (dots, angle brackets, parens, pipes, etc.).
  // The trailing (\s|$) captures the original newline so it's preserved.
  const result = code.replace(
    /\b(participant)\s+([A-Za-z0-9_][A-Za-z0-9_.-]*)\s+as\s+([^\s"]+)(\s|$)/gi,
    (
      _match,
      _keyword: string,
      _name: string,
      alias: string,
      trailing: string,
    ) => {
      // Already quoted? skip
      if (/^"[^"]*"$/u.test(alias)) return _match;
      // Only quote if alias contains characters that confuse the parser
      if (/[.<>()[\]|]/u.test(alias)) {
        return `${_keyword} ${_name} as "${alias}"${trailing}`;
      }
      return _match;
    },
  );

  // Match bare `participant NAME` without `as` — quote NAME if it
  // contains special characters and isn't already quoted.
  // The trailing (\s|$) captures the original newline so it's preserved.
  return result.replace(
    /\b(participant)\s+([^\s"]+)(\s|$)/gi,
    (_match, _keyword: string, name: string, trailing: string) => {
      // Already quoted? skip
      if (/^"[^"]*"$/u.test(name)) return _match;
      // Only quote if name contains characters that confuse the parser
      if (/[.<>()[\]|]/u.test(name)) {
        return `${_keyword} "${name}"${trailing}`;
      }
      return _match;
    },
  );
}

/* ------------------------------------------------------------------ */
/*  Main normalisation entry point                                     */
/* ------------------------------------------------------------------ */

/**
 * Normalise a mermaid code string so that common syntax pitfalls are
 * automatically avoided:
 *
 * - Unquoted `[label]` → `["label"]` (prevents parse failures from (), [], |)
 * - Unquoted link text → `|"text"|`
 * - Multiline labels inside flowchart/graph nodes get properly quoted
 * - Diamond labels with special chars get quoted
 *
 * Safe for all Tier 1 diagram types (flowchart, graph, sequenceDiagram,
 * classDiagram, stateDiagram, stateDiagram-v2, erDiagram, gantt, mindmap,
 * gitGraph) and unknown types.
 */
export function normalizeMermaidCode(code: string): string {
  const normalized = code.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const diagramType = detectDiagramType(normalized);

  // Step 1: Handle structural fixes for flowchart/graph types.
  // These use heavy bracket syntax (multiline labels, link text, inline pipes)
  // that requires the full normalize pipeline.
  if (diagramType === "graph" || diagramType === "flowchart") {
    const bracketFixed = normalizeFlowchartSquareLabels(
      normalizeLinkText(normalized),
    );
    // Step 2: Preventive aggressive quoting — wraps ALL unquoted [label] in ["label"]
    // This prevents parse failures from (), [], |, and other special chars
    return aggressiveQuoteLabels(bracketFixed);
  }

  // For all other Tier 1 types and unknown types, apply preventive
  // quoting for any square-bracket labels.
  //
  // These diagram types either:
  //   - Don't use bracket syntax at all (gantt, mindmap, gitGraph)
  //   - Use diamond {} or quoted syntax (classDiagram, stateDiagram, erDiagram)
  //   - Use participant-based syntax (sequenceDiagram)
  //
  // aggressiveQuoteLabels is safe: its regex only matches Node[label] patterns,
  // so it won't corrupt indentation, command keywords, or other structural syntax.

  // For sequenceDiagram specifically, also quote participant aliases that
  // contain dots (e.g. `participant T as guidance.test.ts`) or other special
  // characters, which confuse the mermaid parser.
  if (diagramType === "sequenceDiagram") {
    return quoteParticipantAliases(aggressiveQuoteLabels(normalized));
  }

  return aggressiveQuoteLabels(normalized);
}

/* ------------------------------------------------------------------ */
/*  Diagram-type advice                                                */
/* ------------------------------------------------------------------ */

/**
 * Get type-specific advice for a Mermaid diagram type.
 * Returns an array of suggestion strings, or undefined if no specific advice exists.
 */
export function getTypeAdviceForDiagram(
  diagramType: string | undefined,
): string[] | undefined {
  if (!diagramType) return undefined;

  const typeLower = diagramType.toLowerCase();

  const adviceMap: Record<string, string[]> = {
    flowchart: [
      'Use double-quoted labels: N["label text"] not N[label text]',
      'Edge labels need quoting: -->|"label"| Next',
      "Use subgraph for logical groups: subgraph Title ... end",
      "Inline :::class breaks node labels — put on separate line: N:::class",
    ],
    graph: [
      'Use double-quoted labels: N["label text"] not N[label text]',
      'Edge labels need quoting: -->|"label"| Next',
      "Use subgraph for logical groups: subgraph Title ... end",
    ],
    sequencediagram: [
      'Quote participant names with special chars: participant A as "my name"',
      "Message arrows: -> for solid, ->> for dotted",
      "Use activate/deactivate for lifeline blocks",
    ],
    classdiagram: [
      'Use quotes for class names with special chars: class "My Class"',
      "Members in {} blocks: class Name { +method() }",
      'Avoid unquoted parens in labels: use N["method()"] not N[method()]',
    ],
    statediagram: [
      'Use quotes for multi-word state names: state "My State" as S',
      "Transitions: State1 --> State2 : event",
      "Use [*] for initial and final states",
    ],
    statediagramv2: [
      'Use quotes for multi-word state names: state "My State" as S',
      "Transitions: State1 --> State2 : event",
      "Use [*] for initial and final states",
    ],
    erdiagram: [
      "Cardinality: ||--o{ for one-to-many, ||--|| for one-to-one",
      'Quoted multi-word entity names: "Order Item"',
      "Attributes in {} blocks: Entity { attr type }",
    ],
    gantt: [
      "Set dateFormat first: dateFormat YYYY-MM-DD",
      "Use crit for critical path, milestone for key points",
      "Task: Name, id, start, duration",
    ],
    mindmap: [
      "Use 2-space indentation for hierarchy",
      "Root: root((Title)) or root[Title]",
      "Keep branches shallow (3-4 levels max)",
    ],
    gitgraph: [
      "Use commit, branch, checkout, merge keywords",
      "checkout before adding commits to a branch",
      "merge to integrate branches",
    ],
  };

  // Normalize: lowercase + strip hyphens so 'stateDiagram-v2' → 'statediagramv2'
  return adviceMap[typeLower.replace(/-/gu, "")];
}
