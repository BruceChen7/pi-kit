import {
  aggressiveQuoteLabels,
  decodeLabelHtmlEntities,
  detectDiagramType,
  fixDiamondLabels,
  normalizeFlowchartSquareLabels,
  normalizeLinkText,
  normalizeMermaidCode,
  wrapAllLinkText,
} from "../shared/mermaid-normalize.ts";
import type { VisualArtifactSpec } from "./artifact-schema.ts";

export {
  detectDiagramType,
  getTypeAdviceForDiagram,
  normalizeMermaidCode,
  TIER_1_DIAGRAM_TYPES,
} from "../shared/mermaid-normalize.ts";

export type MermaidParser = {
  initialize(config: Record<string, unknown>): void;
  parse(code: string): Promise<unknown>;
};

let mermaidModule: MermaidParser | null = null;

/* ------------------------------------------------------------------ */
/*  Auto-fix helpers for common mermaid parsing failures               */
/* ------------------------------------------------------------------ */

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

/**
 * Reset the cached mermaid module for test isolation.
 * Call in beforeEach/afterEach when tests must not share mermaid state.
 */
export function resetMermaidModule(): void {
  mermaidModule = null;
}

function formatMermaidError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\n+\.\.*[\s\S]*?\^\n*/u, " ")
    .replace(/Parse error on line \d+:\s*/u, "")
    .trim();
}

export type MermaidValidationResultWithFix =
  | { ok: true; fixedCode?: string; diagramType?: string }
  | { ok: false; error: string; fixedCode?: string; diagramType?: string };

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
  const diagramType = detectDiagramType(code);

  try {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "loose",
    });
    await mermaid.parse(code);
    return { ok: true, diagramType };
  } catch (error) {
    const originalError = formatMermaidError(error);

    // Try auto-fix strategies
    const fixed = await autoFixMermaidCode(code, mermaid);
    if (fixed) {
      return { ok: true, fixedCode: fixed, diagramType };
    }

    return {
      ok: false,
      error: originalError,
      diagramType,
    };
  }
}

type MermaidCodeRef = {
  path: string;
  codeKey: "code" | "definition";
  code: string;
};

type FixEntry = {
  path: string;
  codeKey: string;
  fixedCode: string;
};

type CollectedErrors = {
  errors: string[];
  /** Deep clone of the spec with auto-fixed mermaid code applied. */
  fixedSpec: VisualArtifactSpec | null;
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
 * Pure: Apply a map of path-based fixes to a deep clone of a spec tree.
 * Returns the cloned tree with fixes applied, or the original if no fixes.
 */
function applyMermaidFixes(
  value: unknown,
  path: string,
  fixes: Map<string, FixEntry>,
): unknown {
  if (fixes.size === 0) return value;

  // Check if this exact path has a fix (mermaid node's code)
  const pathFix = fixes.get(path);
  if (pathFix) {
    const record = { ...(value as Record<string, unknown>) };
    return {
      ...record,
      props: {
        ...(record.props as Record<string, unknown>),
        [pathFix.codeKey]: pathFix.fixedCode,
      },
    };
  }

  if (Array.isArray(value)) {
    let changed = false;
    const result = value.map((entry, i) => {
      const fixed = applyMermaidFixes(entry, `${path}[${i}]`, fixes);
      if (fixed !== entry) changed = true;
      return fixed;
    });
    return changed ? result : value;
  }

  if (!value || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  let mutated: Record<string, unknown> | null = null;

  for (const [key, entry] of Object.entries(record)) {
    if (key === "type" || key === "props") continue;
    const fixed = applyMermaidFixes(entry, `${path}.${key}`, fixes);
    if (fixed !== entry) {
      if (!mutated) mutated = { ...record };
      mutated[key] = fixed;
    }
  }

  if (
    record.props &&
    typeof record.props === "object" &&
    !Array.isArray(record.props)
  ) {
    const fixed = applyMermaidFixes(
      record.props as Record<string, unknown>,
      `${path}.props`,
      fixes,
    );
    if (fixed !== record.props) {
      if (!mutated) mutated = { ...record };
      mutated.props = fixed;
    }
  }

  return mutated ?? value;
}

/**
 * Orchestrator: validates mermaid nodes in a spec tree.
 *
 * Architecture (Functional Core, Imperative Shell):
 *   1. Pure tree walk → collect all code refs (core)
 *   2. Validate each ref via injected mermaid parser (shell — IO)
 *   3. Collect errors and fixes (core)
 *   4. Apply fixes to a deep clone (core)
 */
async function collectMermaidErrors(
  value: unknown,
  path: string,
  mermaid: MermaidParser,
): Promise<CollectedErrors> {
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

  // Phase 3: Collect errors and build fixes map
  const errors: string[] = [];
  const fixes = new Map<string, FixEntry>();

  for (const { path, codeKey, code, result } of results) {
    if (result.ok === false) {
      const diagramType = result.diagramType ?? "unknown";
      errors.push(`${path}<mermaid:${diagramType}>: ${result.error}`);
    }
    if (result.fixedCode && result.fixedCode !== code) {
      fixes.set(path, { path, codeKey, fixedCode: result.fixedCode });
    }
  }

  // Phase 4: Apply fixes to a deep clone (pure tree walk)
  const fixedSpec =
    fixes.size > 0
      ? (applyMermaidFixes(value, "", fixes) as VisualArtifactSpec)
      : null;

  return { errors, fixedSpec };
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
