import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ArtifactNode } from "./artifact-schema.ts";
import {
  buildFileImpacts,
  type CalldiffNode,
  type CalldiffResult,
  calldiffResultToSpec,
  callNodeToMermaid,
  countChangedSteps,
  countDiffStatuses,
  countNodes,
  diffNodeToMermaid,
  diffResultToSpec,
  filterDiffResultForFile,
  parseCalldiffJson,
  treeResultToSpec,
} from "./calldiff-bridge.ts";

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
      tree: makeNode(
        "PiService.createAgentSession",
        "PiService.createAgentSession",
        {
          status: "same",
          children: [
            makeNode("AuthStorage.create", "AuthStorage.create()", {
              status: "removed",
            }),
            makeNode("ModelRegistry.create", "ModelRegistry.create()", {
              status: "added",
              children: [
                makeNode("new ModelRegistry", "new ModelRegistry", {
                  status: "added",
                }),
              ],
            }),
          ],
        },
      ),
    },
    {
      entry: "boot",
      ascii: "  boot()\n  ├─ startServer()",
      tree: makeNode("boot", "boot()", {
        status: "same",
        children: [
          makeNode("startServer", "startServer()", { status: "same" }),
        ],
      }),
    },
  ],
  ascii: "full ascii output",
};

/* ------------------------------------------------------------------ */
/*  parseCalldiffJson                                                  */
/* ------------------------------------------------------------------ */

describe("parseCalldiffJson", () => {
  it("parses a valid diff payload", () => {
    const parsed = parseCalldiffJson(JSON.stringify(diffResult));
    expect(parsed.status).toBe("ok");
    if (parsed.status !== "ok") return;
    expect(parsed.result.mode).toBe("diff");
    if (parsed.result.mode !== "diff") return;
    expect(parsed.result.trees).toHaveLength(2);
    expect(parsed.result.trees[0]?.tree.children[0]?.status).toBe("removed");
  });

  it("rejects invalid JSON", () => {
    const parsed = parseCalldiffJson("not json");
    expect(parsed.status).toBe("error");
    if (parsed.status !== "error") return;
    expect(parsed.error).toContain("not valid JSON");
  });

  it("rejects a non-object payload", () => {
    const parsed = parseCalldiffJson("[1,2,3]");
    expect(parsed.status).toBe("error");
  });

  it("rejects unknown modes", () => {
    const parsed = parseCalldiffJson(JSON.stringify({ mode: "explode" }));
    expect(parsed.status).toBe("error");
  });

  it("rejects malformed trees", () => {
    const parsed = parseCalldiffJson(
      JSON.stringify({
        mode: "diff",
        from: "a",
        to: "b",
        trees: [{ entry: "x" }],
      }),
    );
    expect(parsed.status).toBe("error");
  });

  it("rejects malformed nested nodes", () => {
    const parsed = parseCalldiffJson(
      JSON.stringify({
        mode: "diff",
        from: "a",
        to: "b",
        trees: [{ entry: "x", ascii: "", tree: { label: "no key" } }],
      }),
    );
    expect(parsed.status).toBe("error");
  });

  it("parses reach payloads into paths", () => {
    const reach = {
      mode: "reach",
      ref: "HEAD",
      from: "runCheckout",
      to: "sendEmail",
      paths: [
        {
          entry: "runCheckout -> sendEmail",
          ascii: "path ascii",
          tree: makeNode("runCheckout", "runCheckout()", {
            children: [makeNode("sendEmail", "sendEmail()")],
          }),
        },
      ],
      ascii: "x",
    };
    const parsed = parseCalldiffJson(JSON.stringify(reach));
    expect(parsed.status).toBe("ok");
    if (parsed.status !== "ok") return;
    expect(parsed.result.mode).toBe("reach");
    if (parsed.result.mode !== "reach") return;
    expect(parsed.result.paths).toHaveLength(1);
  });

  it("tolerates missing optional ascii/message fields", () => {
    const parsed = parseCalldiffJson(
      JSON.stringify({
        mode: "tree",
        ref: "HEAD",
        trees: [{ entry: "boot", ascii: "", tree: makeNode("boot", "boot()") }],
      }),
    );
    expect(parsed.status).toBe("ok");
  });

  it("caps recursion depth on pathological input", () => {
    let node: unknown = { key: "k", label: "l", children: [] };
    for (let i = 0; i < 500; i += 1) {
      node = { key: `k${i}`, label: `l${i}`, children: [node] };
    }
    const parsed = parseCalldiffJson(
      JSON.stringify({
        mode: "tree",
        ref: "HEAD",
        trees: [{ entry: "deep", ascii: "", tree: node }],
      }),
    );
    expect(parsed.status).toBe("ok");
  });

  it("parses real calldiff CLI output (golden fixture)", () => {
    // Captured from calldiff 0.4.1 (`calldiff diff --format json`) against
    // a controlled fixture repo — the parser must stay compatible with the
    // real CLI shape, not just with hand-written mirrors of it.
    const fixturePath = fileURLToPath(
      new URL(
        path.join("..", "shared", "fixtures", "calldiff-diff-real.json"),
        import.meta.url,
      ),
    );
    const raw = readFileSync(fixturePath, "utf-8");
    const parsed = parseCalldiffJson(raw);
    expect(parsed.status).toBe("ok");
    if (parsed.status !== "ok") return;

    expect(parsed.result.mode).toBe("diff");
    if (parsed.result.mode !== "diff") return;
    expect(parsed.result.from).toBe("HEAD");
    expect(parsed.result.to).toBe("working tree");
    expect(parsed.result.trees).toHaveLength(1);

    const tree = parsed.result.trees[0];
    expect(tree).toBeDefined();
    if (!tree) return;
    expect(tree.entry).toBe("runCheckout");
    expect(tree.ascii).toContain("mergeWorktrees()");
    expect(parsed.result.ascii).toContain("calldiff diff HEAD → working tree");

    // Statuses in the fixture: 3 added (mergeWorktrees, notifyUser, its
    // console.log), 2 removed (sendEmail, its console.log), 3 same (root,
    // gatherPaths, if-branch).
    expect(countDiffStatuses(tree.tree)).toEqual({
      added: 3,
      removed: 2,
      same: 3,
    });

    // Real branch nodes use "if:<cond>" keys and kind "branch".
    const gatherPaths = tree.tree.children.find(
      (n) => n.label === "gatherPaths(options)",
    );
    const branch = gatherPaths?.children.find((n) => n.kind === "branch");
    expect(branch?.key).toBe("if:options.force");
  });
});

