import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type {
  CalldiffRunErrorCode,
  CalldiffRunOutcome,
} from "../shared/calldiff-runner.ts";
import { getNestedNodeGroups, NODE_TYPE_CATALOG } from "./artifact-schema.ts";
import {
  type CalldiffNode,
  type CalldiffResult,
  calldiffResultToSpec,
  parseCalldiffJson,
} from "./calldiff-bridge.ts";
import {
  CALLLDIFF_NODE_PROP_KEYS,
  type CalldiffNodeProps,
  type CalldiffResolveDeps,
  computeEntryCap,
  createBudget,
  hasCalldiffNodes,
  resolveCalldiffNodes,
  toCalldiffRunOptions,
} from "./resolve-calldiff-node.ts";

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

const makeNode = (
  key: string,
  label: string,
  overrides: Partial<CalldiffNode> = {},
): CalldiffNode => ({
  key,
  label,
  children: [],
  ...overrides,
});

const diffResult: CalldiffResult = {
  mode: "diff",
  from: "abc123",
  to: "WORKTREE",
  trees: [
    {
      entry: "PiService.createAgentSession",
      ascii:
        "  PiService.createAgentSession(options)\n- ├─ AuthStorage.create()\n+ ├─ ModelRegistry.create()",
      tree: makeNode("root", "PiService.createAgentSession", {
        status: "same",
        children: [
          makeNode("a", "AuthStorage.create()", { status: "removed" }),
          makeNode("b", "ModelRegistry.create()", { status: "added" }),
        ],
      }),
    },
    {
      entry: "boot",
      ascii: "  boot()\n+ ├─ register()",
      tree: makeNode("boot", "boot()", {
        status: "same",
        children: [makeNode("r", "register()", { status: "added" })],
      }),
    },
  ],
  ascii: "  2 entrypoints",
};

const emptyDiffResult: CalldiffResult = {
  ...diffResult,
  trees: [],
  ascii: "",
};

const treeResult: CalldiffResult = {
  mode: "tree",
  ref: "HEAD",
  trees: [
    {
      entry: "boot",
      ascii: "  boot()\n  └─ register()",
      tree: makeNode("boot", "boot()", {
        children: [makeNode("r", "register()")],
      }),
    },
  ],
  ascii: "  1 entrypoint",
};

const reachResult: CalldiffResult = {
  mode: "reach",
  ref: "HEAD",
  from: "A",
  to: "B",
  paths: [
    {
      entry: "A → B",
      ascii: "  A\n  └─ B",
      tree: makeNode("A", "A", { children: [makeNode("B", "B")] }),
    },
  ],
  ascii: "  1 path",
};

const okOutcome = (result: CalldiffResult): CalldiffRunOutcome => ({
  status: "ok",
  stdout: JSON.stringify(result),
});

const errOutcome = (
  code: CalldiffRunErrorCode,
  message: string,
): CalldiffRunOutcome => ({ status: "error", code, message });

const makeDeps = (
  run: () => CalldiffRunOutcome,
): {
  deps: CalldiffResolveDeps;
  runMock: ReturnType<typeof vi.fn>;
} => {
  const runMock = vi.fn(async () => run());
  const deps: CalldiffResolveDeps = {
    cwd: "/repo",
    signal: undefined,
    runCalldiffJson: runMock,
    parseCalldiffJson,
    calldiffResultToSpec,
  };
  return { deps, runMock };
};

const calldiffNode = (props: Record<string, unknown> = {}) => ({
  type: "calldiff-callflow" as const,
  props,
});

const typesOf = (nodes: { type: string }[]): string[] =>
  nodes.map((n) => n.type);

/**
 * Collect every node type (spec + nested groups), following the same nesting
 * rules the resolver and validator share — no string matching on JSON.
 */
