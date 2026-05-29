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
          "Use cs_search when you need to find the most relevant implementation",
        ),
        expect.stringContaining(
          "Use rg instead when you need exact text or regex line matches",
        ),
      ]),
    );
  });

  it("executes cs as a JSON CLI search and formats the top result for Pi", async () => {
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
      ]),
      stderr: "",
    });
    const { handlers, tools } = registerExtension();

    const ctx = createSessionStartContext(
      { which: whichCs, execFile },
      "/repo",
    );

    await handlers.get("session_start")?.({ reason: "startup" }, ctx);

    const tool = tools[0];
    const result = await (tool.execute as Function)(
      "call-1",
      { query: "authenticate" },
      undefined,
      undefined,
      ctx,
    );

    expect(execFile).toHaveBeenCalledWith(
      "/usr/local/bin/cs",
      ["authenticate", "--format", "json"],
      expect.objectContaining({ cwd: "/repo" }),
    );
    expect(result.content[0].text).toContain("src/index.ts:12");
    expect(result.content[0].text).toContain(
      "export function authenticate() {}",
    );
  });
});
