import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ArtifactNode } from "./artifact-schema.ts";
import {
  type CalldiffNode,
  type CalldiffResult,
  calldiffResultToSpec,
  callNodeToMermaid,
  countDiffStatuses,
  diffNodeToMermaid,
  diffResultToSpec,
  parseCalldiffJson,
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
});

/* ------------------------------------------------------------------ */
/*  Spec assembly                                                      */
/* ------------------------------------------------------------------ */

describe("diffResultToSpec", () => {
  it("builds a valid spec with header, table and sections", () => {
    const spec = diffResultToSpec(diffResult);
    expect(spec.slug).toBe("calldiff-diff-abc123-worktree");
    expect(spec.title).toContain("abc123");
    expect(spec.nodes[0]).toMatchObject({
      type: "heading",
      props: { level: "h1" },
    });
    const table = spec.nodes.find((node) => node.type === "table");
    expect(table).toBeDefined();
    expect(table?.props.rows).toHaveLength(2);
    expect(table?.props.rows[0]).toEqual([
      "PiService.createAgentSession",
      "2",
      "1",
      "1",
    ]);

    const sections = spec.nodes.filter((node) => node.type === "section");
    expect(sections).toHaveLength(2);
    const firstSection = sections[0]?.props as {
      title: string;
      nodes: unknown[];
    };
    expect(firstSection.title).toBe("PiService.createAgentSession");
    expect(firstSection.nodes[0]).toMatchObject({ type: "mermaid" });
    expect(firstSection.nodes[1]).toMatchObject({ type: "code-block" });
  });

  it("caps detailed sections but keeps the table", () => {
    const many: CalldiffResult = {
      ...diffResult,
      trees: Array.from({ length: 20 }, (_, i) => ({
        entry: `entry${i}`,
        ascii: `ascii ${i}`,
        tree: makeNode(`e${i}`, `entry${i}()`, { status: "added" }),
      })),
    };
    const spec = diffResultToSpec(many);
    const sections = spec.nodes.filter((node) => node.type === "section");
    expect(sections).toHaveLength(8);
    const table = spec.nodes.find((node) => node.type === "table");
    expect(table?.props.rows).toHaveLength(20);
    const _footer = spec.nodes.find((node) => node.type === "text");
    expect(JSON.stringify(spec.nodes)).toContain("more entrypoint(s)");
  });

  it("emits a callout when nothing changed", () => {
    const spec = diffResultToSpec({ ...diffResult, trees: [] });
    const callout = spec.nodes.find((node) => node.type === "callout");
    expect(callout).toBeDefined();
    expect(spec.nodes.some((node) => node.type === "table")).toBe(false);
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
    const section = spec.nodes.find((node) => node.type === "section");
    const sectionProps = section?.props as { nodes?: ArtifactNode[] };
    const codeBlock = (sectionProps.nodes ?? []).find(
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
