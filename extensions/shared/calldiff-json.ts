/**
 * calldiff CLI JSON shapes + parsing (shared, dependency-free).
 *
 * The shapes mirror calldiff's own `src/types.ts`
 * (https://github.com/tanishqkancharla/calldiff) so consumers stay
 * dependency-free. This is the pure core: value in / value out, no IO.
 */

/* ------------------------------------------------------------------ */
/*  calldiff JSON shapes                                               */
/* ------------------------------------------------------------------ */

export type CallNodeKind = "call" | "branch";

export type DiffStatus = "same" | "added" | "removed";

export type CalldiffNode = {
  key: string;
  label: string;
  kind?: CallNodeKind;
  /** Present in diff trees; absent in plain tree/reach output. */
  status?: DiffStatus;
  file?: string;
  line?: number;
  endLine?: number;
  children: CalldiffNode[];
};

export type CalldiffTreeResult = {
  entry: string;
  ascii: string;
  tree: CalldiffNode;
};

export type CalldiffResult =
  | {
      mode: "diff";
      from: string;
      to: string;
      message?: string;
      trees: CalldiffTreeResult[];
      ascii: string;
    }
  | {
      mode: "tree";
      ref: string;
      trees: CalldiffTreeResult[];
      ascii: string;
    }
  | {
      mode: "reach";
      ref: string;
      from: string;
      to: string;
      message?: string;
      paths: CalldiffTreeResult[];
      ascii: string;
    };

/* ------------------------------------------------------------------ */
/*  JSON parsing + shape validation                                    */
/* ------------------------------------------------------------------ */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === "string";

/** Safety cap for the recursive node parser (malformed/cyclic input). */
const MAX_NODE_PARSE_DEPTH = 200;

export type ParseCalldiffResult =
  | { status: "ok"; result: CalldiffResult }
  | { status: "error"; error: string };

const parseCalldiffNode = (
  value: unknown,
  depth: number,
): CalldiffNode | null => {
  if (!isRecord(value) || !isString(value.key) || !isString(value.label)) {
    return null;
  }
  const kind = value.kind;
  if (kind !== undefined && kind !== "call" && kind !== "branch") {
    return null;
  }

  const children: CalldiffNode[] = [];
  if (Array.isArray(value.children) && depth < MAX_NODE_PARSE_DEPTH) {
    for (const child of value.children) {
      const parsed = parseCalldiffNode(child, depth + 1);
      if (parsed) {
        children.push(parsed);
      }
    }
  }

  const node: CalldiffNode = {
    key: value.key,
    label: value.label,
    children,
  };
  if (kind === "call" || kind === "branch") {
    node.kind = kind;
  }
  if (
    value.status === "same" ||
    value.status === "added" ||
    value.status === "removed"
  ) {
    node.status = value.status;
  }
  if (isString(value.file)) {
    node.file = value.file;
  }
  if (typeof value.line === "number") {
    node.line = value.line;
  }
  if (typeof value.endLine === "number") {
    node.endLine = value.endLine;
  }
  return node;
};

const parseTreeResults = (value: unknown): CalldiffTreeResult[] | null => {
  if (!Array.isArray(value)) {
    return null;
  }
  const results: CalldiffTreeResult[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !isString(entry.entry) || !isString(entry.ascii)) {
      return null;
    }
    const tree = parseCalldiffNode(entry.tree, 0);
    if (!tree) {
      return null;
    }
    results.push({ entry: entry.entry, ascii: entry.ascii, tree });
  }
  return results;
};

const optionalString = (value: unknown): string | undefined =>
  isString(value) ? value : undefined;

export const parseCalldiffJson = (raw: string): ParseCalldiffResult => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "error", error: "calldiff output is not valid JSON." };
  }
  if (!isRecord(parsed)) {
    return { status: "error", error: "calldiff output is not a JSON object." };
  }

  if (parsed.mode === "diff") {
    if (!isString(parsed.from) || !isString(parsed.to)) {
      return {
        status: "error",
        error: "calldiff diff output is missing from/to refs.",
      };
    }
    const trees = parseTreeResults(parsed.trees);
    if (!trees) {
      return {
        status: "error",
        error: "calldiff diff output has malformed trees.",
      };
    }
    const diffMessage = optionalString(parsed.message);
    return {
      status: "ok",
      result: {
        mode: "diff",
        from: parsed.from,
        to: parsed.to,
        trees,
        ascii: isString(parsed.ascii) ? parsed.ascii : "",
        ...(diffMessage !== undefined ? { message: diffMessage } : {}),
      },
    };
  }

  if (parsed.mode === "tree") {
    if (!isString(parsed.ref)) {
      return { status: "error", error: "calldiff tree output is missing ref." };
    }
    const trees = parseTreeResults(parsed.trees);
    if (!trees) {
      return {
        status: "error",
        error: "calldiff tree output has malformed trees.",
      };
    }
    return {
      status: "ok",
      result: {
        mode: "tree",
        ref: parsed.ref,
        trees,
        ascii: isString(parsed.ascii) ? parsed.ascii : "",
      },
    };
  }

  if (parsed.mode === "reach") {
    if (!isString(parsed.from) || !isString(parsed.to)) {
      return {
        status: "error",
        error: "calldiff reach output is missing from/to symbols.",
      };
    }
    const paths = parseTreeResults(parsed.paths);
    if (!paths) {
      return {
        status: "error",
        error: "calldiff reach output has malformed paths.",
      };
    }
    const reachMessage = optionalString(parsed.message);
    return {
      status: "ok",
      result: {
        mode: "reach",
        ref: isString(parsed.ref) ? parsed.ref : "WORKTREE",
        from: parsed.from,
        to: parsed.to,
        paths,
        ascii: isString(parsed.ascii) ? parsed.ascii : "",
        ...(reachMessage !== undefined ? { message: reachMessage } : {}),
      },
    };
  }

  return { status: "error", error: "calldiff output has an unknown mode." };
};

/* ------------------------------------------------------------------ */
/*  Status counting                                                    */
/* ------------------------------------------------------------------ */

export type DiffStatusCounts = {
  added: number;
  removed: number;
  same: number;
};

export const countDiffStatuses = (node: CalldiffNode): DiffStatusCounts => {
  const counts: DiffStatusCounts = { added: 0, removed: 0, same: 0 };
  const visit = (current: CalldiffNode): void => {
    if (current.status === "added") counts.added += 1;
    else if (current.status === "removed") counts.removed += 1;
    else counts.same += 1;
    for (const child of current.children) {
      visit(child);
    }
  };
  visit(node);
  return counts;
};
