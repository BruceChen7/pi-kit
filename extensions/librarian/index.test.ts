import { describe, expect, it, vi } from "vitest";
import registerLibrarianTools, {
  globMatches,
  normalizePath,
  parseGitLabProject,
  parseRepository,
  summarizeToolCall,
  validateSearchPattern,
} from "./index.js";

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

describe("librarian progress summaries", () => {
  it("summarizes read_github calls", () => {
    expect(
      summarizeToolCall("read_github", {
        repository: "acme/project",
        path: "src/index.ts",
      }),
    ).toBe("Reading acme/project:src/index.ts");
  });

  it("truncates long search patterns", () => {
    const summary = summarizeToolCall("search_github", {
      repository: "acme/project",
      pattern: "x".repeat(100),
    });

    expect(summary).toContain("Searching code");
    expect(summary.length).toBeLessThan(100);
  });
});
