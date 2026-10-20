import { describe, expect, it } from "vitest";
import {
  condensePeleMessage,
  DIAGRAM_FONT_FAMILY,
  describePeleError,
  REGISTERED_DIAGRAM_TYPES,
  renderDiagramSvg,
  toCssVariableStyle,
  toPeleCssVariables,
} from "./pele-runtime.ts";

describe("toPeleCssVariables", () => {
  it("maps the warm-neutral app palette onto pelé variables", () => {
    const variables = toPeleCssVariables("light");

    expect(variables).toMatchObject({
      "--pele-bg": "#ffffff",
      "--pele-fg": "#141413",
      "--pele-surface": "#ffffff",
      "--pele-surface-alt": "#f0eee6",
      "--pele-border": "#d1cfc5",
      "--pele-line": "#6b6a63",
      "--pele-muted": "#6b6a63",
      "--pele-accent": "#d97757",
      "--pele-critical": "#b04a3f",
      "--pele-font": DIAGRAM_FONT_FAMILY,
    });
  });

  it("falls back to the light palette for an unknown theme", () => {
    expect(toPeleCssVariables("dark")).toEqual(toPeleCssVariables("light"));
  });
});

describe("toCssVariableStyle", () => {
  it("renders `name: value` pairs joined by semicolons", () => {
    expect(
      toCssVariableStyle({ "--pele-fg": "#141413", "--pele-bg": "#ffffff" }),
    ).toBe("--pele-fg: #141413; --pele-bg: #ffffff");
  });

  it("renders an empty string for an empty map", () => {
    expect(toCssVariableStyle({})).toBe("");
  });
});

describe("condensePeleMessage", () => {
  it("drops the caret excerpt and the redundant line prefix", () => {
    expect(
      condensePeleMessage(
        "Parse error on line 3:\n\n^\nExpecting 'SQE', 'TEXT', got '$end'",
      ),
    ).toBe("Expecting 'SQE', 'TEXT', got '$end'");
  });

  it("keeps the offending source line when pelé points at it", () => {
    expect(
      condensePeleMessage(
        "Parse error on line 5:\n  theme: base\n---------^\nExpecting 'EOF'",
      ),
    ).toBe("theme: base Expecting 'EOF'");
  });
});

describe("describePeleError", () => {
  it("appends structured line/column and strips the duplicated prefix", () => {
    expect(
      describePeleError({
        name: "PeleError",
        code: "syntax",
        line: 3,
        column: 1,
        message: "Parse error on line 3:\n\n^\nExpecting 'EOF', got '$end'",
      }),
    ).toBe("Expecting 'EOF', got '$end' (line 3, column 1)");
  });

  it("omits the position when pelé reports none", () => {
    expect(
      describePeleError({
        name: "PeleError",
        code: "limit",
        line: 0,
        column: 0,
        message: "Diagram source is too long",
      }),
    ).toBe("Diagram source is too long");
  });

  it("names the registered diagram types for unsupported diagrams", () => {
    const message = describePeleError({
      name: "PeleError",
      code: "unsupported-diagram",
      line: 0,
      column: 0,
      message: 'Diagram type "mindmap" is not supported yet.',
    });

    expect(message).toContain('Diagram type "mindmap" is not supported yet.');
    expect(message).toContain(REGISTERED_DIAGRAM_TYPES.join(", "));
  });

  it("stringifies non-object failures", () => {
    expect(describePeleError("boom")).toBe("boom");
  });
});

describe("renderDiagramSvg", () => {
  it("renders a flowchart to pelé SVG with its label", () => {
    const svg = renderDiagramSvg({
      theme: "light",
      definition: 'flowchart LR\n  A["Plan 提交"] --> B["门禁校验"]',
    });

    expect(svg).toContain('class="pele pele-flowchart"');
    expect(svg).toContain("Plan 提交");
    expect(svg).toContain("--_bg:var(--pele-bg");
  });

  it("renders a sequence diagram from the corpus", () => {
    const svg = renderDiagramSvg({
      theme: "light",
      definition:
        "sequenceDiagram\n  participant U as Agent\n  U->>S: submit\n  S-->>U: ok",
    });

    expect(svg).toContain("pele-sequence");
    expect(svg).toContain("submit");
  });

  it("honours classDef colors written in the source", () => {
    const svg = renderDiagramSvg({
      theme: "light",
      definition:
        'flowchart LR\n  A["x"] --> B["y"]\n  classDef data fill:#dbeafe,stroke:#2563eb,color:#111827\n  B:::data',
    });

    expect(svg).toContain("#dbeafe");
  });

  it("throws a displayable error for a broken definition", () => {
    expect(() =>
      renderDiagramSvg({
        theme: "light",
        definition: "flowchart LR\n  A[unterminated --> B",
      }),
    ).toThrowError(/\(line \d+/u);
  });

  it("reports unregistered diagram types instead of rendering nothing", () => {
    expect(() =>
      renderDiagramSvg({ theme: "light", definition: "mindmap\n  root((x))" }),
    ).toThrowError(/This UI renders/u);
  });
});
