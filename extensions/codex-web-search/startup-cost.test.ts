import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import codexWebSearchExtension from "./index.js";

// codex.ts is 59KB of search pipeline. Loading it at registration would put that
// on every pi start, so the "no static import" rule is the thing under test.
const indexSource = fs.readFileSync(
  new URL("./index.ts", import.meta.url),
  "utf8",
);

describe("codex-web-search startup cost", () => {
  it("does not import the search pipeline statically", () => {
    expect(indexSource).not.toMatch(/^import\s[^;]*from\s+"\.\/codex\.js"/m);
    expect(indexSource).toMatch(/await import\("\.\/codex\.js"\)/);
  });

  it("registers the web_search tool and settings command without it", () => {
    const registered: string[] = [];
    const pi = {
      on: vi.fn(),
      registerCommand: vi.fn(),
      registerTool: vi.fn((tool: { name: string }) =>
        registered.push(tool.name),
      ),
    };

    codexWebSearchExtension(
      pi as unknown as Parameters<typeof codexWebSearchExtension>[0],
    );

    expect(registered).toEqual(["web_search"]);
    expect(pi.registerCommand).toHaveBeenCalled();
  });
});
