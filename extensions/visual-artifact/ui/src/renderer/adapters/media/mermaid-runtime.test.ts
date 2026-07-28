import { describe, expect, it, vi } from "vitest";
import {
  getMermaidRenderConfig,
  getMermaidTheme,
  normalizeMermaidDefinition,
  renderMermaidDiagram,
} from "./mermaid-runtime.ts";

describe("getMermaidTheme", () => {
  it("maps dark app theme to Mermaid base", () => {
    expect(getMermaidTheme("dark")).toBe("base");
  });

  it("maps light app theme to Mermaid base", () => {
    expect(getMermaidTheme("light")).toBe("base");
  });
});

describe("getMermaidRenderConfig", () => {
  it("builds a dark theme config with readable theme variables", () => {
    const config = getMermaidRenderConfig("dark");

    expect(config).toMatchObject({
      theme: "base",
      securityLevel: "strict",
      startOnLoad: false,
      themeVariables: expect.objectContaining({
        background: "#0f172a",
        primaryTextColor: "#f1f5f9",
        lineColor: "#94a3b8",
      }),
    });
  });

  it("builds a light theme config with readable theme variables", () => {
    const config = getMermaidRenderConfig("light");

    expect(config).toMatchObject({
      theme: "base",
      themeVariables: expect.objectContaining({
        background: "#f8fafc",
        primaryTextColor: "#0f172a",
        lineColor: "#475569",
      }),
    });
  });
});

describe("normalizeMermaidDefinition", () => {
  it("adds dark text to class definitions with a light fill", () => {
    expect(
      normalizeMermaidDefinition(
        "flowchart TD\\nclassDef plan fill:#e3f2fd,stroke:#1565c0",
      ),
    ).toContain("classDef plan fill:#e3f2fd,stroke:#1565c0,color:#0f172a");
  });

  it("adds light text to class definitions with a dark fill", () => {
    expect(
      normalizeMermaidDefinition(
        "flowchart TD\nclassDef dark fill:#172033,stroke:#94a3b8;",
      ),
    ).toContain("classDef dark fill:#172033,stroke:#94a3b8,color:#f8fafc;");
  });

  it("preserves an explicit class definition text color", () => {
    const definition =
      "classDef custom fill:#ffffff,color:#be123c,stroke:#be123c";

    expect(normalizeMermaidDefinition(definition)).toBe(definition);
  });
});

describe("renderMermaidDiagram", () => {
  it("initializes Mermaid, parses code, and renders svg", async () => {
    const initialize = vi.fn();
    const parse = vi.fn(async () => undefined);
    const render = vi.fn(async () => ({ svg: "<svg>ok</svg>" }));

    const svg = await renderMermaidDiagram(
      {
        initialize,
        parse,
        render,
      },
      {
        id: "diagram-1",
        theme: "dark",
        definition: "flowchart LR\\n  A --> B",
      },
    );

    expect(svg).toBe("<svg>ok</svg>");
    expect(initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        startOnLoad: false,
        theme: "base",
        securityLevel: "strict",
        themeVariables: expect.objectContaining({
          background: "#0f172a",
        }),
      }),
    );
    expect(parse).toHaveBeenCalledWith("flowchart LR\n  A --> B");
    expect(render).toHaveBeenCalledWith(
      "diagram-1-dark",
      "flowchart LR\n  A --> B",
    );
  });

  it("uses Mermaid default theme for light mode", async () => {
    const initialize = vi.fn();

    await renderMermaidDiagram(
      {
        initialize,
        parse: vi.fn(async () => undefined),
        render: vi.fn(async () => ({ svg: "<svg />" })),
      },
      {
        id: "diagram-2",
        theme: "light",
        definition: "graph TD\nA-->B",
      },
    );

    expect(initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        theme: "base",
        themeVariables: expect.objectContaining({
          background: "#f8fafc",
        }),
      }),
    );
  });
});