const collectTypesDeep = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectTypesDeep(item));
  }
  const record = value as Record<string, unknown> | null;
  if (!record || typeof record !== "object") return [];
  const out: string[] = [];
  if (typeof record.type === "string") out.push(record.type);
  const props =
    record.props && typeof record.props === "object"
      ? (record.props as Record<string, unknown>)
      : undefined;
  for (const group of getNestedNodeGroups(record)) {
    out.push(...collectTypesDeep(group));
  }
  if (props) {
    for (const group of getNestedNodeGroups(props)) {
      out.push(...collectTypesDeep(group));
    }
  }
  return out;
};

/* ------------------------------------------------------------------ */
/*  Traversal                                                          */
/* ------------------------------------------------------------------ */

describe("hasCalldiffNodes", () => {
  it("detects top-level calldiff nodes", () => {
    expect(hasCalldiffNodes({ type: "text", props: { text: "x" } })).toBe(
      false,
    );
    expect(hasCalldiffNodes(calldiffNode({}))).toBe(true);
  });

  it("detects nested calldiff nodes (accordion/tabs/side-by-side/card/section)", () => {
    const nested = {
      type: "accordion",
      props: {
        items: [
          {
            title: "A",
            nodes: [
              {
                type: "section",
                props: { title: "s", nodes: [calldiffNode({})] },
              },
            ],
          },
        ],
      },
    };
    expect(hasCalldiffNodes(nested)).toBe(true);
  });
});

