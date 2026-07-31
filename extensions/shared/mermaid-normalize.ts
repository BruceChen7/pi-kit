/**
 * Pure Mermaid helpers shared by visual-artifact and plannotator-auto.
 *
 * These are string-level helpers with zero dependencies on the mermaid
 * module, DOM, or IO — safe for both extensions.
 *
 * NOTE: this module intentionally no longer contains any code-normalization /
 * auto-fix functions (normalizeMermaidCode and friends were removed): the
 * project policy is "no silent rewriting" — mermaid code is validated
 * against the real parser and failures are reported to the agent instead.
 * What remains here is diagram-type detection and type-aware error advice.
 */

/* ------------------------------------------------------------------ */
/*  Diagram type detection                                             */
/* ------------------------------------------------------------------ */

/**
 * Detect the Mermaid diagram type from code.
 * Returns the first non-empty, non-comment token (e.g. "flowchart", "sequenceDiagram"),
 * skipping any leading YAML frontmatter block (`---` … `---`).
 */
export function detectDiagramType(code: string): string | undefined {
  const lines = code.split(/\r?\n/u);
  let inFrontmatter = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("%%")) continue;
    if (trimmed === "---") {
      inFrontmatter = !inFrontmatter;
      continue;
    }
    if (inFrontmatter) continue;
    return trimmed.split(/\s+/u)[0];
  }
  return undefined;
}

/**
 * Known Tier 1 Mermaid diagram type strings, normalised for comparison.
 * Used for type-aware branching in validation / advice.
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
