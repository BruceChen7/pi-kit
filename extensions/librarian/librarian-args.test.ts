import { describe, expect, it } from "vitest";
import { buildLibrarianSubagentArgs } from "./librarian-runner.js";

describe("buildLibrarianSubagentArgs", () => {
  it("builds a minimal headless pi invocation with the extension and prompt", () => {
    expect(
      buildLibrarianSubagentArgs({
        extensionPath: "/ext/librarian.ts",
        promptPath: "/tmp/pi-librarian-x/system-prompt.md",
        query: "summarize the repo",
      }),
    ).toEqual([
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-mcp",
      "-e",
      "/ext/librarian.ts",
      "--append-system-prompt",
      "/tmp/pi-librarian-x/system-prompt.md",
      "summarize the repo",
    ]);
  });

  it("keeps MCP off so derived subagents do not inherit user servers", () => {
    const args = buildLibrarianSubagentArgs({
      extensionPath: "/ext/librarian.ts",
      promptPath: "/tmp/prompt.md",
      query: "q",
    });

    expect(args).toContain("--no-mcp");
    expect(args).toContain("--no-extensions");
  });
});
