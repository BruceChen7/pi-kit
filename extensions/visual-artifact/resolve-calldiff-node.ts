/**
 * Host-side macro node resolver: `calldiff-callflow` → concrete nodes.
 *
 * Functional Core / Imperative Shell split:
 * - Pure: traversal, param mapping/validation, budget math, error phrasing,
 *   summary phrasing — all testable with injected deps, no IO, no process
 *   globals. Nesting rules are imported from the schema module (single
 *   source of truth); the session-cwd default is resolved by the pipeline
 *   shell, not here.
 * - Shell (injected): `runCalldiffJson` (spawns the CLI), `parseCalldiffJson`,
 *   `calldiffResultToSpec` (bridge). The abort `signal` is attached to the
 *   runner call here (it is not part of the pure options mapping).
 *
 * Identical embedded nodes (same run options) are deduplicated within one
 * resolution: the CLI subprocess runs once, and each node still re-expands
 * with its own title and budget.
 *
 * A `calldiff-callflow` node is NOT a renderer node: the data is derived (a
 * git/AST subprocess), so the host must execute calldiff while processing the
 * spec, then replace the node with the same ordinary nodes the standalone
 * calldiff artifact used to produce. Agents declare parameters only.
 */

import {
  type CalldiffResult,
  countDiffStatuses,
  type DiffStatusCounts,
  type ParseCalldiffResult,
} from "../shared/calldiff-json.ts";
import type {
  CalldiffRunOptions,
  CalldiffRunOutcome,
} from "../shared/calldiff-runner.ts";
import type {
  CalldiffArtifactOptions,
  CalldiffRenderOptions,
} from "./calldiff-bridge.ts";
import {
  CONTAINER_GROUP_KEYS,
  getNestedNodeGroups,
  NESTED_GROUP_KEYS,
  type ArtifactNode,
  LIMITS,
  type VisualArtifactSpec,
} from "./artifact-schema.ts";
import { toEntries, toOptionalString, toStringArray } from "./tool-helpers.ts";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/**
 * Run parameters for the calldiff CLI (what actually goes on the command
 * line), plus the render knobs from {@link CalldiffRenderOptions} — the
 * shared source with `CalldiffArtifactOptions`, so the macro node props
 * cannot drift from the bridge options.
 */
export type CalldiffNodeProps = CalldiffRenderOptions & {
  mode?: "diff" | "tree" | "reach";
  from?: string;
  to?: string;
  entry?: string | string[];
  target?: string;
  paths?: string[];
  maxDepth?: number;
};

/**
 * Canonical prop-key list for `calldiff-callflow` — the runtime mirror of
 * {@link CalldiffNodeProps}. The agent-facing catalog entry
 * (artifact-schema.ts) must stay in sync; the guard test asserts parity.
 */
export const CALLLDIFF_NODE_PROP_KEYS = [
  "mode",
  "from",
  "to",
  "entry",
  "target",
  "paths",
  "maxDepth",
  "title",
  "maxEntries",
  "maxNodesPerTree",
  "maxAsciiLines",
] as const;

// Compile-time guard: the canonical key list must cover exactly the props.
type _CalldiffPropKeys = (typeof CALLLDIFF_NODE_PROP_KEYS)[number];
type _CalldiffKeyCoverage = keyof CalldiffNodeProps extends _CalldiffPropKeys
  ? _CalldiffPropKeys extends keyof CalldiffNodeProps
    ? true
    : never
  : never;
const _calldiffKeysCovered: _CalldiffKeyCoverage = true;

export type CalldiffReport =
  | { ok: true; summary: string }
  | { ok: false; summary: string };

export type CalldiffResolveDeps = {
  /**
   * Session working directory — already resolved by the pipeline shell
   * (defaults to `process.cwd()` there, never inside the pure core).
   */
  cwd: string;
  signal?: AbortSignal;
  runCalldiffJson: (options: CalldiffRunOptions) => Promise<CalldiffRunOutcome>;
  parseCalldiffJson: (raw: string) => ParseCalldiffResult;
  calldiffResultToSpec: (
    result: CalldiffResult,
    options?: CalldiffArtifactOptions,
  ) => VisualArtifactSpec;
};

export type CalldiffResolveResult = {
  spec: VisualArtifactSpec;
  reports: CalldiffReport[];
};

/* ------------------------------------------------------------------ */
/*  Pure: node traversal (shares the schema's nesting rules)           */
/* ------------------------------------------------------------------ */

