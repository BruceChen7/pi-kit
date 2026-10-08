import { describe, expect, it } from "vitest";
import { buildLibrarianSubagentArgs } from "./librarian-runner.js";

const SUBAGENT_TOOLS = [
  "read_github",
  "search_github",
  "commit_search",
  "diff",
  "list_directory_github",
  "list_github_repositories",
  "glob_github",
];

describe("buildLibrarianSubagentArgs", () => {
  it("builds a minimal headless pi invocation with the extension and prompt", () => {
    expect(
      buildLibrarianSubagentArgs({
        extensionPath: "/ext/librarian.ts",
        promptPath: "/tmp/pi-librarian-x/system-prompt.md",
        query: "summarize the repo",
        subagentTools: SUBAGENT_TOOLS,
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
      "--tools",
      SUBAGENT_TOOLS.map((name) => `+${name}`).join(","),
      "-e",
      "/ext/librarian.ts",
      "--append-system-prompt",
      "/tmp/pi-librarian-x/system-prompt.md",
      "summarize the repo",
    ]);
  });

  it("activates every requested tool by name", () => {
    const args = buildLibrarianSubagentArgs({
      extensionPath: "/ext/librarian.ts",
      promptPath: "/tmp/prompt.md",
      query: "q",
      subagentTools: SUBAGENT_TOOLS,
    });

    const toolsArg = args[args.indexOf("--tools") + 1];
    // `+name` adds to the child's resolved defaults; the plain allowlist form
    // cannot activate an `exposure: "codemode"` tool.
    expect(toolsArg?.startsWith("+")).toBe(true);
    for (const name of SUBAGENT_TOOLS) {
      expect(toolsArg?.split(",")).toContain(`+${name}`);
    }
  });

  it("keeps MCP off so derived subagents do not inherit user servers", () => {
    const args = buildLibrarianSubagentArgs({
      extensionPath: "/ext/librarian.ts",
      promptPath: "/tmp/prompt.md",
      query: "q",
      subagentTools: SUBAGENT_TOOLS,
    });

    expect(args).toContain("--no-mcp");
    expect(args).toContain("--no-extensions");
  });
});
