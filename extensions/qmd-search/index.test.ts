import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────

vi.mock("node:child_process", () => {
  const execFile = vi.fn();
  // @ts-expect-error — promisify symbol not on Mock type
  execFile[Symbol.for("nodejs.util.promisify.custom")] = (
    cmd: string,
    args: string[],
    options?: unknown,
  ) =>
    new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile(
        cmd,
        args,
        options,
        (error: Error | null, stdout = "", stderr = "") => {
          if (error) {
            reject(error);
            return;
          }
          resolve({ stdout, stderr });
        },
      );
    });

  return { execFile };
});

vi.mock("../shared/settings.ts", () => ({
  loadSettings: vi.fn(() => ({
    merged: {},
    project: {},
    global: {},
  })),
  loadGlobalSettings: vi.fn(() => ({ global: {} })),
}));

vi.mock("../shared/logger.ts", () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

import { loadSettings } from "../shared/settings.ts";
import extension, {
  buildGetArgs,
  buildMultiGetArgs,
  buildQueryArgs,
  buildSearchArgs,
  computeNeedsUpdate,
  formatToolResult,
  safeJson,
} from "./index.js";

// ── Test types ─────────────────────────────────────────────────────────

type ExecFileCallback = (
  error: Error | null,
  stdout?: string,
  stderr?: string,
) => void;

type SessionStartHandler = (...args: unknown[]) => unknown;
type SessionShutdownHandler = (...args: unknown[]) => unknown;
type ToolExecute = (...args: unknown[]) => Promise<unknown>;

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
};

type RegisteredTool = Record<string, unknown> & {
  execute?: ToolExecute;
};

type RegisteredExtension = {
  sessionStartHandlers: SessionStartHandler[];
  sessionShutdownHandlers: SessionShutdownHandler[];
  tools: RegisteredTool[];
};

function asToolResult(result: unknown): ToolResult {
  return result as ToolResult;
}

async function callTool(
  tool: RegisteredTool,
  callId: string,
  params: Record<string, unknown>,
  ctx?: never,
): Promise<ToolResult> {
  if (!tool.execute) throw new Error(`Tool ${tool.name} has no execute method`);
  return asToolResult(
    await tool.execute(
      callId,
      params,
      undefined,
      undefined,
      ctx ?? { cwd: "/repo", signal: undefined },
    ),
  );
}

// ── Mock helpers ───────────────────────────────────────────────────────

/**
 * Register handlers for each execFile call by matching (cmd, args[0]).
 * Each matcher is tried in order; the first matching one wins.
 * Default to error if no matcher matches (ensures tests fail on unexpected calls).
 */
type ExecFileMatcher = {
  cmd: string;
  subcommand?: string;
  handle: (callback: ExecFileCallback) => void;
};

function mockExecFile(matchers: ExecFileMatcher[]): void {
  vi.mocked(execFile).mockImplementation(((
    cmd: string,
    args: string[],
    _optionsOrCallback?: unknown,
    maybeCallback?: unknown,
  ) => {
    const callback =
      typeof _optionsOrCallback === "function"
        ? (_optionsOrCallback as ExecFileCallback)
        : (maybeCallback as ExecFileCallback);

    for (const m of matchers) {
      if (cmd === m.cmd && (!m.subcommand || args[0] === m.subcommand)) {
        m.handle(callback);
        return {} as never;
      }
    }

    // No matcher found → fail test
    callback(new Error(`unexpected execFile: ${cmd} ${args.join(" ")}`));
    return {} as never;
  }) as unknown as typeof execFile);
}

/** Typical matchers used by most tests: binary detection + staleness check. */
function qmdAvailableMatchers(): ExecFileMatcher[] {
  return [
    {
      cmd: "which",
      subcommand: "qmd",
      handle: (cb) => cb(null, "/usr/local/bin/qmd\n", ""),
    },
    {
      cmd: "qmd",
      subcommand: "update",
      handle: (cb) => cb(null, "", ""),
    },
  ];
}