/* ------------------------------------------------------------------ */
/*  countDiffStatuses                                                  */
/* ------------------------------------------------------------------ */

describe("countDiffStatuses", () => {
  it("counts added/removed/same recursively", () => {
    const counts = countDiffStatuses(
      makeNode("root", "root", {
        status: "same",
        children: [
          makeNode("a", "a", { status: "added" }),
          makeNode("b", "b", {
            status: "removed",
            children: [makeNode("c", "c", { status: "removed" })],
          }),
        ],
      }),
    );
    expect(counts).toEqual({ added: 1, removed: 2, same: 1 });
  });
});

/* ------------------------------------------------------------------ */
/*  Mermaid conversion                                                 */
/* ------------------------------------------------------------------ */

describe("diffNodeToMermaid", () => {
  it("emits a flowchart with status classDefs and classes", () => {
    const mermaid = diffNodeToMermaid(diffResult.trees[0]?.tree);
    expect(mermaid.startsWith("flowchart TD")).toBe(true);
    expect(mermaid).toContain("classDef added");
    expect(mermaid).toContain("classDef removed");
    expect(mermaid).toContain('n0["PiService.createAgentSession"]');
    expect(mermaid).toContain("class n1 removed");
    expect(mermaid).toContain("class n2 added");
    expect(mermaid).toContain("n0 --> n1");
    expect(mermaid).toContain("n2 --> n3");
  });

  it("escapes quotes and newlines in labels", () => {
    const node = makeNode("k", 'if (a == "x")\n  else', { status: "added" });
    const mermaid = diffNodeToMermaid(node);
    expect(mermaid).toContain("n0[\"if (a == 'x') else\"]");
    expect(mermaid).not.toContain('a == "x"');
  });

  it("marks branch nodes with the branch class", () => {
    const node = makeNode("k", "if (cond)", {
      kind: "branch",
      status: "same",
      children: [makeNode("c", "inner()", { status: "added" })],
    });
    const mermaid = diffNodeToMermaid(node);
    expect(mermaid).toContain("class n0 branch");
    expect(mermaid).toContain("class n1 added");
  });

  it("caps nodes and appends an omission marker", () => {
    const children = Array.from({ length: 10 }, (_, i) =>
      makeNode(`c${i}`, `call${i}()`, { status: "added" }),
    );
    const node = makeNode("root", "root()", { children });
    const mermaid = diffNodeToMermaid(node, { maxNodes: 4 });
    expect(mermaid).toContain("more nodes omitted");
    // 4 rendered ids + 1 omission marker id (edges reuse ids, so count unique)
    const ids = new Set(mermaid.match(/\bn\d+\b/g) ?? []);
    expect(ids.size).toBe(5);
    expect(mermaid).toContain("n0 --> n4");
  });

  it("callNodeToMermaid renders without status classes", () => {
    const mermaid = callNodeToMermaid(
      makeNode("boot", "boot()", { children: [makeNode("s", "start()")] }),
    );
    expect(mermaid).not.toContain("classDef added");
    expect(mermaid).toContain("n0 --> n1");
  });

  it("annotates changed nodes with file:line locations", () => {
    const node = makeNode("k", "parseConfig()", {
      status: "added",
      file: "src/a.ts",
      line: 42,
    });
    const mermaid = diffNodeToMermaid(node);
    expect(mermaid).toContain('n0["parseConfig() (src/a.ts:42)"]');
  });

  it("keeps labels plain for unchanged nodes", () => {
    const node = makeNode("k", "parseConfig()", {
      status: "same",
      file: "src/a.ts",
      line: 42,
    });
    const mermaid = diffNodeToMermaid(node);
    expect(mermaid).toContain('n0["parseConfig()"]');
    expect(mermaid).not.toContain("src/a.ts");
  });
});

