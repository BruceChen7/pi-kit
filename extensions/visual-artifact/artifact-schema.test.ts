import { describe, expect, it } from "vitest";
import { LIMITS, NODE_TYPE_CATALOG, validate } from "./artifact-schema.ts";

const minimalValidSpec = {
  slug: "test-report",
  title: "Test Report",
  description: "A minimal valid spec.",
  nodes: [{ type: "text", props: { text: "Hello.", size: "md" } }],
};

describe("validate", () => {
  it("accepts a minimal valid spec", () => {
    const result = validate(minimalValidSpec);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.slug).toBe("test-report");
      expect(result.spec.nodes).toHaveLength(1);
    }
  });

  it("rejects non-object input", () => {
    const result = validate("not an object");
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.errors).toContain("Input must be a JSON object.");
    }
  });

  it("rejects missing slug", () => {
    const result = validate({ title: "No Slug", nodes: [] });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.errors.some((e) => e.includes("slug"))).toBe(true);
    }
  });

  it("rejects missing title", () => {
    const result = validate({ slug: "no-title", nodes: [] });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.errors.some((e) => e.includes("title"))).toBe(true);
    }
  });

  it("rejects non-array nodes", () => {
    const result = validate({ slug: "bad", title: "Bad", nodes: "not array" });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.errors).toContain("nodes must be an array.");
    }
  });

  it("rejects too many top-level nodes", () => {
    const nodes = Array.from(
      { length: LIMITS.maxTopLevelNodes + 1 },
      (_, i) => ({
        type: "text",
        props: { text: `Node ${i}`, size: "sm" },
      }),
    );
    const result = validate({
      slug: "too-many-nodes",
      title: "Too Many Nodes",
      nodes,
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.errors.some((e) => e.includes("top-level"))).toBe(true);
    }
  });

  it("rejects too many total nodes", () => {
    // Create deeply nested nodes that exceed maxTotalNodes
    const deepNodes: unknown[] = [];
    for (let i = 0; i < LIMITS.maxTotalNodes + 1; i++) {
      deepNodes.push({ type: "text", props: { text: `N${i}`, size: "sm" } });
    }
    const result = validate({
      slug: "too-many-total",
      title: "Too Many Total",
      nodes: deepNodes,
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.errors.some((e) => e.includes("total nodes"))).toBe(true);
    }
  });

  it("rejects too many total nodes nested inside side-by-side", () => {
    const panelNodes = Array.from({ length: LIMITS.maxTotalNodes }, (_, i) => ({
      type: "text",
      props: { text: `Nested ${i}`, size: "sm" },
    }));

    const result = validate({
      slug: "too-many-side-by-side",
      title: "Too Many Side By Side",
      nodes: [
        {
          type: "side-by-side",
          props: {
            left: panelNodes,
            right: [],
          },
        },
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.errors.some((e) => e.includes("total nodes"))).toBe(true);
    }
  });

  it("rejects node nesting deeper than the limit", () => {
    let nestedNode: Record<string, unknown> = {
      type: "text",
      props: { text: "leaf", size: "sm" },
    };

    for (let depth = 0; depth < LIMITS.maxNodeDepth; depth += 1) {
      nestedNode = {
        type: "card",
        props: {
          title: `Level ${depth}`,
          nodes: [nestedNode],
        },
      };
    }

    const result = validate({
      slug: "too-deep",
      title: "Too Deep",
      nodes: [nestedNode],
    });

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.errors.some((e) => e.includes("nesting depth"))).toBe(true);
    }
  });

  it("rejects too many datasets", () => {
    const data: Record<string, unknown[]> = {};
    for (let i = 0; i < LIMITS.maxDatasets + 1; i++) {
      data[`ds${i}`] = [{ id: i }];
    }
    const result = validate({
      ...minimalValidSpec,
      data,
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.errors.some((e) => e.includes("datasets"))).toBe(true);
    }
  });

  it("accepts spec with all optional fields", () => {
    const spec = {
      slug: "full-spec",
      title: "Full Spec",
      description: "Has everything.",
      artifactType: "report",
      topics: ["demo", "test"],
      layout: "horizontal",
      data: {
        items: [{ x: 1 }, { x: 2 }],
      },
      nodes: [
        {
          type: "card",
          props: {
            title: "Card",
            description: "A card",
            nodes: [
              { type: "text", props: { text: "Inside card.", size: "sm" } },
            ],
          },
        },
        {
          type: "stat-card",
          props: { label: "Items", value: 42, trend: "up" },
        },
      ],
    };
    const result = validate(spec);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.artifactType).toBe("report");
      expect(result.spec.layout).toBe("horizontal");
      expect(result.spec.nodes).toHaveLength(2);
    }
  });

  it("rejects spec exceeding json size limit", () => {
    const largeText = "x".repeat(LIMITS.maxJsonBytes + 1);
    const result = validate({
      ...minimalValidSpec,
      nodes: [{ type: "text", props: { text: largeText, size: "md" } }],
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.errors.some((e) => e.includes("size limit"))).toBe(true);
    }
  });

  it("rejects node without props", () => {
    const result = validate({
      ...minimalValidSpec,
      nodes: [{ type: "text" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.errors.some((e) => e.includes("props"))).toBe(true);
    }
  });

  it("rejects known node types with legacy prop names", () => {
    const result = validate({
      ...minimalValidSpec,
      nodes: [
        { type: "text", props: { content: "legacy text" } },
        { type: "mermaid", props: { chart: "flowchart LR\nA-->B" } },
        { type: "link", props: { label: "legacy link", url: "" } },
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.errors).toContain(
        'Node "text" requires prop "text" (legacy prop "content" is not supported).',
      );
      expect(result.errors).toContain(
        'Node "mermaid" requires prop "definition" (legacy prop "chart" is not supported).',
      );
      expect(result.errors).toContain(
        'Node "link" requires prop "text" (legacy prop "label" is not supported).',
      );
    }
  });

  it("accepts list nodes", () => {
    const result = validate({
      ...minimalValidSpec,
      nodes: [
        {
          type: "list",
          props: {
            items: [
              "Plain item",
              { type: "bullet", content: "Structured item" },
            ],
          },
        },
      ],
    });

    expect(result.ok).toBe(true);
  });

  it("requires list items", () => {
    const result = validate({
      ...minimalValidSpec,
      nodes: [{ type: "list", props: {} }],
    });

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.errors).toContain('Node "list" requires prop "items".');
    }
  });

  it("rejects unsupported node types", () => {
    const result = validate({
      ...minimalValidSpec,
      nodes: [{ type: "unknown-widget", props: {} }],
    });

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.errors).toContain(
        'Unsupported node type: "unknown-widget".',
      );
    }
  });

  it("validates required props recursively with a precise node path", () => {
    const result = validate({
      ...minimalValidSpec,
      nodes: [
        {
          type: "accordion",
          props: {
            items: [
              {
                title: "Coverage",
                nodes: [
                  {
                    type: "card",
                    props: {
                      title: "Nested",
                      nodes: [{ type: "text", props: {} }],
                    },
                  },
                ],
              },
            ],
          },
        },
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.errors).toContain(
        'Node "text" requires prop "text" at nodes.0.props.items.0.nodes.0.props.nodes.0.',
      );
    }
  });

  it("accepts inline table columns as header aliases", () => {
    const result = validate({
      ...minimalValidSpec,
      nodes: [
        {
          type: "accordion",
          props: {
            items: [
              {
                title: "Coverage",
                nodes: [
                  {
                    type: "table",
                    props: {
                      columns: ["Area", "Delta"],
                      rows: [["Tests", "0"]],
                    },
                  },
                ],
              },
            ],
          },
        },
      ],
    });

    expect(result.ok).toBe(true);
  });

  it("rejects nested tables without headers or columns", () => {
    const result = validate({
      ...minimalValidSpec,
      nodes: [
        {
          type: "card",
          props: {
            nodes: [{ type: "table", props: { rows: [["Tests", "0"]] } }],
          },
        },
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.errors).toContain(
        'Node "table" requires prop "headers" or "columns" at nodes.0.props.nodes.0.',
      );
    }
  });

  it("defaults layout to vertical when not set", () => {
    const result = validate(minimalValidSpec);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.layout).toBe("vertical");
    }
  });

  it("accepts the three structured diagram node types", () => {
    const result = validate({
      ...minimalValidSpec,
      nodes: [
        {
          type: "er-diagram",
          props: {
            entities: [{ id: "user", fields: [{ name: "id", key: "PK" }] }],
            relationships: [],
          },
        },
        {
          type: "architecture-diagram",
          props: {
            nodes: [{ id: "api", label: "API" }],
            edges: [],
          },
        },
        {
          type: "layer-diagram",
          props: {
            layers: [{ id: "app", label: "Application", items: ["API"] }],
          },
        },
      ],
    });

    expect(result.ok).toBe(true);
  });

  it("reports structured diagram reference errors with node paths", () => {
    const result = validate({
      ...minimalValidSpec,
      nodes: [
        {
          type: "architecture-diagram",
          props: {
            nodes: [{ id: "api", label: "API" }],
            edges: [{ from: "api", to: "missing" }],
          },
        },
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.errors).toContain(
        'Node "architecture-diagram" props.edges[0].to: unknown node "missing".',
      );
    }
  });

  it("registers the structured diagram nodes in the agent-facing catalog", () => {
    for (const type of [
      "er-diagram",
      "architecture-diagram",
      "layer-diagram",
    ]) {
      expect(
        NODE_TYPE_CATALOG.find((entry) => entry.type === type),
      ).toBeDefined();
    }
  });

  it("requires canonical svg props for svg-diagram nodes", () => {
    const result = validate({
      ...minimalValidSpec,
      nodes: [{ type: "svg-diagram", props: { html: "<svg></svg>" } }],
    });

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.errors).toContain(
        'Node "svg-diagram" requires prop "svg".',
      );
    }
  });

  it("accepts a calldiff-callflow node with no props (all optional)", () => {
    const result = validate({
      ...minimalValidSpec,
      nodes: [{ type: "calldiff-callflow", props: {} }],
    });
    expect(result.ok).toBe(true);
  });

  it("accepts calldiff-callflow nested inside containers", () => {
    const result = validate({
      ...minimalValidSpec,
      nodes: [
        {
          type: "accordion",
          props: {
            items: [
              {
                title: "Call flow",
                nodes: [
                  {
                    type: "calldiff-callflow",
                    props: { mode: "diff", from: "main", to: "HEAD" },
                  },
                ],
              },
            ],
          },
        },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("registers calldiff-callflow in the agent-facing catalog with guidelines", () => {
    const entry = NODE_TYPE_CATALOG.find((e) => e.type === "calldiff-callflow");
    expect(entry).toBeDefined();
    expect(entry?.props).toHaveProperty("mode");
    expect(entry?.props).toHaveProperty("entry");
    expect(entry?.props).toHaveProperty("target");
    expect(entry?.guidelines?.length).toBeGreaterThan(0);
  });
});