export const isCalldiffNode = (node: ArtifactNode): boolean =>
  node.type === "calldiff-callflow";

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * All nested node groups of a record, wherever they live: the spec carries
 * its groups at the top level (`spec.nodes`), nodes carry theirs under
 * `props`. Both levels are merged so traversal is uniform for specs and
 * nodes — the exact nesting rules the schema validator applies.
 */
const groupsOf = (record: Record<string, unknown>): ArtifactNode[][] => {
  const props = asRecord(record.props);
  return [
    ...getNestedNodeGroups(record),
    ...(props ? getNestedNodeGroups(props) : []),
  ];
};

/** True when the spec (top-level or nested) contains a calldiff node. */
export const hasCalldiffNodes = (value: unknown): boolean => {
  if (Array.isArray(value)) {
    return value.some((item) => hasCalldiffNodes(item));
  }
  const record = asRecord(value);
  if (!record) return false;
  if (
    record.type === "calldiff-callflow" ||
    asRecord(record.props)?.type === "calldiff-callflow"
  ) {
    return true;
  }
  return groupsOf(record).some((group) => hasCalldiffNodes(group));
};

/**
 * Recursively walk nested node groups inside one node's props, applying
 * `walk` to every child group. Returns the (possibly new) node; non-container
 * props are kept by reference.
 */
const walkGroups = async (
  node: ArtifactNode,
  walk: (nodes: ArtifactNode[]) => Promise<ArtifactNode[]>,
): Promise<ArtifactNode> => {
  const props = node.props;
  if (!props || typeof props !== "object" || Array.isArray(props)) return node;

  let changed = false;
  const nextProps: Record<string, unknown> = { ...props };

  for (const key of NESTED_GROUP_KEYS) {
    const group = props[key];
    if (!Array.isArray(group)) continue;
    const next = await walk(group as ArtifactNode[]);
    if (next !== (group as ArtifactNode[])) {
      changed = true;
      nextProps[key] = next;
    }
  }

  for (const key of CONTAINER_GROUP_KEYS) {
    const list = props[key];
    if (!Array.isArray(list)) continue;
    const nextList: unknown[] = [];
    let listChanged = false;
    for (const item of list) {
      const rec = asRecord(item);
      if (!rec || !Array.isArray(rec.nodes)) {
        nextList.push(item);
        continue;
      }
      const nextNodes = await walk(rec.nodes as ArtifactNode[]);
      if (nextNodes !== (rec.nodes as ArtifactNode[])) {
        listChanged = true;
        nextList.push({ ...rec, nodes: nextNodes });
      } else {
        nextList.push(item);
      }
    }
    if (listChanged) {
      changed = true;
      nextProps[key] = nextList;
    }
  }

  return changed ? ({ ...node, props: nextProps } as ArtifactNode) : node;
};

/**
 * Count every node (spec + all nested groups) recursively — mirrors the
 * validator's `maxTotalNodes` accounting so the budget stays aligned with
 * what `validate` enforces on the expanded spec.
 */
export const countNodesDeep = (value: unknown): number => {
  if (Array.isArray(value)) {
    let total = 0;
    for (const item of value) total += countNodesDeep(item);
    return total;
  }
  const record = asRecord(value);
  if (!record) return 0;
  let total = 1;
  for (const group of groupsOf(record)) {
    total += countNodesDeep(group);
  }
  return total;
};

/* ------------------------------------------------------------------ */
/*  Pure: params → run options (with validation)                       */
/* ------------------------------------------------------------------ */

export type RunOptionsResult =
  | { ok: true; options: CalldiffRunOptions }
  | { ok: false; error: string };

export const toCalldiffRunOptions = (
  props: Record<string, unknown>,
  cwd: string,
): RunOptionsResult => {
  const mode =
    props.mode === "tree" || props.mode === "reach" ? props.mode : "diff";
  const entries = toEntries(props.entry);
  const target = toOptionalString(props.target);

  if (mode !== "diff" && !entries) {
    return {
      ok: false,
      error:
        "calldiff tree/reach require --entry (functionName or ClassName.method).",
    };
  }
  if (mode === "reach" && !target) {
    return { ok: false, error: "calldiff reach requires a target symbol." };
  }

  return {
    ok: true,
    options: {
      cwd,
      mode,
      from: toOptionalString(props.from),
      to: toOptionalString(props.to),
      entries,
      target,
      paths: toStringArray(props.paths),
      maxDepth:
        typeof props.maxDepth === "number" && props.maxDepth > 0
          ? props.maxDepth
          : undefined,
    },
  };
};

/* ------------------------------------------------------------------ */
/*  Pure: outcome/parse failure → callout reason                       */
/* ------------------------------------------------------------------ */

