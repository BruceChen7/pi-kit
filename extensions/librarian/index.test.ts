/* biome-ignore-all lint/suspicious/noExplicitAny: test mock boundary */
import { describe, expect, it, vi } from "vitest";
import { parseRepository, summarizeGithubToolCall } from "./github.js";
import { parseGitLabProject } from "./gitlab.js";
import registerLibrarianTools from "./index.js";
import { globMatches, normalizePath, validateSearchPattern } from "./shared.js";

// ---- Module structure tests (TDD-driven refactoring) ----

describe("shared module exports", () => {
  it("exports normalizePath", async () => {
    const mod = await import("./shared.js");
    expect(typeof mod.normalizePath).toBe("function");
    expect(mod.normalizePath("/src/./index.ts")).toBe("src/index.ts");
  });

  it("exports globMatches", async () => {
    const mod = await import("./shared.js");
    expect(typeof mod.globMatches).toBe("function");
    expect(mod.globMatches("**/*.ts", "src/index.ts")).toBe(true);
  });

  it("exports validateSearchPattern", async () => {
    const mod = await import("./shared.js");
    expect(typeof mod.validateSearchPattern).toBe("function");
  });

  it("exports formatNumberedFileContent", async () => {
    const mod = await import("./shared.js");
    expect(typeof mod.formatNumberedFileContent).toBe("function");
  });

  it("exports truncateInline", async () => {
    const mod = await import("./shared.js");
    expect(typeof mod.truncateInline).toBe("function");
    expect(mod.truncateInline("hello world", 5)).toBe("hell…");
  });

  it("exports formatDuration", async () => {
    const mod = await import("./shared.js");
    expect(typeof mod.formatDuration).toBe("function");
  });

  it("exports sanitizeParamValue", async () => {
    const mod = await import("./shared.js");
    expect(typeof mod.sanitizeParamValue).toBe("function");
  });

  it("exports stripAnsiAndControl", async () => {
    const mod = await import("./shared.js");
    expect(typeof mod.stripAnsiAndControl).toBe("function");
  });

  it("exports sanitizeDisplayText", async () => {
    const mod = await import("./shared.js");
    expect(typeof mod.sanitizeDisplayText).toBe("function");
  });

  it("exports asTextResult", async () => {
    const mod = await import("./shared.js");
    expect(typeof mod.asTextResult).toBe("function");
  });

  it("exports toolErrorResult", async () => {
    const mod = await import("./shared.js");
    expect(typeof mod.toolErrorResult).toBe("function");
  });
});

type RegisteredTool = {
  name: string;
  execute: (
    id: string | undefined,
    params: Record<string, unknown>,
  ) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
};

function registerToolsForTest() {
  const tools = new Map<string, RegisteredTool>();
  const pi = {
    exec: vi.fn(),
    registerTool: vi.fn((tool: RegisteredTool) => tools.set(tool.name, tool)),
  };

  registerLibrarianTools(pi as Parameters<typeof registerLibrarianTools>[0]);

  return { pi, tools };
}

function requireTool(tools: Map<string, RegisteredTool>, name: string) {
  const tool = tools.get(name);
  if (!tool) throw new Error(`Expected ${name} to be registered`);
  return tool;
}

describe("github module exports", () => {
  it("exports parseRepository", async () => {
    const mod = await import("./github.js");
    expect(typeof mod.parseRepository).toBe("function");
    expect(mod.parseRepository("acme/project")).toEqual({
      owner: "acme",
      repo: "project",
      fullName: "acme/project",
    });
  });

  it("exports encodeGitHubPath", async () => {
    const mod = await import("./github.js");
    expect(typeof mod.encodeGitHubPath).toBe("function");
    expect(mod.encodeGitHubPath("src/index.ts")).toBe("src/index.ts");
    expect(mod.encodeGitHubPath("src/My File.ts")).toBe("src/My%20File.ts");
  });

  it("exports ghApi", async () => {
    const mod = await import("./github.js");
    expect(typeof mod.ghApi).toBe("function");
  });

  it("exports registerGithubTools which registers GitHub tools", async () => {
    const pi = { registerTool: vi.fn() };
    const { registerGithubTools } = await import("./github.js");
    registerGithubTools(pi as any);
    expect(pi.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "read_github" }),
    );
    expect(pi.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "list_directory_github" }),
    );
    expect(pi.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "glob_github" }),
    );
    expect(pi.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "search_github" }),
    );
    expect(pi.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "commit_search" }),
    );
    expect(pi.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "diff" }),
    );
    expect(pi.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "list_github_repositories" }),
    );
  });
});

