import { describe, expect, it } from "vitest";
import {
  buildLibrarianSubagentArgs,
  librarianSubagentTools,
} from "./librarian-runner.js";

const PROVIDER_TOOLS = [
  "read_github",
  "search_github",
  "commit_search",
  "diff",
  "list_directory_github",
  "list_github_repositories",
  "glob_github",
];

/** The `--tools` argument the CLI must receive: provider tools plus local reads. */
const EXPECTED_TOOLS_ARG = [
  "+read_github",
  "+search_github",
  "+commit_search",
  "+diff",
  "+list_directory_github",
  "+list_github_repositories",
  "+glob_github",
  "+read",
  "+grep",
  "+find",
  "+ls",
].join(",");

describe("librarianSubagentTools", () => {
  it("adds the read-only local tools to the provider tools", () => {
    expect(librarianSubagentTools(PROVIDER_TOOLS)).toEqual([
      ...PROVIDER_TOOLS,
      "read",
      "grep",
      "find",
      "ls",
    ]);
  });

  it("never grants local tools that run commands or modify the workspace", () => {
    const tools = librarianSubagentTools(PROVIDER_TOOLS);

    for (const tool of ["bash", "edit", "write", "codemode"]) {
      expect(tools).not.toContain(tool);
    }
  });
});

describe("buildLibrarianSubagentArgs", () => {
  it("builds a minimal headless pi invocation with the extension and prompt", () => {
    expect(
      buildLibrarianSubagentArgs({
        extensionPath: "/ext/librarian.ts",
        promptPath: "/tmp/pi-librarian-x/system-prompt.md",
        query: "summarize the repo",
        subagentTools: librarianSubagentTools(PROVIDER_TOOLS),
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
      "--no-tools",
      "--tools",
      EXPECTED_TOOLS_ARG,
      "-e",
      "/ext/librarian.ts",
      "--append-system-prompt",
      "/tmp/pi-librarian-x/system-prompt.md",
      "summarize the repo",
    ]);
  });

  it("activates exactly the requested tools and nothing else", () => {
    const args = buildLibrarianSubagentArgs({
      extensionPath: "/ext/librarian.ts",
      promptPath: "/tmp/prompt.md",
      query: "q",
      subagentTools: librarianSubagentTools(PROVIDER_TOOLS),
    });

    const toolsArg = args[args.indexOf("--tools") + 1];
    // `+name` entries adjust the default selection, so every tool is named
    // explicitly and none is activated implicitly.
    expect(toolsArg).toBe(EXPECTED_TOOLS_ARG);
  });

  it("starts from an empty tool set so the subagent stays isolated", () => {
    const args = buildLibrarianSubagentArgs({
      extensionPath: "/ext/librarian.ts",
      promptPath: "/tmp/prompt.md",
      query: "q",
      subagentTools: librarianSubagentTools(PROVIDER_TOOLS),
    });

    // Without `--no-tools`, `+name` keeps the child's default tools
    // (bash, edit, write) and every `direct` tool the loaded extension
    // registers on load (`librarian_github`, `librarian_gitlab`), which would
    // give the subagent shell/write access and let it nest subagents.
    const noTools = args.indexOf("--no-tools");
    expect(noTools).toBeGreaterThanOrEqual(0);
    expect(noTools).toBeLessThan(args.indexOf("--tools"));
  });

  it("keeps MCP off so derived subagents do not inherit user servers", () => {
    const args = buildLibrarianSubagentArgs({
      extensionPath: "/ext/librarian.ts",
      promptPath: "/tmp/prompt.md",
      query: "q",
      subagentTools: librarianSubagentTools(PROVIDER_TOOLS),
    });

    expect(args).toContain("--no-mcp");
    expect(args).toContain("--no-extensions");
  });
});
