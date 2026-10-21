/* biome-ignore-all lint/suspicious/noExplicitAny: pi session/loader 的测试替身必须是 any。 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loaderOptions = vi.hoisted(() => [] as any[]);

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: vi.fn(),
  createCodemodeExtension: () => ({ name: "codemode" }),
  createMcpExtension: () => ({ name: "mcp" }),
  DefaultResourceLoader: class {
    options: any;
    constructor(options: any) {
      this.options = options;
      loaderOptions.push(options);
    }
    async reload(): Promise<void> {}
  },
  getAgentDir: () => "/agent",
  SessionManager: { inMemory: () => ({ kind: "in-memory" }) },
}));

const { createAgentSession } = await import("@earendil-works/pi-coding-agent");
const { registerSubagent } = await import("./index.js");

type FakeSession = {
  messages: unknown[];
  bindExtensions: ReturnType<typeof vi.fn>;
  prompt: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  steer: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  setModel?: ReturnType<typeof vi.fn>;
};

const makeSession = (
  text: string,
  options: { hang?: boolean } = {},
): FakeSession => {
  const session: FakeSession = {
    messages: [],
    prompt: vi.fn(async () => {
      if (options.hang) await new Promise(() => undefined);
      session.messages.push({
        role: "assistant",
        content: [{ type: "text", text }],
      });
    }),
    subscribe: vi.fn(() => () => undefined),
    dispose: vi.fn(),
    steer: vi.fn(async () => "queued"),
    abort: vi.fn(async () => undefined),
    bindExtensions: vi.fn(async () => undefined),
  };
  return session;
};

type FakePi = {
  registerTool: ReturnType<typeof vi.fn>;
  registerCommand: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  getActiveTools: ReturnType<typeof vi.fn>;
  getAllTools: ReturnType<typeof vi.fn>;
  events: { emit: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> };
};

const makePi = (): { pi: FakePi; tools: any[] } => {
  const tools: any[] = [];
  const pi: FakePi = {
    registerTool: vi.fn((tool) => tools.push(tool)),
    registerCommand: vi.fn(),
    on: vi.fn(),
    sendMessage: vi.fn(),
    getActiveTools: vi.fn(() => ["read", "bash"]),
    getAllTools: vi.fn(() => [{ name: "read" }]),
    events: { emit: vi.fn(), on: vi.fn() },
  };
  return { pi, tools };
};

const makeCtx = (over: Record<string, unknown> = {}) => ({
  cwd: "/repo",
  model: { id: "parent-model" },
  thinkingLevel: "max",
  modelRegistry: { find: () => undefined },
  mode: "tui",
  hasUI: true,
  ui: { setWidget: vi.fn() },
  ...over,
});

const call = (
  tool: any,
  params: Record<string, unknown>,
  ctx: Record<string, unknown>,
) => tool.execute("call-1", params, undefined, undefined, ctx);

beforeEach(() => {
  vi.mocked(createAgentSession).mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("subagent tool registration", () => {
  it("registers exactly one tool named subagent", () => {
    const { pi, tools } = makePi();
    registerSubagent(pi as never);

    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("subagent");
    expect(tools[0].label).toBe("Subagent");
  });

  it("keeps the task required by refusing a run without one", async () => {
    const { pi, tools } = makePi();
    registerSubagent(pi as never);

    await expect(call(tools[0], { action: "run" }, makeCtx())).rejects.toThrow(
      "run requires task",
    );
  });

  it("names the available agents when asked for an unknown one", async () => {
    const { pi, tools } = makePi();
    registerSubagent(pi as never);

    await expect(
      call(tools[0], { action: "run", agent: "ghost", task: "x" }, makeCtx()),
    ).rejects.toThrow(
      /unknown agent "ghost"\. Available: explore, general, reviewer/,
    );
  });
});

describe("foreground run", () => {
  it("returns the child's final message as the tool result", async () => {
    vi.mocked(createAgentSession).mockResolvedValue({
      session: makeSession("auth lives in auth.ts"),
    } as never);
    const { pi, tools } = makePi();
    registerSubagent(pi as never);

    const result = await call(
      tools[0],
      {
        action: "run",
        agent: "explore",
        task: "where is auth",
        background: false,
      },
      makeCtx(),
    );

    expect(result.content[0].text).toBe("auth lives in auth.ts");
    expect(result.structuredContent.status).toBe("done");
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("surfaces a boot failure as a failed run", async () => {
    vi.mocked(createAgentSession).mockRejectedValue(
      new Error("no auth for provider"),
    );
    const { pi, tools } = makePi();
    registerSubagent(pi as never);

    await expect(
      call(
        tools[0],
        { action: "run", agent: "explore", task: "x", background: false },
        makeCtx(),
      ),
    ).rejects.toThrow("no auth for provider");
  });
});

describe("background run", () => {
  it("delivers the result once with triggerTurn", async () => {
    vi.mocked(createAgentSession).mockResolvedValue({
      session: makeSession("3 directories"),
    } as never);
    const { pi, tools } = makePi();
    registerSubagent(pi as never);

    const result = await call(
      tools[0],
      { action: "run", agent: "explore", task: "count dirs" },
      makeCtx(),
    );

    expect(result.structuredContent.status).toBe("done");
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(1));

    const [message, options] = pi.sendMessage.mock.calls[0];
    expect(options).toEqual({ triggerTurn: true });
    expect(message.content[0].text).toContain("3 directories");
    expect(message.details).toMatchObject({ agent: "explore", status: "done" });
  });
});

describe("concurrency ceiling", () => {
  it("queues the fifth run instead of starting it", async () => {
    vi.mocked(createAgentSession).mockImplementation((async () => ({
      session: makeSession("never", { hang: true }),
    })) as never);
    const { pi, tools } = makePi();
    registerSubagent(pi as never);
    const ctx = makeCtx();

    for (const id of ["a1", "a2", "a3", "a4", "a5"]) {
      await call(tools[0], { action: "run", agent: "explore", task: id }, ctx);
    }

    const list = await call(tools[0], { action: "list" }, ctx);
    expect(list.structuredContent.runs).toHaveLength(5);
    expect(
      list.structuredContent.runs.filter(
        (run: any) => run.status === "running",
      ),
    ).toHaveLength(4);
    expect(
      list.structuredContent.runs.filter((run: any) => run.status === "queued"),
    ).toHaveLength(1);
    await vi.waitFor(() =>
      expect(vi.mocked(createAgentSession)).toHaveBeenCalledTimes(4),
    );
  });
});

describe("capability inheritance", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
    loaderOptions.length = 0;
  });

  const writeAgent = (cwd: string, name: string, body: string): void => {
    const dir = join(cwd, ".pi", "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.md`), body, "utf8");
  };

  const runOnce = async (tools: any[], cwd = "/repo") => {
    vi.mocked(createAgentSession).mockResolvedValue({
      session: makeSession("ok"),
    } as never);
    await call(
      tools[0],
      { action: "run", agent: "explore", task: "x", background: false },
      makeCtx({ cwd }),
    );
    return loaderOptions.at(-1);
  };

  it("adds no capability extension when the parent has neither", async () => {
    const { pi, tools } = makePi();
    pi.getActiveTools.mockReturnValue(["read", "bash"]);
    pi.getAllTools.mockReturnValue([{ name: "read" }, { name: "bash" }]);
    registerSubagent(pi as never);

    const options = await runOnce(tools);

    expect(options.extensionFactories).toEqual([]);
  });

  it("follows the parent's codemode", async () => {
    const { pi, tools } = makePi();
    pi.getActiveTools.mockReturnValue(["read", "codemode"]);
    registerSubagent(pi as never);

    const options = await runOnce(tools);

    expect(options.extensionFactories).toHaveLength(1);
  });

  it("follows the parent's MCP by looking for mcp__ tools", async () => {
    const { pi, tools } = makePi();
    pi.getAllTools.mockReturnValue([
      { name: "read" },
      { name: "mcp__toolverse__search" },
    ]);
    registerSubagent(pi as never);

    const options = await runOnce(tools);

    expect(options.extensionFactories).toHaveLength(2);
  });

  it("lets a project agent opt out with mcp: none", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "subagent-caps-"));
    tempDirs.push(cwd);
    writeAgent(cwd, "explore", "---\nname: explore\nmcp: none\n---\nbody\n");

    const { pi, tools } = makePi();
    pi.getActiveTools.mockReturnValue(["read", "codemode"]);
    pi.getAllTools.mockReturnValue([{ name: "mcp__toolverse__search" }]);
    registerSubagent(pi as never);

    const options = await runOnce(tools, cwd);

    expect(options.extensionFactories).toHaveLength(1);
  });

  it("lets a project agent force codemode on when the parent had it off", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "subagent-caps-"));
    tempDirs.push(cwd);
    writeAgent(
      cwd,
      "explore",
      "---\nname: explore\ncodemode: true\n---\nbody\n",
    );

    const { pi, tools } = makePi();
    pi.getActiveTools.mockReturnValue(["read"]);
    pi.getAllTools.mockReturnValue([{ name: "read" }]);
    registerSubagent(pi as never);

    const options = await runOnce(tools, cwd);

    expect(options.extensionFactories).toHaveLength(1);
  });

  it("reports the resolved capabilities in doctor", async () => {
    const { pi, tools } = makePi();
    pi.getActiveTools.mockReturnValue(["codemode", "read"]);
    registerSubagent(pi as never);

    const result = await call(tools[0], { action: "doctor" }, makeCtx());
    const text = result.content[0].text as string;

    expect(text).toContain("codemode=inherit mcp=inherit");
  });
});

describe("steer and stop", () => {
  it("refuses to steer a run that has no live session", async () => {
    const { pi, tools } = makePi();
    registerSubagent(pi as never);

    const result = await call(
      tools[0],
      { action: "stop", runId: "ghost" },
      makeCtx(),
    );

    expect(result.structuredContent.status).toBeNull();
  });
});

describe("doctor", () => {
  it("prints the resolved profiles and the log level", async () => {
    const { pi, tools } = makePi();
    registerSubagent(pi as never);

    const result = await call(
      tools[0],
      { action: "doctor" },
      makeCtx({ mode: "print", hasUI: false }),
    );
    const text = result.content[0].text as string;

    expect(text).toContain("host: print (customPanels: false)");
    expect(text).toContain("reviewer [builtin]");
    expect(text).toContain("log level:");
  });
});

describe("agent file discovery", () => {
  it("reads project agents from <cwd>/.pi/agents", async () => {
    const { pi } = makePi();
    const runtime = registerSubagent(pi as never);
    const cwd = "/repo";

    const { scannedDirs } = await runtime.loadProfiles(cwd);

    expect(scannedDirs[0]).toBe("/repo/.pi/agents");
    expect(scannedDirs[1]).toMatch(/\.pi\/agent\/agents$/);
  });
});

describe("/agents command", () => {
  const commandOf = (pi: FakePi): any => pi.registerCommand.mock.calls[0]?.[1];

  it("registers the agents command", () => {
    const { pi } = makePi();
    registerSubagent(pi as never);

    expect(pi.registerCommand).toHaveBeenCalledWith(
      "agents",
      expect.anything(),
    );
  });

  it("falls back to a notify when the host has no custom panels", async () => {
    vi.mocked(createAgentSession).mockResolvedValue({
      session: makeSession("done") as never,
    } as never);
    const { pi, tools } = makePi();
    registerSubagent(pi as never);
    await call(
      tools[0],
      { action: "run", agent: "explore", task: "x" },
      makeCtx(),
    );

    const notify = vi.fn();
    await commandOf(pi).handler("", {
      mode: "print",
      hasUI: false,
      ui: { notify, select: vi.fn(), custom: vi.fn() },
    });

    expect(notify).toHaveBeenCalled();
    expect(notify.mock.calls[0][0]).toContain("explore");
  });

  it("says so when there is nothing to show", async () => {
    const { pi } = makePi();
    registerSubagent(pi as never);

    const notify = vi.fn();
    await commandOf(pi).handler("", {
      mode: "tui",
      hasUI: true,
      ui: { notify, select: vi.fn(), custom: vi.fn() },
    });

    expect(notify.mock.calls[0][0]).toBe("no subagent runs in this session");
  });
});

describe("rpc wiring", () => {
  it("answers a list request on the reply channel", async () => {
    const { pi } = makePi();
    registerSubagent(pi as never);

    const handler = pi.events.on.mock.calls[0][1] as (raw: unknown) => void;
    handler({ version: 1, id: "req-1", method: "list" });

    const [channel, reply] = pi.events.emit.mock.calls[0];
    expect(channel).toBe("subagent:rpc:reply:req-1");
    expect(reply).toMatchObject({ version: 1, id: "req-1", ok: true });
  });

  it("replies with an error and emits nothing else for a bad envelope", async () => {
    const { pi } = makePi();
    registerSubagent(pi as never);

    const handler = pi.events.on.mock.calls[0][1] as (raw: unknown) => void;
    handler({ version: 9, id: "req-2", method: "list" });

    expect(pi.events.emit).toHaveBeenCalledTimes(1);
    expect(pi.events.emit.mock.calls[0][1]).toMatchObject({ ok: false });
  });
});

describe("package wiring", () => {
  it("is listed in package.json pi.extensions", async () => {
    const raw = await readFile(
      new URL("../../package.json", import.meta.url),
      "utf8",
    );
    const pkg = JSON.parse(raw) as { pi: { extensions: string[] } };

    expect(pkg.pi.extensions).toContain("./extensions/subagent");
  });
});