describe("librarian repository parsing", () => {
  it("normalizes owner/repo input", () => {
    expect(parseRepository("acme/project")).toEqual({
      owner: "acme",
      repo: "project",
      fullName: "acme/project",
    });
  });

  it("normalizes GitHub URLs and strips .git suffix", () => {
    expect(
      parseRepository("https://github.com/acme/project.git").fullName,
    ).toBe("acme/project");
  });

  it("rejects non-GitHub repository URLs", () => {
    expect(() => parseRepository("https://gitlab.com/acme/project")).toThrow(
      /Only github\.com repositories/,
    );
  });
});

describe("gitlab module exports", () => {
  it("exports parseGitLabProject", async () => {
    const mod = await import("./gitlab.js");
    expect(typeof mod.parseGitLabProject).toBe("function");
    expect(mod.parseGitLabProject("acme/project")).toEqual({
      host: "gitlab.com",
      fullPath: "acme/project",
      encodedPath: "acme%2Fproject",
    });
  });

  it("exports glabApi", async () => {
    const mod = await import("./gitlab.js");
    expect(typeof mod.glabApi).toBe("function");
  });

  it("exports summarizeGitlabToolCall", async () => {
    const mod = await import("./gitlab.js");
    expect(typeof mod.summarizeGitlabToolCall).toBe("function");
  });

  it("exports registerGitlabTools which registers GitLab tools", async () => {
    const pi = { registerTool: vi.fn() };
    const { registerGitlabTools } = await import("./gitlab.js");
    registerGitlabTools(pi as any);
    expect(pi.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "read_gitlab" }),
    );
    expect(pi.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "list_directory_gitlab" }),
    );
    expect(pi.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "glob_gitlab" }),
    );
    expect(pi.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "search_gitlab" }),
    );
    expect(pi.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "commit_search_gitlab" }),
    );
    expect(pi.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "diff_gitlab" }),
    );
    expect(pi.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "list_gitlab_projects" }),
    );
  });
});

describe("librarian GitLab project parsing", () => {
  it("normalizes group/project input against gitlab.com", () => {
    expect(parseGitLabProject("acme/project")).toEqual({
      host: "gitlab.com",
      fullPath: "acme/project",
      encodedPath: "acme%2Fproject",
    });
  });

  it("normalizes self-managed GitLab URLs and strips .git suffix", () => {
    expect(
      parseGitLabProject("https://gitlab.example.com/acme/tools/project.git"),
    ).toEqual({
      host: "gitlab.example.com",
      fullPath: "acme/tools/project",
      encodedPath: "acme%2Ftools%2Fproject",
    });
  });

  it("rejects invalid GitLab project identifiers", () => {
    expect(() => parseGitLabProject("project-only")).toThrow(
      /expected group\/project/,
    );
  });
});

describe("librarian path normalization", () => {
  it("removes leading slashes and dot segments", () => {
    expect(normalizePath("/src/./index.ts")).toBe("src/index.ts");
  });

  it("decodes safe percent-encoded path segments", () => {
    expect(normalizePath("docs/My%20File.md")).toBe("docs/My File.md");
  });

  it("rejects parent traversal", () => {
    expect(() => normalizePath("src/../secret.txt")).toThrow(
      /parent traversal/,
    );
  });

  it("rejects encoded path separators", () => {
    expect(() => normalizePath("src%2Fsecret.txt")).toThrow(
      /encoded path separators/,
    );
  });
});

describe("librarian glob matching", () => {
  it("matches recursive TypeScript patterns", () => {
    expect(globMatches("**/*.ts", "src/index.ts")).toBe(true);
    expect(globMatches("**/*.ts", "index.ts")).toBe(true);
    expect(globMatches("**/*.ts", "src/index.js")).toBe(false);
  });

  it("supports brace alternatives", () => {
    expect(globMatches("**/*.{ts,tsx}", "src/component.tsx")).toBe(true);
    expect(globMatches("**/*.{ts,tsx}", "src/component.jsx")).toBe(false);
  });
});

