import {
  detectDiagramType,
  getTypeAdviceForDiagram,
} from "../shared/mermaid-normalize.ts";
import {
  formatMermaidError,
  getMermaidParser,
  type MermaidParser,
} from "../shared/mermaid-runtime.ts";
import type { VisualArtifactSpec } from "./artifact-schema.ts";

export {
  detectDiagramType,
  getTypeAdviceForDiagram,
  TIER_1_DIAGRAM_TYPES,
} from "../shared/mermaid-normalize.ts";
export {
  type MermaidParser,
  getMermaidParser,
  resetMermaidModule,
} from "../shared/mermaid-runtime.ts";

/** Get the mermaid parser instance for dependency injection. Ensures DOM is set up. */
export async function getMermaidRuntime(): Promise<MermaidParser> {
  return getMermaidParser();
}

export type MermaidValidationResult =
  | { ok: true; diagramType?: string }
  | { ok: false; error: string; diagramType?: string };

/**
 * Validate a mermaid code string against the real parser.
 *
 * This is the **shell** — it acquires + configures the mermaid dependency
 * and delegates to the pure core. Prefer injecting mermaid via
 * {@link validateMermaidCodeWith} when testing or when the caller already
 * has a mermaid instance.
 */
export async function validateMermaidCode(
  code: string,
): Promise<MermaidValidationResult> {
  const mermaid = await getMermaidParser();
  mermaid.initialize({ startOnLoad: false, securityLevel: "loose" });
  return validateMermaidCodeWith(code, mermaid);
}

/**
 * Validate a mermaid code string against a provided mermaid parser instance.
 *
 * This is the **core decision function**: given an already-configured parser
 * and code, return whether it parses. No IO, no global state, no silent
 * rewriting — a failed parse is reported to the caller so the agent can fix
 * the source. Configuration (initialize) is the shell's job.
 */
export async function validateMermaidCodeWith(
  code: string,
  mermaid: MermaidParser,
): Promise<MermaidValidationResult> {
  const diagramType = detectDiagramType(code);

  try {
    await mermaid.parse(code);
    return { ok: true, diagramType };
  } catch (error) {
    return {
      ok: false,
      error: formatMermaidError(error),
      diagramType,
    };
  }
}

type MermaidCodeRef = {
  path: string;
  codeKey: "code" | "definition";
  code: string;
};

/**
 * Pure: check if a record is a mermaid node and extract its code ref.
 * Returns null if the record is not a mermaid node or has no parseable code.
 */
function extractMermaidCodeRef(
  record: Record<string, unknown>,
  path: string,
): MermaidCodeRef | null {
  if (record.type !== "mermaid") return null;
  const props = record.props;
  if (!props || typeof props !== "object" || Array.isArray(props)) return null;
  const p = props as Record<string, unknown>;
  const codeKey =
    typeof p.code === "string"
      ? "code"
      : typeof p.definition === "string"
        ? "definition"
        : null;
  if (!codeKey) return null;
  return { path, codeKey, code: p[codeKey] as string };
}

/**
 * Pure: Recursively walk a spec tree and collect all mermaid code refs.
 * No IO, no mutation — just structural traversal.
 */
function collectMermaidCodeRefs(
  value: unknown,
  path: string,
  refs: MermaidCodeRef[],
): void {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      collectMermaidCodeRefs(value[i], `${path}[${i}]`, refs);
    }
    return;
  }

  if (!value || typeof value !== "object") return;

  const record = value as Record<string, unknown>;

  // Collect ref if this is a mermaid node
  const ref = extractMermaidCodeRef(record, path);
  if (ref) refs.push(ref);

  // Recurse into non-structural keys
  for (const [key, entry] of Object.entries(record)) {
    if (key === "type" || key === "props") continue;
    collectMermaidCodeRefs(entry, `${path}.${key}`, refs);
  }

  // Recurse into props
  if (
    record.props &&
    typeof record.props === "object" &&
    !Array.isArray(record.props)
  ) {
    collectMermaidCodeRefs(record.props, `${path}.props`, refs);
  }
}