describe("resolveCalldiffNodes", () => {
  it("is a zero-op when the spec has no calldiff nodes", async () => {
    const { deps } = makeDeps(() => okOutcome(diffResult));
    const spec = {
      slug: "s",
      title: "T",
      nodes: [{ type: "text", props: { text: "hi", size: "md" } }],
    };
    const result = await resolveCalldiffNodes(spec, deps);
    expect(result.reports).toEqual([]);
    expect(result.spec).toBe(spec);
  });

  it("expands a top-level diff node and reports status counts", async () => {
    const { deps, runMock } = makeDeps(() => okOutcome(diffResult));
    const spec = {
      slug: "s",
      title: "T",
      nodes: [calldiffNode({ from: "abc123", to: "WORKTREE" })],
    };
    const result = await resolveCalldiffNodes(spec, deps);

    expect(runMock).toHaveBeenCalledTimes(1);

    const types = typesOf(result.spec.nodes);
    expect(types).toContain("heading");
    expect(types).toContain("text");
    expect(types).toContain("table");
    expect(types).toContain("section");
    expect(collectTypesDeep(result.spec.nodes)).toEqual(
      expect.arrayContaining(["mermaid", "code-block"]),
    );
    expect(collectTypesDeep(result.spec.nodes)).not.toContain(
      "calldiff-callflow",
    );

    expect(result.reports).toHaveLength(1);
    expect(result.reports[0].ok).toBe(true);
    if (result.reports[0].ok) {
      expect(result.reports[0].summary).toContain("2 entrypoint(s)");
      expect(result.reports[0].summary).toContain("+2 / -1");
    }
  });

  it("forwards the abort signal to the CLI runner", async () => {
    const { deps, runMock } = makeDeps(() => okOutcome(diffResult));
    const controller = new AbortController();
    const result = await resolveCalldiffNodes(
      { slug: "s", title: "T", nodes: [calldiffNode({})] },
      { ...deps, signal: controller.signal },
    );
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(runMock.mock.calls[0][0]).toMatchObject({
      signal: controller.signal,
    });
    expect(result.reports[0].ok).toBe(true);
  });

  it("expands nodes nested inside containers", async () => {
    const { deps, runMock } = makeDeps(() => okOutcome(treeResult));
    const spec = {
      slug: "s",
      title: "T",
      nodes: [
        {
          type: "accordion",
          props: {
            items: [
              {
                title: "A",
                nodes: [calldiffNode({ mode: "tree", entry: "boot" })],
              },
            ],
          },
        },
        {
          type: "side-by-side",
          props: {
            left: [calldiffNode({ mode: "tree", entry: "register" })],
            right: [{ type: "text", props: { text: "r", size: "sm" } }],
          },
        },
      ],
    };
    const result = await resolveCalldiffNodes(spec, deps);
    expect(runMock).toHaveBeenCalledTimes(2);
    expect(result.reports).toHaveLength(2);
    const types = collectTypesDeep(result.spec.nodes);
    expect(types).not.toContain("calldiff-callflow");
    expect(types).toContain("mermaid");
  });

  it("dedupes identical run options: one CLI run, per-node expansion", async () => {
    const { deps, runMock } = makeDeps(() => okOutcome(diffResult));
    const spec = {
      slug: "s",
      title: "T",
      nodes: [
        calldiffNode({ from: "abc123", to: "WORKTREE", title: "First" }),
        calldiffNode({ from: "abc123", to: "WORKTREE", title: "Second" }),
      ],
    };
    const result = await resolveCalldiffNodes(spec, deps);

    expect(runMock).toHaveBeenCalledTimes(1);
    expect(result.reports).toHaveLength(2);
    // Each node still expands independently (own title, own budget share).
    const headings = result.spec.nodes
      .filter((n) => n.type === "heading")
      .map((n) => (n.props as { text?: string }).text);
    expect(headings).toEqual(["First", "Second"]);
  });

  it("re-runs the CLI when run options differ", async () => {
    const { deps, runMock } = makeDeps(() => okOutcome(diffResult));
    await resolveCalldiffNodes(
      {
        slug: "s",
        title: "T",
        nodes: [
          calldiffNode({ from: "abc123", to: "WORKTREE" }),
          calldiffNode({ from: "HEAD", to: "WORKTREE" }),
        ],
      },
      deps,
    );
    expect(runMock).toHaveBeenCalledTimes(2);
  });

  it("degrades tree without entry to a callout without running calldiff", async () => {
    const { deps, runMock } = makeDeps(() => okOutcome(diffResult));
    const result = await resolveCalldiffNodes(
      { slug: "s", title: "T", nodes: [calldiffNode({ mode: "tree" })] },
      deps,
    );
    expect(runMock).not.toHaveBeenCalled();
    expect(result.reports[0].ok).toBe(false);
    if (result.reports[0].ok === false) {
      expect(result.reports[0].summary).toContain("--entry");
    }
    expect(result.spec.nodes[0].type).toBe("callout");
  });

  it("degrades reach without target to a callout", async () => {
    const { deps, runMock } = makeDeps(() => okOutcome(diffResult));
    const result = await resolveCalldiffNodes(
      {
        slug: "s",
        title: "T",
        nodes: [calldiffNode({ mode: "reach", entry: "A" })],
      },
      deps,
    );
    expect(runMock).not.toHaveBeenCalled();
    expect(result.reports[0].ok).toBe(false);
  });

  it("degrades to a 'Call-flow unavailable' callout on no-git-repo with guidance", async () => {
    const { deps } = makeDeps(() => errOutcome("no-git-repo", "not a repo"));
    const result = await resolveCalldiffNodes(
      { slug: "s", title: "T", nodes: [calldiffNode({})] },
      deps,
    );
    const callout = result.spec.nodes[0] as unknown as {
      type: string;
      props: { text: string };
    };
    expect(callout.type).toBe("callout");
    expect(callout.props.text).toContain("git work tree");
    expect(result.reports[0].ok).toBe(false);
  });

  it("degrades with an install hint on binary-not-found", async () => {
    const { deps } = makeDeps(() =>
      errOutcome("binary-not-found", "ENOENT calldiff"),
    );
    const result = await resolveCalldiffNodes(
      { slug: "s", title: "T", nodes: [calldiffNode({})] },
      deps,
    );
    const callout = result.spec.nodes[0] as unknown as {
      props: { text: string };
    };
    expect(callout.props.text).toContain("npm install -g calldiff");
  });

  it("degrades on aborted runs with an explicit message", async () => {
    const { deps } = makeDeps(() => errOutcome("aborted", "aborted"));
    const result = await resolveCalldiffNodes(
      { slug: "s", title: "T", nodes: [calldiffNode({})] },
      deps,
    );
    const callout = result.spec.nodes[0] as unknown as {
      props: { text: string };
    };
    expect(callout.props.text).toContain("aborted");
  });

  it("degrades on unparseable calldiff output", async () => {
    const { deps } = makeDeps(() => ({
      status: "ok" as const,
      stdout: "not-json",
    }));
    const result = await resolveCalldiffNodes(
      { slug: "s", title: "T", nodes: [calldiffNode({})] },
      deps,
    );
    expect(result.reports[0].ok).toBe(false);
    if (result.reports[0].ok === false) {
      expect(result.reports[0].summary).toContain("could not be parsed");
    }
  });

  it("emits a 'No call-flow changes' callout when nothing changed", async () => {
    const { deps } = makeDeps(() => okOutcome(emptyDiffResult));
    const result = await resolveCalldiffNodes(
      { slug: "s", title: "T", nodes: [calldiffNode({})] },
      deps,
    );
    const callout = result.spec.nodes.find(
      (n) => n.type === "callout",
    ) as unknown as {
      props: { title: string };
    };
    expect(callout.props.title).toBe("No call-flow changes");
    expect(result.reports[0].ok).toBe(true);
    if (result.reports[0].ok) {
      expect(result.reports[0].summary).toContain("no call-flow changes");
    }
  });

  it("expands tree and reach modes", async () => {
    const { deps } = makeDeps(() => okOutcome(treeResult));
    const tree = await resolveCalldiffNodes(
      {
        slug: "s",
        title: "T",
        nodes: [calldiffNode({ mode: "tree", entry: "boot" })],
      },
      deps,
    );
    expect(tree.reports[0].ok).toBe(true);
    if (tree.reports[0].ok) {
      expect(tree.reports[0].summary).toContain("1 entrypoint(s)");
    }
    expect(tree.spec.nodes.some((n) => n.type === "section")).toBe(true);
    expect(collectTypesDeep(tree.spec.nodes)).toContain("mermaid");

    const reachDeps = makeDeps(() => okOutcome(reachResult));
    const reach = await resolveCalldiffNodes(
      {
        slug: "s",
        title: "T",
        nodes: [calldiffNode({ mode: "reach", entry: "A", target: "B" })],
      },
      reachDeps.deps,
    );
    expect(reach.reports[0].ok).toBe(true);
    if (reach.reports[0].ok) {
      expect(reach.reports[0].summary).toContain("1 path(s)");
    }
  });

  it("applies per-node title to the expanded heading", async () => {
    const { deps } = makeDeps(() => okOutcome(diffResult));
    const result = await resolveCalldiffNodes(
      {
        slug: "s",
        title: "T",
        nodes: [calldiffNode({ title: "My Call Flow" })],
      },
      deps,
    );
    const heading = result.spec.nodes.find(
      (n) => n.type === "heading",
    ) as unknown as { props: { text: string } };
    expect(heading.props.text).toBe("My Call Flow");
  });
});

