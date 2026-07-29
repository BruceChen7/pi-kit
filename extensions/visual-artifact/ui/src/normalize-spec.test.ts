import { describe, expect, it } from "vitest";
import {
  type Dataset,
  normalizeArtifactNode,
  normalizeArtifactNodes,
  type UiArtifactNode,
} from "./normalize-spec.ts";

describe("normalizeArtifactNode", () => {
  it("maps mermaid code to definition", () => {
    const node = normalizeArtifactNode({
      type: "mermaid",
      props: { code: "flowchart LR\nA-->B" },
    });

    expect(node.props.definition).toBe("flowchart LR\nA-->B");
  });

  it("maps card content to nested text node", () => {
    const node = normalizeArtifactNode({
      type: "card",
      props: { title: "Guard", content: "line 1\nline 2" },
    });

    expect(node.props.nodes).toEqual([
      {
        type: "text",
        props: { text: "line 1\nline 2", size: "md" },
      },
    ]);
  });

  it("maps children to props.nodes for nested containers", () => {
    const node = normalizeArtifactNode({
      type: "section",
      props: { title: "Body" },
      children: [{ type: "text", props: { text: "hello", size: "base" } }],
    });

    expect(node.props.nodes).toEqual([
      {
        type: "text",
        props: { text: "hello", size: "md" },
      },
    ]);
  });

  it("maps array content to props.nodes for nested containers", () => {
    const node = normalizeArtifactNode({
      type: "section",
      props: {
        title: "Architecture",
        content: [
          {
            type: "mermaid",
            props: { code: "flowchart LR\nA-->B" },
          },
          {
            type: "callout",
            props: { type: "info", content: "Nested content" },
          },
        ],
      },
    });

    expect(node.props.nodes).toEqual([
      {
        type: "mermaid",
        props: {
          code: "flowchart LR\nA-->B",
          definition: "flowchart LR\nA-->B",
        },
      },
      {
        type: "callout",
        props: {
          type: "info",
          content: "Nested content",
          variant: "info",
          text: "Nested content",
        },
      },
    ]);
  });

  it("maps callout content and type aliases", () => {
    const node = normalizeArtifactNode({
      type: "callout",
      props: { type: "info", content: "Heads up" },
    });

    expect(node.props.variant).toBe("info");
    expect(node.props.text).toBe("Heads up");
  });

  it("maps separator to divider", () => {
    const node = normalizeArtifactNode({
      type: "separator",
      props: {},
    });

    expect(node.type).toBe("divider");
  });

  it("normalizes numeric heading levels", () => {
    const node = normalizeArtifactNode({
      type: "heading",
      props: { level: 2, text: "Title" },
    });

    expect(node.props.level).toBe("h2");
  });
});

describe("markdown table in card content", () => {
  it("detects and converts markdown table in card content to table node", () => {
    const nodes = normalizeArtifactNodes([
      {
        type: "card",
        props: {
          title: "Guard",
          content: [
            "| 场景 | 行为 |",
            "|------|------|",
            "| Plan + write | Block |",
            "| Plan + bash | Block |",
          ].join("\n"),
        },
      },
    ]);

    expect(nodes[0].type).toBe("card");
    expect(Array.isArray(nodes[0].props.nodes)).toBe(true);
    const tableNode = (nodes[0].props.nodes as UiArtifactNode[])[0];
    expect(tableNode.type).toBe("table");
    expect(tableNode.props.headers).toEqual(["场景", "行为"]);
    expect(tableNode.props.rows).toEqual([
      ["Plan + write", "Block"],
      ["Plan + bash", "Block"],
    ]);
  });

  it("keeps non-table content as text node", () => {
    const nodes = normalizeArtifactNodes([
      {
        type: "card",
        props: {
          title: "Title",
          content: "Just plain text, not a table.",
        },
      },
    ]);

    expect(nodes[0].type).toBe("card");
    const child = (nodes[0].props.nodes as UiArtifactNode[])[0];
    expect(child.type).toBe("text");
    expect(child.props.text).toBe("Just plain text, not a table.");
  });
});

describe("table normalization", () => {
  it("aliases data-table to table", () => {
    const nodes = normalizeArtifactNodes([
      { type: "data-table", props: { headers: ["A"], rows: [["1"]] } },
    ]);
    expect(nodes[0].type).toBe("table");
  });

  it("aliases comparison-table to table", () => {
    const nodes = normalizeArtifactNodes([
      { type: "comparison-table", props: { headers: ["A"], rows: [["1"]] } },
    ]);
    expect(nodes[0].type).toBe("table");
  });

  it("resolves dataKey + columns to headers + rows", () => {
    const data: Record<string, Dataset> = {
      items: [
        { name: "Alice", value: 10 },
        { name: "Bob", value: 20 },
      ],
    };

    const nodes = normalizeArtifactNodes(
      [
        {
          type: "table",
          props: { dataKey: "items", columns: ["name", "value"] },
        },
      ],
      data,
    );

    expect(nodes[0].props).toEqual({
      headers: ["name", "value"],
      rows: [
        ["Alice", "10"],
        ["Bob", "20"],
      ],
    });
  });

  it("resolves columns with labels", () => {
    const data: Record<string, Dataset> = {
      items: [
        { name: "Alice", role: "Engineer" },
        { name: "Bob", role: "Designer" },
      ],
    };

    const nodes = normalizeArtifactNodes(
      [
        {
          type: "table",
          props: {
            dataKey: "items",
            columns: [
              { key: "name", label: "Name" },
              { key: "role", label: "Role" },
            ],
          },
        },
      ],
      data,
    );

    expect(nodes[0].props).toEqual({
      headers: ["Name", "Role"],
      rows: [
        ["Alice", "Engineer"],
        ["Bob", "Designer"],
      ],
    });
  });

  it("passes through already-inline tables unchanged", () => {
    const nodes = normalizeArtifactNodes([
      {
        type: "table",
        props: {
          headers: ["X"],
          rows: [["y"]],
        },
      },
    ]);

    expect(nodes[0].props).toEqual({
      headers: ["X"],
      rows: [["y"]],
    });
  });

  it("maps inline columns to headers while preserving rows", () => {
    const nodes = normalizeArtifactNodes([
      {
        type: "table",
        props: {
          columns: ["Area", "Delta"],
          rows: [
            ["Tests", "0"],
            ["Docs", "1"],
          ],
        },
      },
    ]);

    expect(nodes[0].props).toEqual({
      headers: ["Area", "Delta"],
      rows: [
        ["Tests", "0"],
        ["Docs", "1"],
      ],
    });
  });
});

describe("normalizeArtifactNodes", () => {
  it("drops malformed entries and preserves valid nodes", () => {
    const nodes = normalizeArtifactNodes([
      null,
      { foo: "bar" },
      { type: "badge", props: { label: "ready" } },
    ]);

    expect(nodes).toEqual([
      {
        type: "badge",
        props: { label: "ready", text: "ready" },
      },
    ]);
  });
});
