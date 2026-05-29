import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock child_process.execFile so findCsBinary and executeSearch don't run real commands
vi.mock("node:child_process", () => {
  const execFile = vi.fn();
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

import extension from "./index.js";

type ExecFileCallback = (
  error: Error | null,
  stdout?: string,
  stderr?: string,
) => void;

type SessionStartHandler = (...args: unknown[]) => unknown;

type ToolExecute = (...args: unknown[]) => Promise<unknown>;

type RegisteredTool = Record<string, unknown> & {
  execute?: ToolExecute;
};

type RegisteredExtension = {
  handlers: Map<string, SessionStartHandler>;
  tools: RegisteredTool[];
};

function expectPrimaryBinaryDetectionCall(): void {
  expect(vi.mocked(execFile)).toHaveBeenNthCalledWith(
    1,
    "which",
    ["cs"],
    undefined,
    expect.any(Function),
  );
}

function expectFallbackBinaryDetectionCall(): void {
  expectPrimaryBinaryDetectionCall();
  expect(vi.mocked(execFile)).toHaveBeenNthCalledWith(
    2,
    "sh",
    ["-lc", "command -v cs"],
    undefined,
    expect.any(Function),
  );
}

function mockExecFileResult(
  implementation: (
    cmd: string,
    args: string[],
    options: unknown,
    callback: ExecFileCallback,
  ) => void,
): void {
  vi.mocked(execFile).mockImplementation(((
    cmd: string,
    args: string[],
    optionsOrCallback?: unknown,
    maybeCallback?: unknown,
  ) => {
    const callback =
      typeof optionsOrCallback === "function"
        ? (optionsOrCallback as ExecFileCallback)
        : (maybeCallback as ExecFileCallback);
    const options =
      typeof optionsOrCallback === "function" ? undefined : optionsOrCallback;

    implementation(cmd, args, options, callback);
    return {} as never;
  }) as typeof execFile);
}

function registerExtension(): RegisteredExtension {
  const handlers = new Map<string, SessionStartHandler>();
  const tools: RegisteredTool[] = [];

  extension({
    on(event: string, handler: SessionStartHandler) {
      handlers.set(event, handler);
    },
    registerTool(definition: Record<string, unknown>) {
      tools.push(definition);
    },
  } as unknown as ExtensionAPI);

  return { handlers, tools };
}

async function registerAndGetTool(): Promise<RegisteredTool> {
  const { handlers, tools } = registerExtension();
  await handlers.get("session_start")?.({ reason: "startup" });
  return tools[0];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("cs-search extension", () => {
  it("does not register cs_search when the cs binary is unavailable", async () => {
    mockExecFileResult((_cmd, _args, _options, callback) => {
      callback(new Error("not found"));
    });

    const { handlers, tools } = registerExtension();
    await handlers.get("session_start")?.({ reason: "startup" });

    expect(tools).toHaveLength(0);
    expectFallbackBinaryDetectionCall();
  });

  it("registers a session_start hook and exposes a cs_search tool when cs binary is found", async () => {
    mockExecFileResult((_cmd, _args, _options, callback) => {
      callback(null, "/usr/local/bin/cs\n", "");
    });

    const tool = await registerAndGetTool();

    expect(tool).toBeDefined();
    expectPrimaryBinaryDetectionCall();
    expect(tool.name).toBe("cs_search");
    expect(tool.description).toContain("ranked structural code search");
    expect(tool.promptGuidelines).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "Use cs_search when you need the most likely implementation",
        ),
        expect.stringContaining(
          "Start with query first; add language when helpful, and use path only after you have confirmed",
        ),
        expect.stringContaining("the first cs_search should usually omit path"),
        expect.stringContaining(
          "Recommended flow: call cs_search first, then read the top result",
        ),
        expect.stringContaining(
          "Use rg instead when you need exact text, regex matches",
        ),
      ]),
    );
  });

  it("executes cs as a JSON CLI search and returns ranked structured results for Pi", async () => {
    const searchResults = JSON.stringify([
      {
        filename: "index.ts",
        location: "src/index.ts",
        line_number: 12,
        score: 4.2,
        snippet: "export function authenticate() {}",
      },
      {
        filename: "auth.ts",
        location: "src/auth.ts",
        line_number: 28,
        score: 3.9,
        snippet: "export const authMiddleware = () => {}",
      },
    ]);

    mockExecFileResult((cmd, _args, _options, callback) => {
      if (cmd === "which") {
        callback(null, "/usr/local/bin/cs\n", "");
        return;
      }
      callback(null, searchResults, "");
    });

    const tool = await registerAndGetTool();
    const ctx = { cwd: "/repo", signal: undefined } as never;
    const result = await tool.execute?.(
      "call-1",
      {
        query: "authenticate",
        kind: "implementation",
        path: "src",
        language: "ts",
        max_results: 2,
      },
      undefined,
      undefined,
      ctx,
    );

    expect(result).toBeDefined();

    expect(vi.mocked(execFile)).toHaveBeenNthCalledWith(
      3,
      "/usr/local/bin/cs",
      [
        "authenticate path:src ext:ts",
        "--only-code",
        "--gravity=brain",
        "--format",
        "json",
      ],
      expect.objectContaining({ cwd: "/repo" }),
      expect.any(Function),
    );
    expect(result.content[0].text).toContain(
      "Top 2 ranked results for: authenticate",
    );
    expect(result.content[0].text).toContain("1. src/index.ts:12 [score: 4.2]");
    expect(result.content[0].text).toContain(
      "export function authenticate() {}",
    );
    expect(result.details).toEqual(
      expect.objectContaining({
        available: true,
        query: "authenticate",
        effective_query: "authenticate path:src ext:ts",
        fallback_applied: false,
        initial_effective_query: "authenticate path:src ext:ts",
        initial_total_results: 2,
        fallback_effective_query: null,
        fallback_total_results: null,
        applied_flags: ["--only-code", "--gravity=brain"],
        kind: "implementation",
        path: "src",
        language: "ts",
        max_results: 2,
        total_results: 2,
        results: [
          expect.objectContaining({
            path: "src/index.ts",
            line: 12,
            score: 4.2,
          }),
          expect.objectContaining({
            path: "src/auth.ts",
            line: 28,
            score: 3.9,
          }),
        ],
      }),
    );
  });

  it("exposes bounded line details from cs CLI JSON output", async () => {
    const searchResults = JSON.stringify([
      {
        filename: "index.ts",
        location: "src/index.ts",
        content: "export function authenticate() {}",
        lines: [
          {
            line_number: 12,
            content: "export function authenticate() {}",
          },
          {
            line_number: 13,
            content: "  return true;",
          },
          {
            line_number: 14,
            content: "}",
          },
          {
            line_number: 15,
            content: "const ignored = true;",
          },
        ],
        score: 4.2,
      },
      {
        filename: "auth.ts",
        location: "src/auth.ts",
        lines: [
          {
            line_number: 28,
            content: "export const authMiddleware = () => {}",
          },
        ],
        score: 3.9,
      },
    ]);

    mockExecFileResult((cmd, _args, _options, callback) => {
      if (cmd === "which") {
        callback(null, "/usr/local/bin/cs\n", "");
        return;
      }
      callback(null, searchResults, "");
    });

    const tool = await registerAndGetTool();
    const ctx = { cwd: "/repo", signal: undefined } as never;
    const result = await tool.execute?.(
      "call-1b",
      {
        query: "authenticate",
        path: "src",
        language: "ts",
        max_results: 2,
      },
      undefined,
      undefined,
      ctx,
    );

    expect(result).toBeDefined();
    expect(result.content[0].text).toContain(
      "export function authenticate() {}",
    );
    expect(result.content[0].text).toContain(
      "12: export function authenticate() {}",
    );
    expect(result.content[0].text).toContain("13: return true;");
    expect(result.content[0].text).toContain("14: }");
    expect(result.content[0].text).toContain("15: const ignored = true;");
    expect(result.content[0].text).toContain("src/auth.ts:28 [score: 3.9]");
    expect(result.details).toEqual(
      expect.objectContaining({
        results: [
          expect.objectContaining({
            path: "src/index.ts",
            line: 12,
            snippet: "export function authenticate() {}",
            lines: [
              { line: 12, content: "export function authenticate() {}" },
              { line: 13, content: "return true;" },
              { line: 14, content: "}" },
              { line: 15, content: "const ignored = true;" },
            ],
          }),
          expect.objectContaining({
            path: "src/auth.ts",
            line: 28,
            snippet: "export const authMiddleware = () => {}",
            lines: [
              { line: 28, content: "export const authMiddleware = () => {}" },
            ],
          }),
        ],
      }),
    );
  });

  it("passes path and language filters through the cs query", async () => {
    const searchResults = JSON.stringify([
      {
        location: "src/auth.ts",
        line_number: 28,
        score: 3.9,
        snippet: "export const authMiddleware = () => {}",
      },
    ]);

    mockExecFileResult((cmd, _args, _options, callback) => {
      if (cmd === "which") {
        callback(null, "/usr/local/bin/cs\n", "");
        return;
      }
      callback(null, searchResults, "");
    });

    const tool = await registerAndGetTool();
    const ctx = { cwd: "/repo", signal: undefined } as never;
    const result = await tool.execute?.(
      "call-2",
      { query: "auth", path: "src", language: "ts", max_results: 3 },
      undefined,
      undefined,
      ctx,
    );

    expect(result).toBeDefined();

    expect(result.content[0].text).toContain("Top 1 ranked result for: auth");
    expect(result.content[0].text).toContain("src/auth.ts:28");
    expect(result.details).toEqual(
      expect.objectContaining({
        effective_query: "auth path:src ext:ts",
        total_results: 1,
        results: [
          expect.objectContaining({
            path: "src/auth.ts",
          }),
        ],
      }),
    );
  });

  it("preserves absolute result paths returned by cs", async () => {
    const searchResults = JSON.stringify([
      {
        location: "/repo/extensions/cs-search/index.ts",
        line_number: 251,
        score: 3.9,
        snippet:
          "export default function csSearchExtension(pi: ExtensionAPI) {",
      },
    ]);

    mockExecFileResult((cmd, _args, _options, callback) => {
      if (cmd === "which") {
        callback(null, "/usr/local/bin/cs\n", "");
        return;
      }
      callback(null, searchResults, "");
    });

    const tool = await registerAndGetTool();
    const ctx = { cwd: "/repo", signal: undefined } as never;
    const result = await tool.execute?.(
      "call-2b",
      {
        query: "cs_search extension",
        path: "extensions",
        language: "ts",
        max_results: 3,
      },
      undefined,
      undefined,
      ctx,
    );

    expect(result).toBeDefined();
    expect(result.content[0].text).toContain(
      "/repo/extensions/cs-search/index.ts:251",
    );
    expect(result.details).toEqual(
      expect.objectContaining({
        effective_query: "cs_search extension path:extensions ext:ts",
        total_results: 1,
        results: [
          expect.objectContaining({
            path: "/repo/extensions/cs-search/index.ts",
            line: 251,
          }),
        ],
      }),
    );
  });

  it("uses kind as CLI flags instead of appending explain_query terms", async () => {
    mockExecFileResult((cmd, _args, _options, callback) => {
      if (cmd === "which") {
        callback(null, "/usr/local/bin/cs\n", "");
        return;
      }
      callback(null, JSON.stringify([]), "");
    });

    const tool = await registerAndGetTool();
    const ctx = { cwd: "/repo", signal: undefined } as never;
    await tool.execute?.(
      "call-3",
      {
        query: "cs_search",
        kind: "declaration",
        explain_query:
          "Find the main implementation entrypoints for the cs_search tool in this repo",
      },
      undefined,
      undefined,
      ctx,
    );

    expect(vi.mocked(execFile)).toHaveBeenNthCalledWith(
      3,
      "/usr/local/bin/cs",
      ["cs_search", "--only-declarations", "--format", "json"],
      expect.objectContaining({ cwd: "/repo" }),
      expect.any(Function),
    );
  });

  it("treats a null cs JSON payload as no results instead of crashing", async () => {
    mockExecFileResult((cmd, _args, _options, callback) => {
      if (cmd === "which") {
        callback(null, "/usr/local/bin/cs\n", "");
        return;
      }
      callback(null, "null", "");
    });

    const tool = await registerAndGetTool();
    const ctx = { cwd: "/repo", signal: undefined } as never;
    const result = await tool.execute?.(
      "call-4",
      { query: "missing" },
      undefined,
      undefined,
      ctx,
    );

    expect(result.content[0].text).toContain("No ranked results found.");
    expect(result.details).toEqual(
      expect.objectContaining({
        effective_query: "missing",
        fallback_applied: false,
        initial_effective_query: "missing",
        initial_total_results: 0,
        fallback_effective_query: null,
        fallback_total_results: null,
        total_results: 0,
        results: [],
      }),
    );
  });

  it("retries once without path when a path-constrained search returns no results", async () => {
    mockExecFileResult((cmd, args, _options, callback) => {
      if (cmd === "which") {
        callback(null, "/usr/local/bin/cs\n", "");
        return;
      }
      if (args[0] === "skill-toggle path:.pi/extensions") {
        callback(null, JSON.stringify([]), "");
        return;
      }
      if (args[0] === "skill-toggle") {
        callback(
          null,
          JSON.stringify([
            {
              location: "extensions/skill-toggle/index.ts",
              line_number: 305,
              score: 4.7,
              snippet: "export function loadSkills(_cwd: string): Skill[] {",
            },
          ]),
          "",
        );
        return;
      }

      callback(new Error(`unexpected command: ${cmd} ${args.join(" ")}`));
    });

    const tool = await registerAndGetTool();
    const ctx = { cwd: "/repo", signal: undefined } as never;
    const result = await tool.execute?.(
      "call-5",
      { query: "skill-toggle", path: ".pi/extensions" },
      undefined,
      undefined,
      ctx,
    );

    expect(vi.mocked(execFile)).toHaveBeenNthCalledWith(
      3,
      "/usr/local/bin/cs",
      ["skill-toggle path:.pi/extensions", "--format", "json"],
      expect.objectContaining({ cwd: "/repo" }),
      expect.any(Function),
    );
    expect(vi.mocked(execFile)).toHaveBeenNthCalledWith(
      4,
      "/usr/local/bin/cs",
      ["skill-toggle", "--format", "json"],
      expect.objectContaining({ cwd: "/repo" }),
      expect.any(Function),
    );
    expect(result.content[0].text).toContain(
      "extensions/skill-toggle/index.ts:305",
    );
    expect(result.details).toEqual(
      expect.objectContaining({
        effective_query: "skill-toggle",
        path: ".pi/extensions",
        fallback_applied: true,
        initial_effective_query: "skill-toggle path:.pi/extensions",
        initial_total_results: 0,
        fallback_effective_query: "skill-toggle",
        fallback_total_results: 1,
        total_results: 1,
        results: [
          expect.objectContaining({
            path: "extensions/skill-toggle/index.ts",
            line: 305,
          }),
        ],
      }),
    );
  });

  it("falls back to shell command detection when which is unavailable", async () => {
    mockExecFileResult((cmd, _args, _options, callback) => {
      if (cmd === "which") {
        callback(new Error("which unavailable"));
        return;
      }
      if (cmd === "sh") {
        callback(null, "/opt/homebrew/bin/cs\n", "");
        return;
      }
      callback(new Error(`unexpected command: ${cmd}`));
    });

    const tool = await registerAndGetTool();

    expect(tool).toBeDefined();
    expectFallbackBinaryDetectionCall();
  });
});