/* ------------------------------------------------------------------ */
/*  Budget                                                             */
/* ------------------------------------------------------------------ */

describe("computeEntryCap", () => {
  it("applies the explicit default cap of 8", () => {
    const cap = computeEntryCap(
      "diff",
      12,
      { maxEntries: undefined },
      { usedTop: 0, usedTotal: 0 },
    );
    expect(cap).toBe(8);
  });

  it("respects available entries below the cap", () => {
    const cap = computeEntryCap(
      "diff",
      2,
      { maxEntries: undefined },
      { usedTop: 0, usedTotal: 0 },
    );
    expect(cap).toBe(2);
  });

  it("returns 0 when nothing is available", () => {
    const cap = computeEntryCap(
      "diff",
      0,
      { maxEntries: undefined },
      { usedTop: 0, usedTotal: 0 },
    );
    expect(cap).toBe(0);
  });

  it("shrinks the cap when the top-level budget is nearly exhausted", () => {
    const cap = computeEntryCap(
      "diff",
      12,
      { maxEntries: undefined },
      { usedTop: 25, usedTotal: 25 },
    );
    // remainingTop = 5 → floor((5 - 3 - 1) / 3) = 0 → degraded later
    expect(cap).toBe(0);
  });

  it("caps total nodes too", () => {
    const cap = computeEntryCap(
      "diff",
      12,
      { maxEntries: undefined },
      { usedTop: 0, usedTotal: 99 },
    );
    expect(cap).toBe(0);
  });
});

