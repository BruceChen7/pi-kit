import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import extension from "./index.js";

type RegisteredTool = Record<string, unknown>;

type SessionStartContext = {
  cwd: string;
  signal: undefined;
  ui: { notify: ReturnType<typeof vi.fn> };
  modelRegistry: Record<string, never>;
  shell: {
    which: ReturnType<typeof vi.fn>;
    execFile?: ReturnType<typeof vi.fn>;
  };
};

type RegisteredExtension = {
  handlers: Map<string, Function>;
  tools: RegisteredTool[];
};

type SessionShell = SessionStartContext["shell"];

function registerExtension(): RegisteredExtension {
  const handlers = new Map<string, Function>();
  const tools: RegisteredTool[] = [];

  extension({
    on(event: string, handler: Function) {
      handlers.set(event, handler);
    },
    registerTool(definition: Record<string, unknown>) {
      tools.push(definition);
    },
  } as unknown as ExtensionAPI);

  return { handlers, tools };
}

function createSessionStartContext(
  shell: SessionStartContext["shell"],
  cwd = process.cwd(),
): SessionStartContext {
  return {
    cwd,
    signal: undefined,
    ui: { notify: vi.fn() },
    modelRegistry: {},
    shell,
  };
}

async function registerToolForShell(
  shell: SessionShell,
  cwd = process.cwd(),
): Promise<{ tool: RegisteredTool; ctx: SessionStartContext }> {
  const { handlers, tools } = registerExtension();
  const ctx = createSessionStartContext(shell, cwd);

  await handlers.get("session_start")?.({ reason: "startup" }, ctx);

  return { tool: tools[0], ctx };
}

describe("cs-search extension", () => {
  it("does not register cs_search when the cs binary is unavailable", async () => {
    const whichCs = vi.fn().mockResolvedValue(null);
    const { handlers, tools } = registerExtension();

    await handlers.get("session_start")?.(
      { reason: "startup" },
      createSessionStartContext({ which: whichCs }),
    );

    expect(whichCs).toHaveBeenCalledWith("cs");
    expect(tools).toHaveLength(0);
  });

  it("registers a session_start hook and exposes a cs_search tool focused on ranked structural search", async () => {
    const whichCs = vi.fn().mockResolvedValue("/usr/local/bin/cs");
    const { handlers, tools } = registerExtension();

    expect([...handlers.keys()]).toEqual(["session_start"]);

    await handlers.get("session_start")?.(
      { reason: "startup" },
      createSessionStartContext({ which: whichCs }),
    );

    expect(whichCs).toHaveBeenCalledWith("cs");
    expect(tools).toHaveLength(1);

    const tool = tools[0];
    expect(tool.name).toBe("cs_search");
    expect(tool.description).toContain("ranked structural code search");
    expect(tool.promptGuidelines).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "Use cs_search when you need the most likely implementation",
        ),
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
    const whichCs = vi.fn().mockResolvedValue("/usr/local/bin/cs");
    const execFile = vi.fn().mockResolvedValue({
      stdout: JSON.stringify([
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
      ]),
      stderr: "",
    });
    const { tool, ctx } = await registerToolForShell(
      { which: whichCs, execFile },
      "/repo",
    );
    const result = await (tool.execute as Function)(
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

    expect(execFile).toHaveBeenCalledWith(
      "/usr/local/bin/cs",
      [
        "authenticate implementation concrete logic behavior",
        "--format",
        "json",
      ],
      expect.objectContaining({ cwd: "/repo" }),
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

  it("filters ranked results by path and language before returning top candidates", async () => {
    const whichCs = vi.fn().mockResolvedValue("/usr/local/bin/cs");
    const execFile = vi.fn().mockResolvedValue({
      stdout: JSON.stringify([
        {
          location: "docs/auth.md",
          line_number: 5,
          score: 5.0,
          snippet: "Authentication overview",
        },
        {
          location: "src/auth.ts",
          line_number: 28,
          score: 3.9,
          snippet: "export const authMiddleware = () => {}",
        },
      ]),
      stderr: "",
    });
    const { tool, ctx } = await registerToolForShell(
      { which: whichCs, execFile },
      "/repo",
    );
    const result = await (tool.execute as Function)(
      "call-2",
      { query: "auth", path: "src", language: "ts", max_results: 3 },
      undefined,
      undefined,
      ctx,
    );

    expect(result.content[0].text).toContain("Top 1 ranked result for: auth");
    expect(result.content[0].text).toContain("src/auth.ts:28");
    expect(result.content[0].text).not.toContain("docs/auth.md");
    expect(result.details).toEqual(
      expect.objectContaining({
        total_results: 1,
        results: [
          expect.objectContaining({
            path: "src/auth.ts",
          }),
        ],
      }),
    );
  });
});