export const formatCalldiffError = (outcome: CalldiffRunOutcome): string => {
  if (outcome.status === "error") {
    if (outcome.code === "no-git-repo") {
      return (
        "calldiff needs a git work tree — this session is not inside one. " +
        "Run the tool from a git repository directory."
      );
    }
    if (outcome.code === "aborted") {
      return "calldiff run aborted.";
    }
    return (
      `calldiff failed (${outcome.code}): ${outcome.message} ` +
      "Install it with `npm install -g calldiff` or retry when a network " +
      "connection is available for the npx fallback."
    );
  }
  return "calldiff returned no output.";
};

/* ------------------------------------------------------------------ */
/*  Pure: budget math                                                  */
/* ------------------------------------------------------------------ */

export type Budget = {
  usedTop: number;
  usedTotal: number;
};

/** Cost model for an expanded node before capping (conservative: code-block present). */
const EXPANDED_BASE_TOP: Record<string, number> = {
  diff: 3, // heading + summary text + table (or callout when empty)
  tree: 2, // heading + summary text
  reach: 2,
};
const EXPANDED_BASE_TOTAL: Record<string, number> = {
  diff: 3,
  tree: 2,
  reach: 2,
};
const PER_ENTRY_TOP = 3; // section + mermaid + code-block
const PER_ENTRY_TOTAL = 3;

export const createBudget = (spec: VisualArtifactSpec): Budget => {
  const topLevel: ArtifactNode[] = [];
  for (const node of spec.nodes) {
    if (!isCalldiffNode(node)) topLevel.push(node);
  }
  return {
    usedTop: topLevel.length,
    usedTotal: countNodesDeep(topLevel),
  };
};

/**
 * How many detail entrypoints the expansion may render given budget
 * remaining and the caller's explicit cap. Pure — exported for tests.
 */
export const computeEntryCap = (
  mode: "diff" | "tree" | "reach",
  availableEntries: number,
  options: { maxEntries?: number },
  budget: Budget,
): number => {
  if (availableEntries === 0) return 0;
  const baseTop = EXPANDED_BASE_TOP[mode];
  const baseTotal = EXPANDED_BASE_TOTAL[mode];
  const remainingTop = LIMITS.maxTopLevelNodes - budget.usedTop;
  const remainingTotal = LIMITS.maxTotalNodes - budget.usedTotal;

  const byTop = Math.max(
    0,
    Math.floor((remainingTop - baseTop - 1) / PER_ENTRY_TOP),
  );
  const byTotal = Math.max(
    0,
    Math.floor((remainingTotal - baseTotal - 1) / PER_ENTRY_TOTAL),
  );
  const explicit = options.maxEntries ?? 8;
  return Math.min(availableEntries, explicit, byTop, byTotal);
};

/* ------------------------------------------------------------------ */
/*  Pure: report phrasing                                              */
/* ------------------------------------------------------------------ */

const summarizeDiff = (
  result: Extract<CalldiffResult, { mode: "diff" }>,
  capped: boolean,
  cap: number,
): string => {
  if (result.trees.length === 0) {
    return "no call-flow changes";
  }
  const total = result.trees.reduce<DiffStatusCounts>(
    (acc, entry) => {
      const counts = countDiffStatuses(entry.tree);
      acc.added += counts.added;
      acc.removed += counts.removed;
      acc.same += counts.same;
      return acc;
    },
    { added: 0, removed: 0, same: 0 },
  );
  const shown = capped ? ` (${cap} entrypoint(s) shown)` : "";
  return `${result.trees.length} entrypoint(s) with changed call trees (+${total.added} / -${total.removed} / ~${total.same})${shown}`;
};

const summarizeResult = (
  result: CalldiffResult,
  capped: boolean,
  cap: number,
): string => {
  if (result.mode === "diff") {
    return summarizeDiff(result, capped, cap);
  }
  if (result.mode === "tree") {
    const shown = capped ? ` (${cap} entrypoint(s) shown)` : "";
    return `${result.trees.length} entrypoint(s)${shown}`;
  }
  const shown = capped ? ` (${cap} path(s) shown)` : "";
  return `${result.paths.length} path(s)${shown}`;
};

/* ------------------------------------------------------------------ */
/*  Shell: per-node expansion                                          */
/* ------------------------------------------------------------------ */

/**
 * Stable cache key for a calldiff CLI run: only the inputs that reach the
 * command line. Identical embedded nodes (same props) share one subprocess
 * per resolution.
 */
const runOptionsKey = (options: CalldiffRunOptions): string =>
  JSON.stringify({
    cwd: options.cwd,
    mode: options.mode,
    from: options.from,
    to: options.to,
    entries: options.entries,
    target: options.target,
    paths: options.paths,
    maxDepth: options.maxDepth,
  });