describe("librarian search validation", () => {
  it("accepts a simple search term", () => {
    expect(() => validateSearchPattern("registerTool")).not.toThrow();
  });

  it("rejects boolean-only searches", () => {
    expect(() => validateSearchPattern("AND OR NOT")).toThrow(
      /at least one search term/,
    );
  });

  it("rejects too many boolean operators", () => {
    expect(() =>
      validateSearchPattern("a AND b OR c AND d OR e AND f OR g"),
    ).toThrow(/max 5 boolean operators/);
  });
});

describe("librarian search tool", () => {
  it("rejects path qualifiers that could alter the GitHub search query", async () => {
    const { pi, tools } = registerToolsForTest();
    const searchGithub = requireTool(tools, "search_github");

    const result = await searchGithub.execute(undefined, {
      pattern: "registerTool",
      repository: "acme/project",
      path: "src fork:true",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid path");
    expect(pi.exec).not.toHaveBeenCalled();
  });

  it("registers GitLab tools", () => {
    const { tools } = registerToolsForTest();

    expect(requireTool(tools, "read_gitlab")).toBeDefined();
    expect(requireTool(tools, "list_directory_gitlab")).toBeDefined();
    expect(requireTool(tools, "glob_gitlab")).toBeDefined();
    expect(requireTool(tools, "search_gitlab")).toBeDefined();
    expect(requireTool(tools, "commit_search_gitlab")).toBeDefined();
    expect(requireTool(tools, "diff_gitlab")).toBeDefined();
    expect(requireTool(tools, "list_gitlab_projects")).toBeDefined();
  });

  it("rejects path qualifiers that could alter the GitLab search query", async () => {
    const { pi, tools } = registerToolsForTest();
    const searchGitlab = requireTool(tools, "search_gitlab");

    const result = await searchGitlab.execute(undefined, {
      pattern: "registerTool",
      project: "acme/project",
      path: "src fork:true",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid path");
    expect(pi.exec).not.toHaveBeenCalled();
  });

  it("reads GitLab files through glab and returns numbered content", async () => {
    const { pi, tools } = registerToolsForTest();
    pi.exec.mockResolvedValue({
      code: 0,
      stdout: "hello\nworld\n",
      stderr: "",
    });
    const readGitlab = requireTool(tools, "read_gitlab");

    const result = await readGitlab.execute(undefined, {
      project: "https://gitlab.example.com/acme/project",
      path: "README.md",
      ref: "main",
      read_range: [2, 2],
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("2: world");
    expect(pi.exec).toHaveBeenCalledWith(
      "glab",
      [
        "api",
        "--hostname",
        "gitlab.example.com",
        "projects/acme%2Fproject/repository/files/README.md/raw?ref=main",
        "--method",
        "GET",
      ],
      expect.objectContaining({ timeout: 90_000 }),
    );
  });
});

describe("librarian-github module exports", () => {
  it("exports registerLibrarianGithub", async () => {
    const mod = await import("./librarian-github.js");
    expect(typeof mod.registerLibrarianGithub).toBe("function");
  });

  it("registerLibrarianGithub registers librarian_github tool", async () => {
    const pi = { registerTool: vi.fn() };
    const { registerLibrarianGithub } = await import("./librarian-github.js");
    registerLibrarianGithub(pi as any);
    expect(pi.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "librarian_github" }),
    );
  });
});

describe("librarian-gitlab module exports", () => {
  it("exports registerLibrarianGitlab", async () => {
    const mod = await import("./librarian-gitlab.js");
    expect(typeof mod.registerLibrarianGitlab).toBe("function");
  });

  it("registerLibrarianGitlab registers librarian_gitlab tool", async () => {
    const pi = { registerTool: vi.fn() };
    const { registerLibrarianGitlab } = await import("./librarian-gitlab.js");
    registerLibrarianGitlab(pi as any);
    expect(pi.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "librarian_gitlab" }),
    );
  });
});

describe("librarian-runner module exports", () => {
  it("exports runLibrarianSubagent", async () => {
    const mod = await import("./librarian-runner.js");
    expect(typeof mod.runLibrarianSubagent).toBe("function");
  });

  it("exports renderProgress", async () => {
    const mod = await import("./librarian-runner.js");
    expect(typeof mod.renderProgress).toBe("function");
    const state = {
      startedAt: Date.now(),
      phase: "exploring" as const,
      startedTools: 3,
      completedTools: 2,
      failedTools: 0,
      currentAction: "Searching code",
      recentActions: ["✓ read_github", "✗ search_github"],
    };
    const rendered = mod.renderProgress(state);
    expect(rendered).toContain("Librarian");
    expect(rendered).toContain("2/3");
  });
});

describe("entry point registration", () => {
  it("registers all tools from the index entry", () => {
    const pi = { registerTool: vi.fn() };
    registerLibrarianTools(pi as any);

    const expectedTools = [
      "read_github",
      "list_directory_github",
      "glob_github",
      "search_github",
      "commit_search",
      "diff",
      "list_github_repositories",
      "read_gitlab",
      "list_directory_gitlab",
      "glob_gitlab",
      "search_gitlab",
      "commit_search_gitlab",
      "diff_gitlab",
      "list_gitlab_projects",
      "librarian_github",
      "librarian_gitlab",
    ];

    for (const toolName of expectedTools) {
      expect(pi.registerTool).toHaveBeenCalledWith(
        expect.objectContaining({ name: toolName }),
      );
    }
  });
});

describe("librarian event parsing", () => {
  it("parseLibrarianEvent returns null for empty line", async () => {
    const { parseLibrarianEvent } = await import("./librarian-runner.js");
    expect(parseLibrarianEvent("")).toBeNull();
  });

  it("parseLibrarianEvent returns null for non-JSON line", async () => {
    const { parseLibrarianEvent } = await import("./librarian-runner.js");
    expect(parseLibrarianEvent("not json")).toBeNull();
  });

  it("parseLibrarianEvent parses tool_execution_start", async () => {
    const { parseLibrarianEvent } = await import("./librarian-runner.js");
    const result = parseLibrarianEvent(
      JSON.stringify({
        type: "tool_execution_start",
        toolName: "read_github",
        toolCallId: "call-1",
        args: { repository: "acme/project", path: "src/index.ts" },
      }),
      (name, args) => `${name}:${args?.path ?? "?"}`,
    );
    expect(result).toEqual({
      kind: "tool_start",
      toolName: "read_github",
      toolCallId: "call-1",
      summary: "read_github:src/index.ts",
    });
  });

  it("parseLibrarianEvent parses tool_execution_end with error", async () => {
    const { parseLibrarianEvent } = await import("./librarian-runner.js");
    const result = parseLibrarianEvent(
      JSON.stringify({
        type: "tool_execution_end",
        toolName: "search_github",
        toolCallId: "call-2",
        args: { pattern: "foo" },
        isError: true,
      }),
      (_name, _args) => "some-tool",
    );
    expect(result).toEqual({
      kind: "tool_end",
      toolName: "search_github",
      toolCallId: "call-2",
      summary: "some-tool",
      isError: true,
    });
  });

  it("parseLibrarianEvent detects writing phase from text_start", async () => {
    const { parseLibrarianEvent } = await import("./librarian-runner.js");
    const result = parseLibrarianEvent(
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_start" },
      }),
      () => "",
    );
    expect(result).toEqual({ kind: "writing_phase" });
  });

  it("parseLibrarianEvent captures assistant message_end", async () => {
    const { parseLibrarianEvent } = await import("./librarian-runner.js");
    const result = parseLibrarianEvent(
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Here is the answer." }],
          stopReason: "end_turn",
        },
      }),
      () => "",
    );
    expect(result).toEqual({
      kind: "assistant_message",
      text: "Here is the answer.",
      details: { phase: "assistant", stopReason: "end_turn" },
    });
  });

  it("parseLibrarianEvent captures result event", async () => {
    const { parseLibrarianEvent } = await import("./librarian-runner.js");
    const result = parseLibrarianEvent(
      JSON.stringify({
        type: "result",
        result: "Final answer text",
      }),
      () => "",
    );
    expect(result).toEqual({
      kind: "result",
      text: "Final answer text",
    });
  });
});

describe("librarian progress summaries", () => {
  it("summarizes read_github calls", () => {
    expect(
      summarizeGithubToolCall("read_github", {
        repository: "acme/project",
        path: "src/index.ts",
      }),
    ).toBe("Reading acme/project:src/index.ts");
  });

  it("truncates long search patterns", () => {
    const summary = summarizeGithubToolCall("search_github", {
      repository: "acme/project",
      pattern: "x".repeat(100),
    });

    expect(summary).toContain("Searching code");
    expect(summary.length).toBeLessThan(100);
  });
});