/* ------------------------------------------------------------------ */
/*  Spec assembly                                                      */
/* ------------------------------------------------------------------ */

/** Accordion items inside the Paths tab of a rendered spec. */
const accordionItems = (
  spec: ReturnType<typeof diffResultToSpec>,
): {
  title: string;
  nodes: ArtifactNode[];
  defaultOpen: boolean;
}[] => {
  const tabs = spec.nodes.find((node) => node.type === "tabs");
  const pathsTab = (
    tabs?.props as { tabs?: { label: string; nodes: ArtifactNode[] }[] }
  )?.tabs?.find((tab) => tab.label === "Paths");
  const accordion = pathsTab?.nodes.find((node) => node.type === "accordion");
  return (
    (
      accordion?.props as {
        items: { title: string; nodes: ArtifactNode[]; defaultOpen: boolean }[];
      }
    )?.items ?? []
  );
};

const rawTabNodes = (
  spec: ReturnType<typeof diffResultToSpec>,
): ArtifactNode[] => {
  const tabs = spec.nodes.find((node) => node.type === "tabs");
  const rawTab = (
    tabs?.props as { tabs?: { label: string; nodes: ArtifactNode[] }[] }
  )?.tabs?.find((tab) => tab.label === "Raw");
  return rawTab?.nodes ?? [];
};

const pathsTabNodes = (
  spec: ReturnType<typeof diffResultToSpec>,
): ArtifactNode[] => {
  const tabs = spec.nodes.find((node) => node.type === "tabs");
  const pathsTab = (
    tabs?.props as { tabs?: { label: string; nodes: ArtifactNode[] }[] }
  )?.tabs?.find((tab) => tab.label === "Paths");
  return pathsTab?.nodes ?? [];
};

