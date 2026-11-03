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

  it("reports the line of the offending token for broken syntax", async () => {
    const parser = await getPeleParser();
    const error = parseError(parser, brokenFlowchart);

    expect(peleErrorLine(error)).toBe(2);
    expect(formatPeleError(error)).toContain("Expecting");
  });

  it("counts leading blank lines into the reported line", async () => {
    const parser = await getPeleParser();
    const error = parseError(parser, "\n\nflowchart LR\n  A --> B(");

    // 没有 frontmatter 时相对行等于绝对行；前导空行不会被剥掉。
    expect(peleErrorLine(error)).toBe(4);
  });

  it("numbers lines against the whole block body, frontmatter included", async () => {
    const parser = await getPeleParser();
    const error = parseError(
      parser,
      "---\nconfig:\n  theme: base\n---\nflowchart LR\n  A --> B(",
    );

    // pele 1.13.0 不再把行号算成「抽掉 frontmatter 之后」的相对值：它报的是
    // 整个 block body 里的绝对行号。这里 dangling `(` 在 body 的第 6 行，所以就是 6。
    // （1.7.0 报的是抽掉 4 行 frontmatter 之后的 EOF 行 3。）
    expect(peleErrorLine(error)).toBe(6);
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
