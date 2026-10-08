/* biome-ignore-all lint/suspicious/noExplicitAny: test mock boundary */
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import registerLibrarianTools from "./index.js";
import {
  librarianSubagentOutputSchema,
  librarianSubagentResult,
  librarianToolOutputSchemas,
} from "./output-schemas.js";

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  details?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
};

type RegisteredTool = {
  name: string;
  description: string;
  parameters: unknown;
  outputSchema?: TSchema;
  exposure?: string;
  execute: (
    id: string | undefined,
    params: Record<string, unknown>,
  ) => Promise<ToolResult>;
};

/** Tools the model may only reach through a codemode script. */
const CODEMODE_DATA_TOOLS = [
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
];

/** Tools that stay declared, so librarian capability survives without codemode. */
const DIRECT_TOOLS = ["librarian_github", "librarian_gitlab"];

function fakePi() {
  const tools = new Map<string, RegisteredTool>();
  const exec = vi.fn(
    async (_command: string, _args: string[], _options?: unknown) => ({
      code: 0,
      stdout: "",
      stderr: "",
    }),
  );
  const pi = {
    exec,
    registerTool: vi.fn((tool: RegisteredTool) => {
      tools.set(tool.name, tool);
    }),
  };

  registerLibrarianTools(
    pi as unknown as Parameters<typeof registerLibrarianTools>[0],
  );

  return { pi, tools };
}

function requireTool(
  tools: Map<string, RegisteredTool>,
  name: string,
): RegisteredTool {
  const tool = tools.get(name);
  if (!tool) throw new Error(`Expected ${name} to be registered`);
  return tool;
}

/**
 * Answers `pi.exec` with the JSON a `gh`/`glab` call would print, so the test
 * drives the real adapter path (endpoint → payload) instead of stubbing the
 * tools' own mapping. `{ raw }` answers verbatim, as `glab` does for raw files.
 */
function stubApi(
  pi: ReturnType<typeof fakePi>["pi"],
  respond: (endpoint: string) => unknown | { raw: string },
): void {
  pi.exec.mockImplementation(async (command: string, args: string[]) => {
    const endpoint = command === "glab" ? (args[3] ?? "") : (args[1] ?? "");
    const value = respond(endpoint);
    const stdout =
      typeof value === "object" && value !== null && "raw" in value
        ? (value as { raw: string }).raw
        : JSON.stringify(value);
    return { code: 0, stdout, stderr: "" };
  });
}

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

/**
 * The codemode-facing contract: one payload object, shared with `details`,
 * valid per the declared schema, and still the JSON the model reads.
 */
function expectStructuredResult(
  tool: RegisteredTool,
  result: ToolResult,
): unknown {
  expect(tool.outputSchema).toBeDefined();
  expect(result.isError).toBeUndefined();
  expect(result.structuredContent).toBeDefined();
  expect(result.structuredContent).toBe(result.details);
  expect(
    Value.Check(tool.outputSchema as TSchema, result.structuredContent),
  ).toBe(true);
  expect(result.content).toEqual([
    { type: "text", text: JSON.stringify(result.structuredContent, null, 2) },
  ]);
  return result.structuredContent;
}