/**
 * Orchestrator: validates mermaid nodes in a spec tree.
 *
 * Architecture (Functional Core, Imperative Shell):
 *   1. Pure tree walk → collect all code refs (core)
 *   2. Validate each ref via injected mermaid parser (shell — IO)
 *   3. Collect errors (core)
 *
 * No auto-fix / silent rewriting: a node that does not parse is reported
 * verbatim so the agent can fix the source code.
 */
async function collectMermaidErrors(
  value: unknown,
  path: string,
  mermaid: MermaidParser,
): Promise<string[]> {
  // Phase 1: Pure tree walk — collect all mermaid code references
  const refs: MermaidCodeRef[] = [];
  collectMermaidCodeRefs(value, path, refs);

  // Phase 2: Validate each code snippet against the real parser (IO)
  const results = await Promise.all(
    refs.map(async (ref) => {
      const result = await validateMermaidCodeWith(ref.code, mermaid);
      return { ...ref, result };
    }),
  );

  // Phase 3: Collect errors
  const errors: string[] = [];
  for (const { path: refPath, result } of results) {
    if (result.ok === false) {
      const diagramType = result.diagramType ?? "unknown";
      errors.push(`${refPath}<mermaid:${diagramType}>: ${result.error}`);
    }
  }

  return errors;
}

/**
 * Validate all mermaid nodes in a spec against the real parser.
 * Returns all parse errors (no auto-fix, no silent rewriting).
 *
 * Shell: acquires + configures mermaid once, threads it through recursive
 * validation. Core: {@link validateMermaidCodeWith} does the actual parse.
 */
export async function validateMermaidNodesInSpec(
  spec: VisualArtifactSpec,
): Promise<{ errors: string[] }> {
  const mermaid = await getMermaidParser();
  mermaid.initialize({ startOnLoad: false, securityLevel: "loose" });
  const errors = await collectMermaidErrors(spec, "", mermaid);
  return { errors };
}

/**
 * Format collected mermaid node errors into an agent-readable message.
 * Pure: value in / value out, no IO.
 *
 * Input entries look like `nodes[14]<mermaid:flowchart>: Expecting ...`;
 * each is expanded with the diagram type and type-specific advice.
 */
export function formatMermaidValidationErrors(errors: string[]): string {
  const details = errors
    .map((err) => {
      // Match with optional diagram type: nodes[N]<mermaid:type> or nodes[N]<mermaid>
      // Capture everything between : and > so hyphens in stateDiagram-v2 work.
      const match = err.match(/^(.*?<mermaid(?::([^>]+))?>):\s*(.*)$/u);
      if (!match) return `  • ${err}`;
      const [, location, diagramType, parseMsg] = match;

      // Get type-specific advice
      const typeAdvice = getTypeAdviceForDiagram(diagramType);
      const adviceLines = typeAdvice
        ? `    ${typeAdvice.map((a) => `• ${a}`).join("\n    ")}`
        : `    • Wrap ALL labels with quotes: N["label text"] not N[label text]\n    • Avoid parentheses () inside unquoted labels`;

      return [
        `  • ${location}`,
        `    Diagram type: ${diagramType ?? "unknown"}`,
        `    Parse error: ${parseMsg}`,
        `    Type-specific tips:\n${adviceLines}`,
      ].join("\n");
    })
    .join("\n");

  return (
    `MERMAID_VALIDATION_ERROR: ${errors.length} diagram(s) failed to parse.\n\n` +
    `${details}\n\n` +
    "If you continue to have issues, try:\n" +
    '1. Use N["label"] with double quotes for ALL bracket labels\n' +
    "2. Avoid inline ::: after bracket — put `:::class` on a separate line\n" +
    "3. Check the type-specific tips above for your diagram type"
  );
}