describe("diffResultToSpec", () => {
  it("builds a valid spec with KPI overview, tabs and collapsible entries", () => {
    const spec = diffResultToSpec(diffResult);
    expect(spec.slug).toBe("calldiff-diff-abc123-worktree");
    expect(spec.title).toContain("abc123");
    expect(spec.nodes[0]).toMatchObject({
      type: "heading",
      props: { level: "h1" },
    });

    // KPI overview: changed steps / impacted files / added / removed.
    const kpi = spec.nodes.find((node) => node.type === "kpi-grid");
    const kpiItems =
      (kpi?.props as { items?: { label: string; value: number }[] })?.items ??
      [];
    expect(kpiItems).toEqual([
      { label: "Changed steps", value: 3 },
      { label: "Impacted files", value: 0 },
      { label: "Added", value: 2 },
      { label: "Removed", value: 1 },
    ]);

    // Paths tab: counts table + accordion; Raw tab: whole canonical ascii.
    const pathsNodes = pathsTabNodes(spec);
    const table = pathsNodes.find((node) => node.type === "table");
    expect(table?.props.rows).toHaveLength(2);
    expect(table?.props.rows[0]).toEqual([
      "PiService.createAgentSession",
      "2",
      "1",
      "1",
    ]);

    const items = accordionItems(spec);
    expect(items).toHaveLength(2);
    expect(items[0]?.title).toBe("PiService.createAgentSession");
    expect(items[0]?.defaultOpen).toBe(false);
    expect(items[0]?.nodes[0]).toMatchObject({ type: "mermaid" });
    expect(items[0]?.nodes[1]).toMatchObject({ type: "code-block" });

    const raw = rawTabNodes(spec);
    expect(raw[0]).toMatchObject({
      type: "code-block",
      props: { code: "full ascii output", language: "text" },
    });

    // Qualification copy for syntactic evidence.
    expect(pathsNodes.some((node) => node.type === "callout")).toBe(true);
    expect(JSON.stringify(pathsNodes)).toContain("Syntactic analysis");
  });

  it("caps detailed entries but keeps the table", () => {
    const many: CalldiffResult = {
      ...diffResult,
      trees: Array.from({ length: 20 }, (_, i) => ({
        entry: `entry${i}`,
        ascii: `ascii ${i}`,
        tree: makeNode(`e${i}`, `entry${i}()`, { status: "added" }),
      })),
    };
    const spec = diffResultToSpec(many);
    expect(accordionItems(spec)).toHaveLength(8);
    const pathsNodes = pathsTabNodes(spec);
    const table = pathsNodes.find((node) => node.type === "table");
    expect(table?.props.rows).toHaveLength(20);
    expect(JSON.stringify(pathsNodes)).toContain("more entrypoint(s)");
  });

  it("emits a callout when nothing changed", () => {
    const spec = diffResultToSpec({ ...diffResult, trees: [] });
    const callout = spec.nodes.find((node) => node.type === "callout");
    expect(callout).toBeDefined();
    expect(spec.nodes.some((node) => node.type === "table")).toBe(false);
    expect(spec.nodes.some((node) => node.type === "tabs")).toBe(false);
  });

  it("truncates long ascii blocks", () => {
    const longAscii = Array.from({ length: 100 }, (_, i) => `line ${i}`).join(
      "\n",
    );
    const firstTree = diffResult.trees[0];
    expect(firstTree).toBeDefined();
    const spec = diffResultToSpec(
      {
        ...diffResult,
        trees: [{ ...firstTree, ascii: longAscii }],
      },
      { maxAsciiLines: 10 },
    );
    const items = accordionItems(spec);
    const codeBlock = (items[0]?.nodes ?? []).find(
      (node: ArtifactNode) => node.type === "code-block",
    );
    const codeProps = codeBlock?.props as { code?: string };
    expect(codeProps.code).toContain("90 more lines omitted");
  });

  it("honors custom title/slug and normalizes the slug", () => {
    const spec = diffResultToSpec(diffResult, {
      title: "My Review",
      slug: "My Slug!!!",
    });
    expect(spec.title).toBe("My Review");
    expect(spec.slug).toBe("my-slug");
  });

  it("skips the diagram when a tree exceeds maxMermaidNodes", () => {
    const bigTree = makeNode("root", "root()", {
      status: "same",
      children: Array.from({ length: 30 }, (_, i) =>
        makeNode(`c${i}`, `call${i}()`, { status: "added" }),
      ),
    });
    const spec = diffResultToSpec(
      {
        ...diffResult,
        trees: [{ entry: "root", ascii: "root ascii", tree: bigTree }],
      },
      { maxMermaidNodes: 10 },
    );
    const items = accordionItems(spec);
    const nodes = items[0]?.nodes ?? [];
    expect(nodes.some((node) => node.type === "mermaid")).toBe(false);
    expect(JSON.stringify(nodes)).toContain("Diagram omitted");
    expect(nodes.some((node) => node.type === "code-block")).toBe(true);
  });

  it("renders a file-impacts table when nodes carry source locations", () => {
    const located: CalldiffResult = {
      ...diffResult,
      trees: [
        {
          entry: "run",
          ascii: "a",
          tree: makeNode("run", "run()", {
            status: "same",
            children: [
              makeNode("a", "a()", {
                status: "added",
                file: "src/a.ts",
                line: 12,
              }),
              makeNode("a2", "a2()", {
                status: "added",
                file: "src/a.ts",
                line: 20,
              }),
              makeNode("b", "b()", { status: "removed", file: "src/b.ts" }),
            ],
          }),
        },
        {
          entry: "other",
          ascii: "b",
          tree: makeNode("other", "other()", {
            status: "same",
            children: [
              makeNode("b2", "b2()", { status: "removed", file: "src/b.ts" }),
            ],
          }),
        },
      ],
    };
    const spec = diffResultToSpec(located);
    const pathsNodes = pathsTabNodes(spec);
    const fileTable = pathsNodes.find(
      (node) =>
        node.type === "table" &&
        (node.props as { headers?: string[] }).headers?.[0] === "File",
    );
    expect(fileTable).toBeDefined();
    const fileTableProps = (fileTable as ArtifactNode).props as {
      rows?: string[][];
    };
    const rows = fileTableProps.rows ?? [];
    // src/b.ts (2 changed) sorts before src/a.ts (2 changed, ties by name).
    expect(rows).toEqual([
      ["src/a.ts", "run", "2", "0"],
      ["src/b.ts", "run, other", "0", "2"],
    ]);

    // KPI impacted-files count now reflects real files.
    const kpi = spec.nodes.find((node) => node.type === "kpi-grid");
    const kpiItems =
      (kpi?.props as { items?: { label: string; value: number }[] })?.items ??
      [];
    expect(
      kpiItems.find((item) => item.label === "Impacted files")?.value,
    ).toBe(2);
  });

  it("filters entry trees to a file without pruning matched trees", () => {
    const located: CalldiffResult = {
      ...diffResult,
      trees: [
        {
          entry: "run",
          ascii: "a",
          tree: makeNode("run", "run()", {
            status: "same",
            children: [
              makeNode("keep", "keep()", { status: "same" }),
              makeNode("a", "a()", { status: "added", file: "src/a.ts" }),
            ],
          }),
        },
        {
          entry: "other",
          ascii: "b",
          tree: makeNode("other", "other()", {
            status: "same",
            children: [
              makeNode("b", "b()", { status: "removed", file: "src/b.ts" }),
            ],
          }),
        },
      ],
    };
    const spec = diffResultToSpec(located, { file: "src/a.ts" });
    const pathsNodes = pathsTabNodes(spec);
    const table = pathsNodes.find(
      (node) =>
        node.type === "table" &&
        (node.props as { headers?: string[] }).headers?.[0] === "Entry",
    );
    expect(table).toBeDefined();
    const tableProps = (table as ArtifactNode).props as { rows?: string[][] };
    expect(tableProps.rows).toHaveLength(1);
    expect(tableProps.rows?.[0]?.[0]).toBe("run");
    // The matched tree stays complete (unchanged context included).
    const items = accordionItems(spec);
    expect(items).toHaveLength(1);
    expect(JSON.stringify(items[0]?.nodes)).toContain("keep()");
    // Description names the filtered file.
    expect(JSON.stringify(spec.nodes)).toContain("touching `src/a.ts`");
  });

  it("emits a per-file empty callout when the file filter matches nothing", () => {
    const located: CalldiffResult = {
      ...diffResult,
      trees: [
        {
          entry: "run",
          ascii: "a",
          tree: makeNode("run", "run()", {
            status: "same",
            children: [
              makeNode("a", "a()", { status: "added", file: "src/a.ts" }),
            ],
          }),
        },
      ],
    };
    const spec = diffResultToSpec(located, { file: "src/missing.ts" });
    const callout = spec.nodes.find((node) => node.type === "callout");
    expect(callout).toBeDefined();
    expect(JSON.stringify(callout)).toContain(
      "No changed call trees touch `src/missing.ts`",
    );
    expect(spec.nodes.some((node) => node.type === "tabs")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  Pure helpers: countNodes / buildFileImpacts / file filter          */
/* ------------------------------------------------------------------ */

describe("countNodes", () => {
  it("counts every node recursively", () => {
    const tree = makeNode("root", "root()", {
      children: [
        makeNode("a", "a()", {
          children: [makeNode("b", "b()")],
        }),
        makeNode("c", "c()"),
      ],
    });
    expect(countNodes(tree)).toBe(4);
  });
});

describe("countChangedSteps", () => {
  it("dedupes changed nodes by key across entry trees", () => {
    const result: CalldiffResult = {
      mode: "diff",
      from: "a",
      to: "b",
      trees: [
        {
          entry: "run",
          ascii: "",
          // "shared" is reachable through both entries: one step.
          tree: makeNode("run", "run()", {
            status: "same",
            children: [makeNode("shared", "shared()", { status: "added" })],
          }),
        },
        {
          entry: "main",
          ascii: "",
          tree: makeNode("main", "main()", {
            status: "same",
            children: [makeNode("shared", "shared()", { status: "added" })],
          }),
        },
      ],
      ascii: "",
    };
    expect(countChangedSteps(result)).toEqual({
      added: 1,
      removed: 0,
      same: 2,
    });
  });

  it("counts distinct keys across entries", () => {
    const result: CalldiffResult = {
      mode: "diff",
      from: "a",
      to: "b",
      trees: [
        {
          entry: "run",
          ascii: "",
          tree: makeNode("run", "run()", {
            status: "same",
            children: [makeNode("a", "a()", { status: "removed" })],
          }),
        },
        {
          entry: "main",
          ascii: "",
          tree: makeNode("main", "main()", {
            status: "same",
            children: [makeNode("b", "b()", { status: "added" })],
          }),
        },
      ],
      ascii: "",
    };
    expect(countChangedSteps(result)).toEqual({
      added: 1,
      removed: 1,
      same: 2,
    });
  });
});

describe("buildFileImpacts", () => {
  it("aggregates entries and dedupes changed nodes per file", () => {
    const located: CalldiffResult = {
      mode: "diff",
      from: "a",
      to: "b",
      trees: [
        {
          entry: "run",
          ascii: "",
          tree: makeNode("run", "run()", {
            status: "same",
            children: [
              makeNode("x", "x()", { status: "added", file: "src/x.ts" }),
              makeNode("x", "x()", { status: "added", file: "src/x.ts" }),
            ],
          }),
        },
        {
          entry: "other",
          ascii: "",
          tree: makeNode("other", "other()", {
            status: "same",
            children: [
              makeNode("x", "x()", { status: "added", file: "src/x.ts" }),
            ],
          }),
        },
      ],
      ascii: "",
    };
    const impacts = buildFileImpacts(located);
    expect(impacts).toEqual([
      {
        file: "src/x.ts",
        entries: ["run", "other"],
        changedNodes: 1,
        added: 1,
        removed: 0,
      },
    ]);
  });

  it("sorts by changedNodes desc then file name", () => {
    const located: CalldiffResult = {
      mode: "diff",
      from: "a",
      to: "b",
      trees: [
        {
          entry: "run",
          ascii: "",
          tree: makeNode("run", "run()", {
            status: "same",
            children: [
              makeNode("b", "b()", { status: "added", file: "src/b.ts" }),
              makeNode("c1", "c1()", { status: "removed", file: "src/c.ts" }),
              makeNode("c2", "c2()", { status: "removed", file: "src/c.ts" }),
            ],
          }),
        },
      ],
      ascii: "",
    };
    const impacts = buildFileImpacts(located);
    expect(impacts.map((impact) => impact.file)).toEqual([
      "src/c.ts",
      "src/b.ts",
    ]);
  });
});

describe("filterDiffResultForFile", () => {
  it("keeps only entry trees with a changed node in the file", () => {
    const located: CalldiffResult = {
      mode: "diff",
      from: "a",
      to: "b",
      trees: [
        {
          entry: "run",
          ascii: "",
          tree: makeNode("run", "run()", {
            status: "same",
            children: [
              makeNode("x", "x()", { status: "added", file: "src/x.ts" }),
            ],
          }),
        },
        {
          entry: "other",
          ascii: "",
          tree: makeNode("other", "other()", {
            status: "same",
            children: [
              makeNode("x", "x()", { status: "same", file: "src/x.ts" }),
            ],
          }),
        },
      ],
      ascii: "",
    };
    const filtered = filterDiffResultForFile(located, "src/x.ts");
    expect(filtered.trees.map((tree) => tree.entry)).toEqual(["run"]);
  });

  it("returns an empty tree list when nothing matches", () => {
    const located: CalldiffResult = {
      mode: "diff",
      from: "a",
      to: "b",
      trees: [
        {
          entry: "run",
          ascii: "",
          tree: makeNode("run", "run()", {
            status: "same",
            children: [
              makeNode("x", "x()", { status: "added", file: "src/x.ts" }),
            ],
          }),
        },
      ],
      ascii: "",
    };
    const filtered = filterDiffResultForFile(located, "src/other.ts");
    expect(filtered.trees).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/*  Tree / reach modes                                                 */
/* ------------------------------------------------------------------ */

describe("treeResultToSpec", () => {
  it("renders tabs with collapsible entries and no diff chrome", () => {
    const spec = treeResultToSpec({
      mode: "tree",
      ref: "HEAD",
      trees: [
        {
          entry: "boot",
          ascii: "boot ascii",
          tree: makeNode("boot", "boot()"),
        },
      ],
      ascii: "whole tree ascii",
    });
    expect(spec.nodes.some((node) => node.type === "kpi-grid")).toBe(false);
    const tabs = spec.nodes.find((node) => node.type === "tabs");
    const rawTab = (
      tabs?.props as { tabs?: { label: string; nodes: ArtifactNode[] }[] }
    )?.tabs?.find((tab) => tab.label === "Raw");
    expect(JSON.stringify(rawTab?.nodes)).toContain("whole tree ascii");
    const pathsTab = (
      tabs?.props as { tabs?: { label: string; nodes: ArtifactNode[] }[] }
    )?.tabs?.find((tab) => tab.label === "Paths");
    const accordion = pathsTab?.nodes.find((node) => node.type === "accordion");
    const items =
      (accordion?.props as { items?: { title: string }[] })?.items ?? [];
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe("boot");
  });
});

describe("calldiffResultToSpec dispatch", () => {
  it("dispatches diff/tree/reach modes", () => {
    expect(calldiffResultToSpec(diffResult).slug).toContain("calldiff-diff");

    const tree: CalldiffResult = {
      mode: "tree",
      ref: "HEAD",
      trees: [{ entry: "boot", ascii: "a", tree: makeNode("boot", "boot()") }],
      ascii: "a",
    };
    expect(calldiffResultToSpec(tree).slug).toBe("calldiff-tree-head");

    const reach: CalldiffResult = {
      mode: "reach",
      ref: "HEAD",
      from: "runCheckout",
      to: "sendEmail",
      paths: [
        {
          entry: "p",
          ascii: "a",
          tree: makeNode("runCheckout", "runCheckout()"),
        },
      ],
      ascii: "a",
    };
    expect(calldiffResultToSpec(reach).slug).toBe(
      "calldiff-reach-runcheckout-to-sendemail",
    );
  });
});