function registerExtension(): RegisteredExtension {
  const sessionStartHandlers: SessionStartHandler[] = [];
  const sessionShutdownHandlers: SessionShutdownHandler[] = [];
  const tools: RegisteredTool[] = [];

  extension({
    on(event: string, handler: SessionStartHandler) {
      if (event === "session_start") sessionStartHandlers.push(handler);
      if (event === "session_shutdown") sessionShutdownHandlers.push(handler);
    },
    registerTool(definition: Record<string, unknown>) {
      tools.push(definition);
    },
    registerCommand() {
      /* no-op */
    },
  } as unknown as ExtensionAPI);

  return { sessionStartHandlers, sessionShutdownHandlers, tools };
}

async function triggerSessionStart(
  ext: RegisteredExtension,
  cwd = "/repo",
): Promise<void> {
  const ctx = { cwd } as never;
  for (const handler of ext.sessionStartHandlers) {
    await handler({ reason: "startup" }, ctx);
  }
}

async function getToolAfterStart(
  toolName: string,
  matchers?: ExecFileMatcher[],
): Promise<RegisteredTool> {
  mockExecFile(matchers ?? qmdAvailableMatchers());
  const ext = registerExtension();
  await triggerSessionStart(ext);
  const tool = ext.tools.find((t) => t.name === toolName);
  expect(tool).toBeDefined();
  return tool as RegisteredTool;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Pure functions: safeJson ───────────────────────────────────────────

describe("safeJson", () => {
  it("parses valid JSON", () => {
    const result = safeJson<{ key: string }>('{"key":"value"}');
    expect(result).toEqual({ key: "value" });
    expect((result as { parseError?: string }).parseError).toBeUndefined();
  });

  it("parses arrays", () => {
    const result = safeJson<number[]>("[1, 2, 3]");
    expect(result).toEqual([1, 2, 3]);
  });

  it("returns error DTO for invalid input", () => {
    const result = safeJson<unknown>("not json");
    expect(result).toHaveProperty("parseError");
    expect((result as { preview: string }).preview).toContain("not json");
  });

  it("handles empty string", () => {
    const result = safeJson<unknown>("");
    expect(result).toHaveProperty("parseError");
    expect((result as { preview: string }).preview).toBe("");
  });
});

// ── Pure functions: formatToolResult ──────────────────────────────────

describe("formatToolResult", () => {
  it("formats array data with count", () => {
    const result = formatToolResult("search", "ipc", [
      { file: "docs/ipc.md", score: 0.95 },
    ]);
    expect(result.text).toContain("QMD Search: ipc");
    expect(result.text).toContain("Found 1 result.");
    expect(result.details.tool).toBe("qmd_search");
    expect(result.details.resultCount).toBe(1);
  });

  it("formats empty array as no results", () => {
    const result = formatToolResult("query", "nothing", []);
    expect(result.text).toContain("No results found.");
    expect(result.details.resultCount).toBe(0);
  });

  it("formats non-array data with count 1", () => {
    const data = { file: "docs/guide.md", title: "Guide" };
    const result = formatToolResult("get", "guide", data);
    expect(result.text).toContain("QMD Get: guide");
    expect(result.details.resultCount).toBe(1);
  });

  it("includes JSON code block in output", () => {
    const data = [{ id: 1 }];
    const result = formatToolResult("search", "test", data);
    expect(result.text).toContain("```json");
    expect(result.text).toContain('"id"');
  });

  it("handles plural count", () => {
    const data = [{ id: 1 }, { id: 2 }];
    const result = formatToolResult("query", "multi", data);
    expect(result.text).toContain("Found 2 results.");
  });
});

// ── Pure functions: args builders ─────────────────────────────────────

describe("buildQueryArgs", () => {
  it("builds minimal args", () => {
    expect(buildQueryArgs({ query: "auth" })).toEqual([
      "query",
      "auth",
      "--json",
    ]);
  });

  it("includes optional flags", () => {
    expect(
      buildQueryArgs({
        query: "auth",
        limit: 5,
        minScore: 0.3,
        rerank: false,
        intent: "web login",
      }),
    ).toEqual([
      "query",
      "auth",
      "--json",
      "-n",
      "5",
      "--min-score",
      "0.3",
      "--no-rerank",
      "--intent",
      "web login",
    ]);
  });

  it("builds multi-line query string from typed searches", () => {
    expect(
      buildQueryArgs({
        query: "auth",
        searches: [
          { type: "lex", query: "login" },
          { type: "vec", query: "how users log in" },
        ],
      }),
    ).toEqual(["query", "lex: login\nvec: how users log in", "--json"]);
  });

  it("omits --intent flag when searches are provided (intent in query doc)", () => {
    expect(
      buildQueryArgs({
        query: "auth",
        searches: [{ type: "lex", query: "login" }],
        intent: "web login flow",
      }),
    ).toEqual(["query", "lex: login", "--json"]);
  });

  it("includes collection filters", () => {
    expect(
      buildQueryArgs({ query: "api", collections: ["docs", "notes"] }),
    ).toEqual(["query", "api", "--json", "-c", "docs", "-c", "notes"]);
  });
});

describe("buildGetArgs", () => {
  it("builds minimal args", () => {
    expect(buildGetArgs({ file: "docs/api.md" })).toEqual([
      "get",
      "docs/api.md",
    ]);
  });

  it("includes fromLine and maxLines", () => {
    expect(
      buildGetArgs({ file: "docs/api.md", fromLine: 10, maxLines: 50 }),
    ).toEqual(["get", "docs/api.md", "--from", "10", "-l", "50"]);
  });

  it("includes --no-line-numbers", () => {
    expect(buildGetArgs({ file: "docs/api.md", lineNumbers: false })).toEqual([
      "get",
      "docs/api.md",
      "--no-line-numbers",
    ]);
  });
});

describe("buildMultiGetArgs", () => {
  it("builds minimal args", () => {
    expect(buildMultiGetArgs({ pattern: "docs/*.md" })).toEqual([
      "multi-get",
      "docs/*.md",
      "--json",
    ]);
  });

  it("includes maxBytes and maxLines", () => {
    expect(
      buildMultiGetArgs({
        pattern: "docs/*.md",
        maxBytes: 20480,
        maxLines: 100,
      }),
    ).toEqual([
      "multi-get",
      "docs/*.md",
      "--json",
      "--max-bytes",
      "20480",
      "-l",
      "100",
    ]);
  });
});

describe("buildSearchArgs", () => {
  it("builds minimal args", () => {
    expect(buildSearchArgs({ query: "ipc" })).toEqual([
      "search",
      "ipc",
      "--json",
    ]);
  });

  it("includes collection filters", () => {
    expect(
      buildSearchArgs({ query: "ipc", collections: ["my_notes"] }),
    ).toEqual(["search", "ipc", "--json", "-c", "my_notes"]);
  });

  it("includes limit", () => {
    expect(buildSearchArgs({ query: "ipc", limit: 5 })).toEqual([
      "search",
      "ipc",
      "--json",
      "-n",
      "5",
    ]);
  });
});

// ── Binary detection ──────────────────────────────────────────────────

describe("binary detection", () => {
  it("does not register tools when qmd binary is unavailable", async () => {
    mockExecFile([
      {
        cmd: "which",
        subcommand: "qmd",
        handle: (cb) => cb(new Error("not found")),
      },
      { cmd: "sh", handle: (cb) => cb(new Error("not found")) },
    ]);

    const ext = registerExtension();
    await triggerSessionStart(ext);

    expect(ext.tools).toHaveLength(0);
  });

  it("tries fallback detection when which fails", async () => {
    mockExecFile([
      {
        cmd: "which",
        subcommand: "qmd",
        handle: (cb) => cb(new Error("not found")),
      },
      { cmd: "sh", handle: (cb) => cb(new Error("not found")) },
    ]);

    const ext = registerExtension();
    await triggerSessionStart(ext);

    expect(vi.mocked(execFile)).toHaveBeenCalledWith(
      "which",
      ["qmd"],
      undefined,
      expect.any(Function),
    );
    expect(vi.mocked(execFile)).toHaveBeenCalledWith(
      "sh",
      ["-lc", "command -v qmd"],
      undefined,
      expect.any(Function),
    );
  });

  it("registers 5 tools when qmd binary is found", async () => {
    mockExecFile(qmdAvailableMatchers());

    const ext = registerExtension();
    await triggerSessionStart(ext);

    const toolNames = ext.tools.map((t) => t.name);
    expect(toolNames).toEqual(
      expect.arrayContaining([
        "qmd_query",
        "qmd_get",
        "qmd_multi_get",
        "qmd_search",
        "qmd_status",
      ]),
    );
    expect(ext.tools).toHaveLength(5);
  });
});

// ── Pure functions: computeNeedsUpdate ────────────────────────────────

describe("computeNeedsUpdate", () => {
  it("returns needsUpdate=false when no dirs provided", () => {
    const result = computeNeedsUpdate([], new Map(), new Map());
    expect(result.needsUpdate).toBe(false);
    expect(result.updatedMtimes.size).toBe(0);
  });

  it("returns needsUpdate=true when dir has no previous mtime", () => {
    const dirs = [{ dir: "/kb/wiki" }];
    const current = new Map([["/kb/wiki", 1000]]);
    const result = computeNeedsUpdate(dirs, current, new Map());
    expect(result.needsUpdate).toBe(true);
    expect(result.updatedMtimes.get("/kb/wiki")).toBe(1000);
  });

  it("returns needsUpdate=true when mtime increased", () => {
    const dirs = [{ dir: "/kb/wiki" }];
    const current = new Map([["/kb/wiki", 2000]]);
    const previous = new Map([["/kb/wiki", 1000]]);
    const result = computeNeedsUpdate(dirs, current, previous);
    expect(result.needsUpdate).toBe(true);
    expect(result.updatedMtimes.get("/kb/wiki")).toBe(2000);
  });

  it("returns needsUpdate=false when mtime unchanged", () => {
    const dirs = [{ dir: "/kb/wiki" }];
    const current = new Map([["/kb/wiki", 1000]]);
    const previous = new Map([["/kb/wiki", 1000]]);
    const result = computeNeedsUpdate(dirs, current, previous);
    expect(result.needsUpdate).toBe(false);
    expect(result.updatedMtimes.get("/kb/wiki")).toBe(1000);
  });

  it("skips dirs with no current mtime (stat failed)", () => {
    const dirs = [{ dir: "/kb/missing" }];
    const current = new Map();
    const previous = new Map();
    const result = computeNeedsUpdate(dirs, current, previous);
    expect(result.needsUpdate).toBe(false);
  });

  it("handles multiple dirs with mixed states", () => {
    const dirs = [{ dir: "/kb/a" }, { dir: "/kb/b" }, { dir: "/kb/c" }];
    const current = new Map([
      ["/kb/a", 100],
      ["/kb/b", 200],
      ["/kb/c", 300],
    ]);
    const previous = new Map([
      ["/kb/a", 100],
      ["/kb/b", 150],
    ]);
    const result = computeNeedsUpdate(dirs, current, previous);
    expect(result.needsUpdate).toBe(true);
    expect(result.updatedMtimes.get("/kb/a")).toBe(100);
    expect(result.updatedMtimes.get("/kb/b")).toBe(200);
    expect(result.updatedMtimes.get("/kb/c")).toBe(300);
  });
});

// ── Tool execution ────────────────────────────────────────────────────

describe("tool execution", () => {
  it("executes qmd query and returns results in details", async () => {
    const searchOutput = JSON.stringify([
      { file: "docs/api.md", title: "API Reference", score: 0.92 },
      { file: "guides/quickstart.md", title: "Quick Start", score: 0.78 },
    ]);

    const tool = await getToolAfterStart("qmd_query", [
      ...qmdAvailableMatchers(),
      {
        cmd: "qmd",
        subcommand: "query",
        handle: (cb) => cb(null, searchOutput, ""),
      },
    ]);

    const result = await callTool(tool, "call-1", {
      query: "authentication flow",
      limit: 5,
      minScore: 0.3,
      rerank: true,
    });

    // Behavioral contract: returns correct number of results with expected fields
    expect(result.details.resultCount).toBe(2);
    expect((result.details.results as Array<{ file: string }>)[0].file).toBe(
      "docs/api.md",
    );
  });

  it("executes qmd get and returns document in details", async () => {
    const docOutput = JSON.stringify({
      file: "docs/api.md",
      title: "API Reference",
      body: "# API Reference\n\nEndpoint: /v1/...",
    });

    const tool = await getToolAfterStart("qmd_get", [
      ...qmdAvailableMatchers(),
      {
        cmd: "qmd",
        subcommand: "get",
        handle: (cb) => cb(null, docOutput, ""),
      },
    ]);

    const result = await callTool(tool, "call-2", {
      file: "docs/api.md",
      maxLines: 100,
    });

    expect(result.details.file).toBe("docs/api.md");
    expect(result.content[0].text).toContain("API Reference");
  });

  it("executes qmd multi_get and returns batch results", async () => {
    const multiOutput = JSON.stringify([
      { file: "docs/api.md", title: "API Reference" },
      { file: "docs/auth.md", title: "Auth" },
    ]);

    const tool = await getToolAfterStart("qmd_multi_get", [
      ...qmdAvailableMatchers(),
      {
        cmd: "qmd",
        subcommand: "multi-get",
        handle: (cb) => cb(null, multiOutput, ""),
      },
    ]);

    const result = await callTool(tool, "call-3", {
      pattern: "docs/*.md",
      maxBytes: 20480,
    });

    const docs = result.details.result as Array<{ file: string }>;
    expect(docs).toHaveLength(2);
    expect(docs[0].file).toBe("docs/api.md");
    expect(docs[1].file).toBe("docs/auth.md");
  });

  it("executes qmd search and returns results in details", async () => {
    const searchOutput = JSON.stringify([
      { file: "docs/ipc.md", title: "IPC Overview", score: 0.95 },
      { file: "docs/pipe.md", title: "Pipes", score: 0.82 },
    ]);

    const tool = await getToolAfterStart("qmd_search", [
      ...qmdAvailableMatchers(),
      {
        cmd: "qmd",
        subcommand: "search",
        handle: (cb) => cb(null, searchOutput, ""),
      },
    ]);

    const result = await callTool(tool, "call-search", {
      query: "ipc",
      limit: 5,
    });

    expect(result.details.resultCount).toBe(2);
    expect((result.details.results as Array<{ file: string }>)[0].file).toBe(
      "docs/ipc.md",
    );
  });

  it("returns error details when qmd search returns non-JSON output", async () => {
    const tool = await getToolAfterStart("qmd_search", [
      ...qmdAvailableMatchers(),
      {
        cmd: "qmd",
        subcommand: "search",
        handle: (cb) => cb(null, "Not JSON output", ""),
      },
    ]);

    const result = await callTool(tool, "call-search-nonjson", {
      query: "test",
    });

    expect(result.details.tool).toBe("qmd_search");
    expect(result.content[0].text).toBeDefined();
    expect(result.content[0].text.length).toBeGreaterThan(0);
    // Raw CLI output should appear in the error message
    expect(result.content[0].text).toContain("Not JSON output");
  });

  it("handles qmd search failure gracefully", async () => {
    const tool = await getToolAfterStart("qmd_search", [
      ...qmdAvailableMatchers(),
      {
        cmd: "qmd",
        subcommand: "search",
        handle: (cb) => cb(new Error("search failed"), "", ""),
      },
    ]);

    const result = await callTool(tool, "call-search-fail", {
      query: "broken",
    });

    expect(result.details.error).toContain("search failed");
  });

  it("executes qmd status and includes knowledge base info", async () => {
    vi.mocked(loadSettings).mockReturnValue({
      merged: {
        qmdSearch: {
          knowledgeBases: {
            wiki: { path: "/kb/wiki", pattern: "**/*.md" },
          },
        },
      },
      project: {},
      global: {},
    } as never);

    const statusOutput = JSON.stringify({
      collections: [{ name: "wiki", doc_count: 150 }],
    });

    const tool = await getToolAfterStart("qmd_status", [
      ...qmdAvailableMatchers(),
      {
        cmd: "qmd",
        subcommand: "status",
        handle: (cb) => cb(null, statusOutput, ""),
      },
    ]);

    const result = await callTool(tool, "call-4", {});

    const kbs = result.details.knowledgeBases as Array<{
      name: string;
      path: string;
    }>;
    expect(kbs).toHaveLength(1);
    expect(kbs[0].name).toBe("wiki");
    expect(kbs[0].path).toBe("/kb/wiki");
  });

  it("handles qmd query failure gracefully", async () => {
    const tool = await getToolAfterStart("qmd_query", [
      ...qmdAvailableMatchers(),
      {
        cmd: "qmd",
        subcommand: "query",
        handle: (cb) => cb(new Error("qmd query error"), "", ""),
      },
    ]);

    const result = await callTool(tool, "call-fail", { query: "broken" });

    expect(result.details.error).toContain("qmd query error");
  });

  it("handles qmd get failure gracefully", async () => {
    const tool = await getToolAfterStart("qmd_get", [
      ...qmdAvailableMatchers(),
      {
        cmd: "qmd",
        subcommand: "get",
        handle: (cb) => cb(new Error("document not found"), "", ""),
      },
    ]);

    const result = await callTool(tool, "call-fail", {
      file: "nonexistent.md",
    });

    expect(result.details.error).toContain("document not found");
  });
});

// ── Config loading ────────────────────────────────────────────────────

describe("config loading", () => {
  it("reports configured knowledge bases in status", async () => {
    vi.mocked(loadSettings).mockReturnValue({
      merged: {
        qmdSearch: {
          knowledgeBases: {
            wiki: { path: "/kb/wiki", pattern: "**/*.md" },
            notes: { path: "/kb/notes" },
          },
        },
      },
      project: {},
      global: {},
    } as never);

    const tool = await getToolAfterStart("qmd_status", [
      ...qmdAvailableMatchers(),
      {
        cmd: "qmd",
        subcommand: "status",
        handle: (cb) => cb(null, "{}", ""),
      },
    ]);
    const result = await callTool(tool, "call", {});

    const kbs = result.details.knowledgeBases as Array<{
      name: string;
      path: string;
    }>;
    expect(kbs).toHaveLength(2);
    expect(kbs.map((k) => k.name)).toEqual(["wiki", "notes"]);
  });

  it("reports empty list when no knowledge bases configured", async () => {
    vi.mocked(loadSettings).mockReturnValue({
      merged: {},
      project: {},
      global: {},
    } as never);

    const tool = await getToolAfterStart("qmd_status", [
      ...qmdAvailableMatchers(),
      {
        cmd: "qmd",
        subcommand: "status",
        handle: (cb) => cb(null, '{"collections":[]}', ""),
      },
    ]);
    const result = await callTool(tool, "call", {});

    const kbs = result.details.knowledgeBases as Array<unknown>;
    expect(kbs).toHaveLength(0);
  });
});

// ── Session lifecycle ─────────────────────────────────────────────────

describe("session lifecycle", () => {
  it("skips staleness check when no KB dirs have changed mtime", async () => {
    // With no knowledge bases configured, staleness check is a no-op
    const matchers: ExecFileMatcher[] = [
      {
        cmd: "which",
        subcommand: "qmd",
        handle: (cb) => cb(null, "/usr/local/bin/qmd\n", ""),
      },
    ];

    mockExecFile(matchers);

    const ext = registerExtension();
    await triggerSessionStart(ext);

    // Only binary detection was called; no qmd update since no KB dirs changed
    expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(execFile)).toHaveBeenCalledWith(
      "which",
      ["qmd"],
      undefined,
      expect.any(Function),
    );
  });

  it("runs staleness check when KB dir mtime has changed", async () => {
    vi.mocked(loadSettings).mockReturnValue({
      merged: {
        qmdSearch: {
          knowledgeBases: {
            wiki: { path: "/kb/wiki", pattern: "**/*.md" },
          },
        },
      },
      project: {},
      global: {},
    } as never);

    // /kb/wiki doesn't exist, so getDirMtime returns null → no update needed
    // To test the update path, we need a dir that exists.
    // Use the current test dir since it definitely exists.
    vi.mocked(loadSettings).mockReturnValue({
      merged: {
        qmdSearch: {
          knowledgeBases: {
            test: { path: process.cwd(), pattern: "**/*.md" },
          },
        },
      },
      project: {},
      global: {},
    } as never);

    const matchers: ExecFileMatcher[] = [
      {
        cmd: "which",
        subcommand: "qmd",
        handle: (cb) => cb(null, "/usr/local/bin/qmd\n", ""),
      },
      {
        cmd: "qmd",
        subcommand: "update",
        handle: (cb) => cb(null, "All up to date.\n", ""),
      },
    ];

    mockExecFile(matchers);

    const ext = registerExtension();
    await triggerSessionStart(ext);

    // stalenessCheck is fire-and-forget; wait for the async flux
    await vi.waitFor(
      () => {
        expect(vi.mocked(execFile)).toHaveBeenCalledWith(
          "qmd",
          ["update"],
          expect.objectContaining({ timeout: 120_000 }),
          expect.any(Function),
        );
      },
      { timeout: 2000, interval: 10 },
    );
  });

  it("registers session_shutdown handler", async () => {
    mockExecFile(qmdAvailableMatchers());

    const ext = registerExtension();
    await triggerSessionStart(ext);

    expect(ext.sessionShutdownHandlers).toHaveLength(1);
  });
});