const unavailableCallout = (reason: string): ArtifactNode => ({
  type: "callout",
  props: { title: "Call-flow unavailable", text: reason, variant: "info" },
});

const expandNode = async (
  node: ArtifactNode,
  budget: Budget,
  deps: CalldiffResolveDeps,
  runCache: Map<string, CalldiffRunOutcome>,
): Promise<{ nodes: ArtifactNode[]; report: CalldiffReport }> => {
  const props = node.props;

  const paramResult = toCalldiffRunOptions(props, deps.cwd);
  if (paramResult.ok === false) {
    return {
      nodes: [unavailableCallout(paramResult.error)],
      report: { ok: false, summary: `calldiff-callflow: ${paramResult.error}` },
    };
  }

  // Dedup: identical run options across nodes in one resolution run the CLI
  // exactly once; each node still re-expands with its own title/budget.
  // The abort signal is shell state, attached at call time — deliberately not
  // part of the cache key (the shared run must be abortable).
  const key = runOptionsKey(paramResult.options);
  let outcome = runCache.get(key);
  if (!outcome) {
    outcome = await deps.runCalldiffJson({
      ...paramResult.options,
      ...(deps.signal ? { signal: deps.signal } : {}),
    });
    runCache.set(key, outcome);
  }
  if (outcome.status !== "ok") {
    const reason = formatCalldiffError(outcome);
    return {
      nodes: [unavailableCallout(reason)],
      report: { ok: false, summary: `calldiff unavailable: ${reason}` },
    };
  }

  const parsed = deps.parseCalldiffJson(outcome.stdout);
  if (parsed.status === "error") {
    const reason = `calldiff output could not be parsed: ${parsed.error}`;
    return {
      nodes: [unavailableCallout(reason)],
      report: { ok: false, summary: reason },
    };
  }

  const result = parsed.result;
  const mode = result.mode;
  const available =
    mode === "reach" ? result.paths.length : result.trees.length;
  const cap = computeEntryCap(mode, available, props, budget);

  // Budget exhausted: expanding even the base (heading/table/… ) would blow
  // the top-level / total node limits. Degrade the whole node to a single
  // callout instead of producing an artifact that fails validation.
  if (available > 0 && cap < 1) {
    const reason =
      "Call-flow detail omitted: the artifact node budget cannot fit the expanded call-flow.";
    return {
      nodes: [unavailableCallout(reason)],
      report: {
        ok: true,
        summary: `${available} entrypoint(s) with changes (detail omitted — artifact node budget exhausted)`,
      },
    };
  }

  const title = toOptionalString(props.title);

  const expanded = deps.calldiffResultToSpec(result, {
    title,
    maxEntries: cap,
    maxNodesPerTree:
      typeof props.maxNodesPerTree === "number" && props.maxNodesPerTree > 0
        ? props.maxNodesPerTree
        : undefined,
    maxAsciiLines:
      typeof props.maxAsciiLines === "number" ? props.maxAsciiLines : undefined,
  });

  const capped = cap < available;
  const summary = summarizeResult(result, capped, cap);

  // Update budget with the actually expanded footprint.
  budget.usedTop += expanded.nodes.length;
  budget.usedTotal += countNodesDeep(expanded.nodes);

  return { nodes: expanded.nodes, report: { ok: true, summary } };
};

/* ------------------------------------------------------------------ */
/*  Orchestrator                                                       */
/* ------------------------------------------------------------------ */

export const resolveCalldiffNodes = async (
  spec: VisualArtifactSpec,
  deps: CalldiffResolveDeps,
): Promise<CalldiffResolveResult> => {
  if (!hasCalldiffNodes(spec)) {
    return { spec, reports: [] };
  }

  const reports: CalldiffReport[] = [];
  const budget = createBudget(spec);
  // One cache per resolution: identical run options → one CLI subprocess.
  const runCache = new Map<string, CalldiffRunOutcome>();

  const walk = async (nodes: ArtifactNode[]): Promise<ArtifactNode[]> => {
    const out: ArtifactNode[] = [];
    let changed = false;
    for (const node of nodes) {
      if (isCalldiffNode(node)) {
        const { nodes: expanded, report } = await expandNode(
          node,
          budget,
          deps,
          runCache,
        );
        reports.push(report);
        out.push(...expanded);
        changed = true;
      } else {
        const next = await walkGroups(node, walk);
        out.push(next);
        if (next !== node) changed = true;
      }
    }
    return changed ? out : nodes;
  };

  const nextNodes = await walk(spec.nodes);
  return {
    spec: { ...spec, nodes: nextNodes },
    reports,
  };
};
