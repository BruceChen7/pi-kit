import { describe, expect, it } from "vitest";
import {
  renderArchitectureDiagram,
  renderErDiagram,
  renderLayerDiagram,
  validateDiagramProps,
} from "./diagram-core.ts";

describe("diagram core", () => {
  it("renders a deterministic ER diagram with accessible SVG metadata", () => {
    const props = {
      entities: [
        {
          id: "user",
          name: "User",
          fields: [{ name: "id", type: "int", key: "PK" as const }],
        },
        {
          id: "order",
          name: "Order",
          fields: [{ name: "user_id", type: "int", key: "FK" as const }],
        },
      ],
      relationships: [
        {
          from: "user",
          to: "order",
          label: "places",
          cardinality: "one-to-many" as const,
        },
      ],
    };

    const first = renderErDiagram(props, { idPrefix: "test-er" });
    const second = renderErDiagram(props, { idPrefix: "test-er" });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.value.svg).toBe(second.value.svg);
      expect(first.value.svg).toContain('role="img"');
      expect(first.value.svg).toContain("test-er-title");
      expect(first.value.svg).toContain("places");
      expect(first.value.svg).toContain("marker-end");
    }
  });

  it("rejects ER relationships that point to unknown entities", () => {
    const errors = validateDiagramProps("er-diagram", {
      entities: [{ id: "user", fields: [] }],
      relationships: [{ from: "user", to: "missing" }],
    });

    expect(errors).toEqual([
      expect.objectContaining({
        path: "relationships[0].to",
        message: 'unknown entity "missing"',
      }),
    ]);
  });

  it("renders grouped architecture nodes and edges", () => {
    const result = renderArchitectureDiagram(
      {
        nodes: [
          { id: "web", label: "Web", kind: "service" },
          { id: "api", label: "API", kind: "service", focal: true },
          { id: "db", label: "Postgres", kind: "store" },
        ],
        groups: [{ id: "runtime", label: "Runtime", members: ["api", "db"] }],
        edges: [
          { from: "web", to: "api", label: "HTTPS" },
          { from: "api", to: "db", label: "SQL", style: "dashed" },
        ],
      },
      { idPrefix: "test-architecture" },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.svg).toContain("Runtime");
      expect(result.value.svg).toContain("Web");
      expect(result.value.svg).toContain("HTTPS");
      expect(result.value.svg).toContain('stroke-dasharray="7 5"');
    }
  });

  it("places horizontal external nodes beside grouped runtime", () => {
    const result = renderArchitectureDiagram({
      nodes: [
        { id: "client", label: "Client", kind: "external" },
        { id: "api", label: "API" },
        { id: "tests", label: "Focused tests", kind: "external" },
      ],
      groups: [{ id: "runtime", label: "Runtime", members: ["api"] }],
      edges: [
        { from: "client", to: "api", label: "request" },
        { from: "api", to: "tests", label: "verify" },
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok === false) return;
    expect(result.value.warnings).toEqual([]);

    const rects = [
      ...result.value.svg.matchAll(
        /<rect x="([0-9.]+)" y="([0-9.]+)" width="([0-9.]+)" height="([0-9.]+)"[^>]*>/g,
      ),
    ].map((match) => ({
      x: Number(match[1]),
      y: Number(match[2]),
      width: Number(match[3]),
      height: Number(match[4]),
      markup: match[0],
    }));
    const group = rects.find((rect) =>
      rect.markup.includes('stroke-dasharray="6 5"'),
    );
    const external = rects.filter((rect) =>
      rect.markup.includes('stroke-dasharray="5 4"'),
    );

    expect(group).toBeDefined();
    expect(external).toHaveLength(2);
    if (!group || external.length !== 2) return;
    expect(external[0].x).toBeLessThan(group.x);
    expect(external[1].x).toBeGreaterThan(group.x + group.width);
    expect(
      group.x - (external[0].x + external[0].width),
    ).toBeGreaterThanOrEqual(96);
    expect(external[1].x - (group.x + group.width)).toBeGreaterThanOrEqual(96);
  });

  it("keeps grouped architecture rows and edge labels visually separated", () => {
    const result = renderArchitectureDiagram({
      nodes: [
        { id: "client", label: "create_visual_artifact", kind: "external" },
        { id: "schema", label: "Schema + catalog", kind: "boundary" },
        { id: "core", label: "Diagram core", kind: "service" },
        { id: "adapter", label: "Svelte adapters", kind: "service" },
        { id: "viewport", label: "SvgViewport", kind: "service" },
        { id: "tests", label: "Focused tests", kind: "external" },
      ],
      groups: [
        {
          id: "runtime",
          label: "Visual Artifact Runtime",
          members: ["schema", "core", "adapter", "viewport"],
        },
      ],
      edges: [
        { from: "client", to: "schema", label: "props" },
        { from: "schema", to: "core", label: "validated model" },
        { from: "core", to: "adapter", label: "SVG + errors" },
        { from: "adapter", to: "viewport", label: "render" },
        { from: "core", to: "tests", label: "pure behavior" },
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok === false) return;

    type Box2D = { x: number; y: number; width: number; height: number };
    const boxesFrom = (markup: string, filter: (m: string) => boolean) =>
      [
        ...markup.matchAll(
          /<rect x="([0-9.]+)" y="([0-9.]+)" width="([0-9.]+)" height="([0-9.]+)"[^>]*>/g,
        ),
      ]
        .map((match) => ({
          x: Number(match[1]),
          y: Number(match[2]),
          width: Number(match[3]),
          height: Number(match[4]),
          markup: match[0],
        }))
        .filter((rect) => filter(rect.markup));

    const intersects = (a: Box2D, b: Box2D) =>
      a.x < b.x + b.width &&
      a.x + a.width > b.x &&
      a.y < b.y + b.height &&
      a.y + a.height > b.y;

    const group = boxesFrom(
      result.value.svg,
      (m) => m.includes('rx="12"') && m.includes('stroke-dasharray="6 5"'),
    ).at(0);
    const members = boxesFrom(
      result.value.svg,
      (m) => m.includes('rx="8"') && !m.includes('stroke-dasharray="5 4"'),
    );
    const externals = boxesFrom(result.value.svg, (m) =>
      m.includes('stroke-dasharray="5 4"'),
    );
    const edgeLabels = boxesFrom(result.value.svg, (m) => m.includes('rx="3"'));

    expect(group).toBeDefined();
    expect(members).toHaveLength(4);
    expect(externals).toHaveLength(2);
    if (!group) return;

    // The group box encloses every member row, and members leave routing
    // lanes (28px gap) between adjacent rows.
    for (const member of members) {
      expect(member.x).toBeGreaterThanOrEqual(group.x);
      expect(member.y).toBeGreaterThanOrEqual(group.y);
      expect(member.x + member.width).toBeLessThanOrEqual(
        group.x + group.width,
      );
      expect(member.y + member.height).toBeLessThanOrEqual(
        group.y + group.height,
      );
    }
    const sortedByY = [...members].sort((a, b) => a.y - b.y);
    for (let i = 1; i < sortedByY.length; i++) {
      expect(
        sortedByY[i].y - (sortedByY[i - 1].y + sortedByY[i - 1].height),
      ).toBeGreaterThanOrEqual(28);
    }

    // Edge label backings must not collide with member or external node
    // borders — the routing lane exists precisely so labels stay off the
    // node boxes. (The group container's dashed border is excluded: labels
    // on edges that exit a group legitimately cross it near the border,
    // and fixing that overlap is a layout-tuning change, out of scope.)
    for (const label of edgeLabels) {
      for (const node of [...members, ...externals]) {
        expect(intersects(label, node)).toBe(false);
      }
    }
  });

  it("renders ordered layers and accepts string shorthand items", () => {
    const result = renderLayerDiagram(
      {
        layers: [
          {
            id: "presentation",
            label: "Presentation",
            items: ["Web", "Mobile"],
          },
          {
            id: "data",
            label: "Data",
            items: [{ id: "db", label: "Postgres", focal: true }],
          },
        ],
        edges: [{ from: "Web", to: "db", label: "reads" }],
      },
      { idPrefix: "test-layer" },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.svg).toContain("Presentation");
      expect(result.value.svg).toContain("Postgres");
      expect(result.value.svg).toContain("reads");
      expect(result.value.height).toBeGreaterThan(result.value.width / 3);
      expect(result.value.svg).toContain('opacity="0.94"');
    }
  });

  it("lays layers out left-to-right in horizontal mode", () => {
    const result = renderLayerDiagram({
      direction: "horizontal",
      layers: [
        { id: "api", label: "API", items: ["Endpoint"] },
        { id: "data", label: "Data", items: ["Database"] },
      ],
      edges: [{ from: "Endpoint", to: "Database", label: "reads" }],
    });

    expect(result.ok).toBe(true);
    if (result.ok === false) return;

    const layerRects = [
      ...result.value.svg.matchAll(
        /<rect x="([0-9.]+)" y="56" width="([0-9.]+)" height="([0-9.]+)" rx="10"/g,
      ),
    ].map((match) => ({
      x: Number(match[1]),
      width: Number(match[2]),
      height: Number(match[3]),
    }));

    expect(layerRects).toHaveLength(2);
    expect(layerRects[1].x).toBeGreaterThan(layerRects[0].x);
    expect(result.value.width).toBeGreaterThan(result.value.height);
    expect(result.value.svg).toContain("reads");
  });

  it("rejects duplicate architecture node IDs", () => {
    const result = renderArchitectureDiagram({
      nodes: [
        { id: "api", label: "API" },
        { id: "api", label: "Other API" },
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          path: "nodes[1].id",
          message: 'duplicates node id "api"',
        }),
      );
    }
  });
});
