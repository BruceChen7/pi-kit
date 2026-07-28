import { describe, expect, it } from "vitest";
import { LIMITS, validate } from "./artifact-schema.ts";

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
    if (!result.ok) {
      expect(result.errors).toContain("Input must be a JSON object.");
    }
  });

  it("rejects missing slug", () => {
    const result = validate({ title: "No Slug", nodes: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("slug"))).toBe(true);
    }
  });

  it("rejects missing title", () => {
    const result = validate({ slug: "no-title", nodes: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("title"))).toBe(true);
    }
  });

  it("rejects non-array nodes", () => {
    const result = validate({ slug: "bad", title: "Bad", nodes: "not array" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
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
    if (!result.ok) {
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
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("total nodes"))).toBe(true);
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
    if (!result.ok) {
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
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("size limit"))).toBe(true);
    }
  });

  it("rejects node without props", () => {
    const result = validate({
      ...minimalValidSpec,
      nodes: [{ type: "text" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("props"))).toBe(true);
    }
  });

  it("defaults layout to vertical when not set", () => {
    const result = validate(minimalValidSpec);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.layout).toBe("vertical");
    }
  });
});