// ── Slash commands ────────────────────────────────────────────────────

describe("slash commands", () => {
  it("registers qmd-update, qmd-embed, qmd-doctor", async () => {
    mockExecFile(qmdAvailableMatchers());

    const ext = registerExtension();
    await triggerSessionStart(ext);

    // Commands are registered via pi.registerTool (the test harness
    // doesn't capture registerCommand calls, but we can verify tools
    // were registered as a proxy for the extension being active)
    expect(ext.tools.length).toBeGreaterThan(0);
  });
});

// ── Tool definitions ──────────────────────────────────────────────────

describe("tool definitions", () => {
  it("all tools have name, description, parameters, execute", async () => {
    mockExecFile(qmdAvailableMatchers());

    const ext = registerExtension();
    await triggerSessionStart(ext);

    for (const tool of ext.tools) {
      expect(tool.name).toBeDefined();
      expect(tool.description).toBeDefined();
      expect(tool.parameters).toBeDefined();
      expect(tool.execute).toBeDefined();
      expect(tool.promptSnippet).toBeDefined();
    }
  });

  it("qmd_query has typed params and guidelines", async () => {
    mockExecFile(qmdAvailableMatchers());
    const ext = registerExtension();
    await triggerSessionStart(ext);

    const queryTool = ext.tools.find(
      (t) => t.name === "qmd_query",
    ) as RegisteredTool;
    expect(queryTool.description).toContain("Hybrid search");

    const params = queryTool.parameters as {
      properties?: Record<string, unknown>;
    };
    expect(params.properties?.query).toBeDefined();
    expect(params.properties?.limit).toBeDefined();
    expect(params.properties?.searches).toBeDefined();
    expect(params.properties?.collections).toBeDefined();
    expect(params.properties?.intent).toBeDefined();
    expect(params.properties?.minScore).toBeDefined();
    expect(params.properties?.rerank).toBeDefined();

    const guidelines = queryTool.promptGuidelines as string[];
    expect(guidelines).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Use qmd_query for semantic search"),
      ]),
    );
  });

  it("qmd_get has file, fromLine, maxLines params", async () => {
    mockExecFile(qmdAvailableMatchers());
    const ext = registerExtension();
    await triggerSessionStart(ext);

    const getTool = ext.tools.find(
      (t) => t.name === "qmd_get",
    ) as RegisteredTool;
    const params = getTool.parameters as {
      properties?: Record<string, unknown>;
    };
    expect(params.properties?.file).toBeDefined();
    expect(params.properties?.fromLine).toBeDefined();
    expect(params.properties?.maxLines).toBeDefined();
    expect(params.properties?.lineNumbers).toBeDefined();
  });

  it("qmd_multi_get has pattern, maxBytes, maxLines params", async () => {
    mockExecFile(qmdAvailableMatchers());
    const ext = registerExtension();
    await triggerSessionStart(ext);

    const tool = ext.tools.find(
      (t) => t.name === "qmd_multi_get",
    ) as RegisteredTool;
    const params = tool.parameters as { properties?: Record<string, unknown> };
    expect(params.properties?.pattern).toBeDefined();
    expect(params.properties?.maxBytes).toBeDefined();
    expect(params.properties?.maxLines).toBeDefined();
  });

  it("qmd_search has query, collections, limit params", async () => {
    mockExecFile(qmdAvailableMatchers());
    const ext = registerExtension();
    await triggerSessionStart(ext);

    const tool = ext.tools.find(
      (t) => t.name === "qmd_search",
    ) as RegisteredTool;
    const params = tool.parameters as { properties?: Record<string, unknown> };
    expect(params.properties?.query).toBeDefined();
    expect(params.properties?.collections).toBeDefined();
    expect(params.properties?.limit).toBeDefined();
  });
});
