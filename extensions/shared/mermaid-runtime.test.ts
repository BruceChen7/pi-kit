import { afterEach, describe, expect, it } from "vitest";
import { getMermaidParser, resetMermaidModule } from "./mermaid-runtime.ts";

const DOM_GLOBALS = ["window", "document", "HTMLElement"] as const;
const host = globalThis as Record<string, unknown>;

const diagrams = {
  flowchart: "graph TD\n  A[开始] --> B{判断}\n  B -->|是| C[结束]",
  mindmap: "mindmap\n  root((root))\n    a\n    b",
  sequenceDiagram: "sequenceDiagram\n  Alice->>Bob: hi",
  classDiagram: "classDiagram\n  class Animal { +int age }",
};

const invalidDiagram = "graph TD\n  A[unterminated";

function expectNoDomGlobals(context: string): void {
  for (const key of DOM_GLOBALS) {
    expect(
      Object.hasOwn(host, key),
      `${context}: globalThis.${key} 属性不应残留`,
    ).toBe(false);
    expect(
      host[key],
      `${context}: globalThis.${key} 应为 undefined`,
    ).toBeUndefined();
  }
}

afterEach(() => {
  resetMermaidModule();
  for (const key of DOM_GLOBALS) delete host[key];
});

describe("mermaid runtime DOM scope", () => {
  it("解析结束后不把 window/document 留给宿主进程", async () => {
    const parser = await getMermaidParser();
    parser.initialize({ startOnLoad: false, securityLevel: "loose" });
    await parser.parse(diagrams.flowchart);
    expectNoDomGlobals("parse 之后");
  });

  it("每种图类型都能解析，且每次都还原全局", async () => {
    const parser = await getMermaidParser();
    for (const [name, code] of Object.entries(diagrams)) {
      await parser.parse(code);
      expectNoDomGlobals(`${name} 解析之后`);
    }
  });

  it("并发解析被串行化：全部 settle、非法图仍报错、最终全局干净", async () => {
    const parser = await getMermaidParser();
    const codes = [
      ...Object.values(diagrams),
      diagrams.flowchart,
      diagrams.mindmap,
      diagrams.flowchart,
      diagrams.sequenceDiagram,
      diagrams.flowchart,
      diagrams.classDiagram,
      invalidDiagram,
    ];

    const results = await Promise.allSettled(
      codes.map((code) => parser.parse(code)),
    );

    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(codes.length - 1);
    expectNoDomGlobals("并发解析之后");
  });

  it("宿主已有 DOM 时完全不碰，也不删除宿主的对象", async () => {
    const { parseHTML } = await import("linkedom");
    const hostWindow = parseHTML(
      "<!DOCTYPE html><html><body></body></html>",
    ).window;
    host.window = hostWindow;
    host.document = hostWindow.document;

    const parser = await getMermaidParser();
    await parser.parse(diagrams.flowchart);

    expect(host.window).toBe(hostWindow);
    expect(host.document).toBe(hostWindow.document);
  });

  it("resetMermaidModule 之后可以重新解析", async () => {
    const first = await getMermaidParser();
    await first.parse(diagrams.flowchart);
    resetMermaidModule();

    const second = await getMermaidParser();
    await second.parse(diagrams.mindmap);
    expectNoDomGlobals("重置之后");
  });
});