describe("librarian output schema coverage", () => {
  it("declares the mapped schema on every librarian tool", () => {
    const { tools } = fakePi();

    expect([...tools.keys()].sort()).toEqual(
      Object.keys(librarianToolOutputSchemas).sort(),
    );

    for (const [name, schema] of Object.entries(librarianToolOutputSchemas)) {
      expect(requireTool(tools, name).outputSchema).toBe(schema);
    }
  });

  it("shares one schema per payload shape", () => {
    expect(librarianToolOutputSchemas.read_github).toBe(
      librarianToolOutputSchemas.read_gitlab,
    );
    expect(librarianToolOutputSchemas.search_github).toBe(
      librarianToolOutputSchemas.search_gitlab,
    );
    expect(librarianToolOutputSchemas.librarian_github).toBe(
      librarianToolOutputSchemas.librarian_gitlab,
    );
  });

  it("keeps the fan-out data tools codemode-only", () => {
    const { tools } = fakePi();

    expect(
      [...tools.values()]
        .filter((tool) => tool.exposure === "codemode")
        .map((tool) => tool.name)
        .sort(),
    ).toEqual([...CODEMODE_DATA_TOOLS].sort());
  });

  it("leaves the model-facing entries declared without codemode", () => {
    const { tools } = fakePi();

    expect(
      [...tools.values()]
        .filter((tool) => tool.exposure === undefined)
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(DIRECT_TOOLS);
  });

  it("keeps the codemode listing inside the default inline budget", () => {
    // pi's codemode description spends `codemode.inlineBudget` (default 3000)
    // estimated tokens on tool sections and silently drops what does not fit,
    // which would make these tools undiscoverable. Estimated at 4 chars per
    // token like pi does, plus ~30 tokens per section for headings and
    // declarations pi renders around the description.
    const { tools } = fakePi();
    const estimated = CODEMODE_DATA_TOOLS.reduce((sum, name) => {
      const tool = requireTool(tools, name);
      const chars =
        tool.description.length + JSON.stringify(tool.parameters).length;
      return sum + Math.ceil(chars / 4) + 30;
    }, 0);

    expect(estimated).toBeLessThan(3000);
  });
});

describe("github tool structured output", () => {
  it("read_github returns numbered file content", async () => {
    const { pi, tools } = fakePi();
    stubApi(pi, () => ({ encoding: "base64", content: b64("# hi\n") }));
    const tool = requireTool(tools, "read_github");

    const result = await tool.execute(undefined, {
      repository: "acme/project",
      path: "README.md",
    });

    expect(expectStructuredResult(tool, result)).toEqual({
      absolutePath: "README.md",
      content: "1: # hi\n2: ",
    });
  });

  it("list_directory_github returns sorted entries with directory markers", async () => {
    const { pi, tools } = fakePi();
    stubApi(pi, () => [
      { name: "a.ts", type: "file" },
      { name: "src", type: "dir" },
    ]);
    const tool = requireTool(tools, "list_directory_github");

    const result = await tool.execute(undefined, {
      repository: "acme/project",
      path: "/",
    });

    expect(expectStructuredResult(tool, result)).toEqual(["src/", "a.ts"]);
  });

  it("glob_github returns matching blob paths", async () => {
    const { pi, tools } = fakePi();
    stubApi(pi, () => ({
      tree: [
        { type: "tree", path: "src" },
        { type: "blob", path: "src/a.ts" },
        { type: "blob", path: "docs/b.md" },
      ],
      truncated: false,
    }));
    const tool = requireTool(tools, "glob_github");

    const result = await tool.execute(undefined, {
      repository: "acme/project",
      filePattern: "**/*.ts",
    });

    expect(expectStructuredResult(tool, result)).toEqual(["src/a.ts"]);
  });

  it("search_github groups snippets per file", async () => {
    const { pi, tools } = fakePi();
    stubApi(pi, () => ({
      items: [
        {
          path: "src/a.ts",
          text_matches: [{ property: "content", fragment: "  foo();  " }],
        },
      ],
      total_count: 1,
    }));
    const tool = requireTool(tools, "search_github");

    const result = await tool.execute(undefined, {
      repository: "acme/project",
      pattern: "foo",
    });

    expect(expectStructuredResult(tool, result)).toEqual({
      results: [{ file: "src/a.ts", chunks: ["foo();"] }],
      totalCount: 1,
    });
  });

  it("commit_search returns mapped commits", async () => {
    const { pi, tools } = fakePi();
    stubApi(pi, () => ({
      items: [
        {
          sha: "abc123",
          commit: {
            message: "fix bug",
            author: {
              name: "Ada",
              email: "ada@example.test",
              date: "2026-01-02T03:04:05Z",
            },
          },
        },
      ],
      total_count: 1,
    }));
    const tool = requireTool(tools, "commit_search");

    const result = await tool.execute(undefined, {
      repository: "acme/project",
      query: "fix",
    });

    expect(expectStructuredResult(tool, result)).toEqual({
      commits: [
        {
          sha: "abc123",
          message: "fix bug",
          author: {
            name: "Ada",
            email: "ada@example.test",
            date: "2026-01-02T03:04:05Z",
          },
        },
      ],
      totalCount: 1,
    });
  });

  it("diff returns file stats without patches unless asked", async () => {
    const { pi, tools } = fakePi();
    stubApi(pi, () => ({
      files: [
        {
          filename: "src/a.ts",
          status: "modified",
          additions: 1,
          deletions: 2,
          changes: 3,
          sha: "s1",
          blob_url: "https://example.test/blob",
        },
      ],
      base_commit: { sha: "b1", commit: { message: "base\n" } },
      commits: [{ sha: "h1", commit: { message: "head" } }],
      ahead_by: 1,
      behind_by: 0,
      total_commits: 1,
    }));
    const tool = requireTool(tools, "diff");

    const result = await tool.execute(undefined, {
      repository: "acme/project",
      base: "main",
      head: "dev",
    });

    expect(expectStructuredResult(tool, result)).toEqual({
      files: [
        {
          filename: "src/a.ts",
          status: "modified",
          additions: 1,
          deletions: 2,
          changes: 3,
          patch: undefined,
          previous_filename: undefined,
          sha: "s1",
          blob_url: "https://example.test/blob",
        },
      ],
      base_commit: { sha: "b1", message: "base" },
      head_commit: { sha: "h1", message: "head" },
      ahead_by: 1,
      behind_by: 0,
      total_commits: 1,
    });
  });

  it("list_github_repositories returns trimmed repository rows", async () => {
    const { pi, tools } = fakePi();
    stubApi(pi, () => [
      {
        full_name: "acme/toolkit",
        description: null,
        language: "TypeScript",
        stargazers_count: 7,
        forks_count: 1,
        private: false,
      },
    ]);
    const tool = requireTool(tools, "list_github_repositories");

    const result = await tool.execute(undefined, {
      organization: "acme",
      limit: 1,
    });

    expect(expectStructuredResult(tool, result)).toEqual({
      repositories: [
        {
          name: "acme/toolkit",
          description: null,
          language: "TypeScript",
          stargazersCount: 7,
          forksCount: 1,
          private: false,
        },
      ],
      totalCount: 1,
    });
  });
});

describe("gitlab tool structured output", () => {
  it("read_gitlab returns numbered file content", async () => {
    const { pi, tools } = fakePi();
    stubApi(pi, () => ({ raw: "# hi\n" }));
    const tool = requireTool(tools, "read_gitlab");

    const result = await tool.execute(undefined, {
      project: "acme/project",
      path: "README.md",
    });

    expect(expectStructuredResult(tool, result)).toEqual({
      absolutePath: "README.md",
      content: "1: # hi\n2: ",
    });
  });

  it("list_directory_gitlab marks subtrees as directories", async () => {
    const { pi, tools } = fakePi();
    stubApi(pi, () => [
      { name: "a.ts", type: "blob" },
      { name: "src", type: "tree" },
    ]);
    const tool = requireTool(tools, "list_directory_gitlab");

    const result = await tool.execute(undefined, {
      project: "acme/project",
      path: "",
    });

    expect(expectStructuredResult(tool, result)).toEqual(["src/", "a.ts"]);
  });

  it("glob_gitlab returns matching blob paths", async () => {
    const { pi, tools } = fakePi();
    stubApi(pi, () => [
      { type: "tree", path: "src" },
      { type: "blob", path: "src/a.ts" },
    ]);
    const tool = requireTool(tools, "glob_gitlab");

    const result = await tool.execute(undefined, {
      project: "acme/project",
      filePattern: "**/*.ts",
    });

    expect(expectStructuredResult(tool, result)).toEqual(["src/a.ts"]);
  });

  it("search_gitlab groups snippets per file", async () => {
    const { pi, tools } = fakePi();
    stubApi(pi, () => [
      { filename: "src/a.ts", data: "foo();" },
      { path: "src/b.ts", data: "bar();" },
    ]);
    const tool = requireTool(tools, "search_gitlab");

    const result = await tool.execute(undefined, {
      project: "acme/project",
      pattern: "foo",
    });

    expect(expectStructuredResult(tool, result)).toEqual({
      results: [
        { file: "src/a.ts", chunks: ["foo();"] },
        { file: "src/b.ts", chunks: ["bar();"] },
      ],
      totalCount: 2,
    });
  });

  it("commit_search_gitlab returns mapped commits", async () => {
    const { pi, tools } = fakePi();
    stubApi(pi, () => [
      {
        id: "abc123",
        message: "fix bug",
        author_name: "Ada",
        author_email: "ada@example.test",
        authored_date: "2026-01-02T03:04:05Z",
      },
    ]);
    const tool = requireTool(tools, "commit_search_gitlab");

    const result = await tool.execute(undefined, {
      project: "acme/project",
    });

    expect(expectStructuredResult(tool, result)).toEqual({
      commits: [
        {
          sha: "abc123",
          message: "fix bug",
          author: {
            name: "Ada",
            email: "ada@example.test",
            date: "2026-01-02T03:04:05Z",
          },
        },
      ],
      totalCount: 1,
    });
  });

  it("diff_gitlab reports status and truncation flags", async () => {
    const { pi, tools } = fakePi();
    stubApi(pi, () => ({
      diffs: [
        {
          new_path: "src/a.ts",
          old_path: "src/a.ts",
          diff: "@@ -1 +1 @@",
          renamed_file: false,
        },
      ],
      commits: [{ id: "1" }, { id: "2" }],
      compare_timeout: false,
      compare_same_ref: false,
    }));
    const tool = requireTool(tools, "diff_gitlab");

    const result = await tool.execute(undefined, {
      project: "acme/project",
      base: "main",
      head: "dev",
      includePatches: true,
    });

    expect(expectStructuredResult(tool, result)).toEqual({
      files: [
        {
          filename: "src/a.ts",
          status: "modified",
          patch: "@@ -1 +1 @@",
          previous_filename: undefined,
        },
      ],
      commits: 2,
      compare_timeout: false,
      compare_same_ref: false,
    });
  });

  it("list_gitlab_projects returns trimmed project rows", async () => {
    const { pi, tools } = fakePi();
    stubApi(pi, () => [
      {
        path_with_namespace: "acme/toolkit",
        description: null,
        web_url: "https://gitlab.example.test/acme/toolkit",
        star_count: 3,
        forks_count: 1,
        visibility: "private",
      },
    ]);
    const tool = requireTool(tools, "list_gitlab_projects");

    const result = await tool.execute(undefined, {
      group: "acme",
      limit: 1,
    });

    expect(expectStructuredResult(tool, result)).toEqual({
      projects: [
        {
          name: "acme/toolkit",
          description: null,
          webUrl: "https://gitlab.example.test/acme/toolkit",
          starCount: 3,
          forksCount: 1,
          visibility: "private",
        },
      ],
      totalCount: 1,
    });
  });
});

describe("librarian subagent result", () => {
  it("carries the answer into the payload, not only into the text", () => {
    const result = librarianSubagentResult("# Answer\n\nBody", ["read_github"]);

    expect(result.content).toEqual([
      { type: "text", text: "# Answer\n\nBody" },
    ]);
    expect(result.details).toBe(result.structuredContent);
    expect(
      Value.Check(librarianSubagentOutputSchema, result.structuredContent),
    ).toBe(true);
    expect(result.structuredContent).toEqual({
      text: "# Answer\n\nBody",
      subagentTools: ["read_github"],
    });
  });

  it("copies the tool list so later mutation cannot change the result", () => {
    const subagentTools = ["read_gitlab", "diff_gitlab"];
    const result = librarianSubagentResult("ok", subagentTools);

    subagentTools.push("glob_gitlab");

    expect(result.structuredContent).toEqual({
      text: "ok",
      subagentTools: ["read_gitlab", "diff_gitlab"],
    });
  });
});