describe("budget-aware expansion", () => {
  it("degrades to a single callout when the budget cannot fit detail entries", async () => {
    const { deps, runMock } = makeDeps(() => okOutcome(diffResult));
    // 28 top-level nodes already: room for at most ~0 detail entries.
    const spec = {
      slug: "s",
      title: "T",
      nodes: [
        ...Array.from({ length: 28 }, (_, i) => ({
          type: "text" as const,
          props: { text: `n${i}`, size: "sm" as const },
        })),
        calldiffNode({}),
      ],
    };
    const result = await resolveCalldiffNodes(spec, deps);
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(result.spec.nodes).toHaveLength(29); // 28 texts + 1 callout
    expect(result.spec.nodes[28].type).toBe("callout");
    expect(result.reports[0].ok).toBe(true);
    if (result.reports[0].ok) {
      expect(result.reports[0].summary).toContain("2 entrypoint(s)");
      expect(result.reports[0].summary).toContain("omitted");
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Param mapping                                                      */
/* ------------------------------------------------------------------ */

describe("toCalldiffRunOptions", () => {
  it("maps arrays and strings for entry", () => {
    const r = toCalldiffRunOptions(
      { mode: "tree", entry: ["a", " b "], paths: ["src/"], maxDepth: 5 },
      "/repo",
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.options.entries).toEqual(["a", "b"]);
      expect(r.options.paths).toEqual(["src/"]);
      expect(r.options.maxDepth).toBe(5);
    }
  });

  it("defaults mode to diff when absent or unknown", () => {
    const absent = toCalldiffRunOptions({}, "/repo");
    expect(absent.ok).toBe(true);
    if (absent.ok) expect(absent.options.mode).toBe("diff");
    const unknown = toCalldiffRunOptions({ mode: "bogus" }, "/repo");
    expect(unknown.ok).toBe(true);
    if (unknown.ok) expect(unknown.options.mode).toBe("diff");
  });

  it("passes the shell-resolved cwd through", () => {
    const r = toCalldiffRunOptions({}, "/repo");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.cwd).toBe("/repo");
  });
});

/* ------------------------------------------------------------------ */
/*  Prop contract                                                      */
/* ------------------------------------------------------------------ */

describe("calldiff-callflow prop contract", () => {
  it("lists exactly the CalldiffNodeProps keys in the canonical key list", () => {
    expectTypeOf<keyof CalldiffNodeProps>().toEqualTypeOf<
      (typeof CALLLDIFF_NODE_PROP_KEYS)[number]
    >();
  });

  it("keeps the agent-facing catalog props in sync with the resolver", () => {
    const entry = NODE_TYPE_CATALOG.find((e) => e.type === "calldiff-callflow");
    expect(entry).toBeDefined();
    expect(Object.keys(entry?.props ?? {})).toEqual([
      ...CALLLDIFF_NODE_PROP_KEYS,
    ]);
  });
});

/* ------------------------------------------------------------------ */
/*  Budget helper                                                      */
/* ------------------------------------------------------------------ */

describe("createBudget", () => {
  it("counts only non-calldiff top-level nodes as used", () => {
    const spec = {
      slug: "s",
      title: "T",
      nodes: [
        { type: "text", props: { text: "a", size: "sm", visible: true } },
        calldiffNode({}),
      ],
    };
    const budget = createBudget(spec);
    expect(budget.usedTop).toBe(1);
  });
});
