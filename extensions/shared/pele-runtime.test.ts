import { afterEach, describe, expect, it } from "vitest";
import { formatPeleError, peleErrorLine } from "./pele-error.ts";
import { getPeleParser } from "./pele-runtime.ts";

const DOM_GLOBALS = ["window", "document", "HTMLElement"] as const;
const host = globalThis as Record<string, unknown>;

const diagrams = {
  flowchart: "graph TD\n  A[开始] --> B{判断}\n  B -->|是| C[结束]",
  graph: "graph LR\n  A --> B",
  sequenceDiagram: "sequenceDiagram\n  Alice->>Bob: hi",
  classDiagram: "classDiagram\n  class Animal {\n    +String name\n  }",
  stateDiagram: "stateDiagram-v2\n  [*] --> Idle\n  Idle --> [*]",
  erDiagram: "erDiagram\n  CUSTOMER ||--o{ ORDER : places",
  mindmap: "mindmap\n  root((root))\n    a\n    b",
  gantt:
    "gantt\n  dateFormat YYYY-MM-DD\n  section S\n  Task :a1, 2024-01-01, 3d",
};

const brokenFlowchart = "flowchart LR\n  A[bad (label] --> B";

const expectNoDomGlobals = (context: string): void => {
  for (const key of DOM_GLOBALS) {
    expect(Object.hasOwn(host, key), `${context}: ${key} 不应被创建`).toBe(
      false,
    );
  }
};

const parseError = (parser: { parse(code: string): unknown }, code: string) => {
  try {
    parser.parse(code);
    return undefined;
  } catch (error) {
    return error;
  }
};

afterEach(() => {
  for (const key of DOM_GLOBALS) delete host[key];
});

describe("pele runtime", () => {
  it("parses every diagram type in the corpus without creating a DOM", async () => {
    const parser = await getPeleParser();

    for (const [name, code] of Object.entries(diagrams)) {
      expect(() => parser.parse(code), name).not.toThrow();
      expectNoDomGlobals(`${name} 解析之后`);
    }
  });

  it("reports the body-relative line for broken syntax", async () => {
    const parser = await getPeleParser();
    const error = parseError(parser, brokenFlowchart);

    expect(peleErrorLine(error)).toBe(2);
    expect(formatPeleError(error)).toContain("Expecting");
  });

  it("strips leading frontmatter before numbering lines", async () => {
    const parser = await getPeleParser();
    const error = parseError(
      parser,
      "---\nconfig:\n  theme: base\n---\nflowchart LR\n  A --> B(",
    );

    // pele drops the 4 frontmatter lines, so the EOF error is body line 3.
    expect(peleErrorLine(error)).toBe(3);
  });

  it("keeps window/document untouched when the host already has them", async () => {
    const hostWindow = { marker: "host" };
    const hostDocument = { marker: "host" };
    host.window = hostWindow;
    host.document = hostDocument;

    const parser = await getPeleParser();
    parser.parse(diagrams.flowchart);

    expect(host.window).toBe(hostWindow);
    expect(host.document).toBe(hostDocument);
  });
});
