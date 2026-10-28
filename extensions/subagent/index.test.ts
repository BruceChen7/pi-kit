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
const { PI_WEB_HOST_SYMBOL } = await import("../shared/ui-host.ts");
const { PLAN_MODE_BADGE_CHANNEL, PLAN_MODE_STATUS_OWNER_CHANNEL } =
  await import("../shared/internal-events.ts");

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

/** 宿主一定提供 theme；假的 ui 也必须带上，否则 TUI 分支会去读 undefined。 */
const testTheme = { fg: (_tone: string, text: string) => text };

const makeCtx = (over: Record<string, unknown> = {}) => ({
  cwd: "/repo",
  model: { id: "parent-model" },
  thinkingLevel: "max",
  modelRegistry: { find: () => undefined },
  mode: "tui",
  hasUI: true,
  ui: { setWidget: vi.fn(), theme: testTheme },
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

  it("rejects an unknown action instead of falling through to run", async () => {
    const { pi, tools } = makePi();
    registerSubagent(pi as never);

    await expect(
      call(tools[0], { action: "stop-all", task: "x" }, makeCtx()),
    ).rejects.toThrow('unknown action "stop-all"');
  });

  it("names the available agents when asked for an unknown one", async () => {
    const { pi, tools } = makePi();
    registerSubagent(pi as never);

    // 用 contains 而不是整串匹配：可用列表还包含用户目录里安装的 profile，
    // 断言全量集合会把测试绑到跑测试这台机器的 ~/.pi/agent/agents 上。
    const error = (await call(
      tools[0],
      { action: "run", agent: "ghost", task: "x" },
      makeCtx(),
    ).catch((thrown: unknown) => thrown)) as Error;

    expect(error.message).toContain('unknown agent "ghost". Available:');
    for (const builtin of ["explore", "general", "reviewer"]) {
      expect(error.message).toContain(builtin);
    }
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

describe("progress while a foreground child is silent", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const slowTool = () => {
    vi.mocked(createAgentSession).mockResolvedValue({
      session: makeSession("unreachable", { hang: true }),
    } as never);
    const { pi, tools } = makePi();
    return { runtime: registerSubagent(pi as never), tool: tools[0] };
  };

  it("pushes an update every tick and freezes once the run stops", async () => {
    vi.useFakeTimers();
    const { runtime, tool } = slowTool();
    const ui = { setWidget: vi.fn(), setStatus: vi.fn(), theme: testTheme };
    const onUpdate = vi.fn();

    void tool.execute(
      "call-1",
      { action: "run", agent: "explore", task: "slow", background: false },
      undefined,
      onUpdate,
      makeCtx({ ui }),
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(runtime.readState().runs).toHaveLength(1));

    await vi.advanceTimersByTimeAsync(32_000);

    expect(onUpdate.mock.calls.length).toBeGreaterThanOrEqual(3);
    const last = onUpdate.mock.calls.at(-1)?.[0];
    expect(last.content[0].text).toContain("quiet");
    expect(ui.setStatus).toHaveBeenCalled();

    runtime.stopRun(runtime.readState().runs[0].runId);
    await vi.advanceTimersByTimeAsync(0);
    const frozen = onUpdate.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(onUpdate.mock.calls.length).toBe(frozen);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps updating when the host has no footer status", async () => {
    vi.useFakeTimers();
    const { runtime, tool } = slowTool();
    const onUpdate = vi.fn();

    void tool.execute(
      "call-1",
      { action: "run", agent: "explore", task: "slow", background: false },
      undefined,
      onUpdate,
      makeCtx(),
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(runtime.readState().runs).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(4000);

    expect(onUpdate).toHaveBeenCalled();
    runtime.stopRun(runtime.readState().runs[0].runId);
  });
});

describe("widget shape per host", () => {
  const withPiWebMarker = () => {
    const global = globalThis as Record<PropertyKey, unknown>;
    global[PI_WEB_HOST_SYMBOL] = { version: 1 };
    return () => {
      delete global[PI_WEB_HOST_SYMBOL];
    };
  };

  const admitThree = async () => {
    vi.mocked(createAgentSession).mockImplementation((async () => ({
      session: makeSession("never", { hang: true }),
    })) as never);
    const { pi, tools } = makePi();
    registerSubagent(pi as never);
    const ui = { setWidget: vi.fn(), setStatus: vi.fn(), theme: testTheme };
    const ctx = { cwd: "/repo", mode: "rpc", hasUI: true, ui };
    for (const id of ["a1", "a2", "a3"]) {
      await call(tools[0], { action: "run", agent: "explore", task: id }, ctx);
    }
    const widgets = ui.setWidget.mock.calls.filter(
      ([key]) => key === "subagent",
    );
    return { ui, widget: widgets.at(-1)?.[1] as string[] | undefined };
  };

  it("fits the widget into pi-web's 3-line auto-expand window", async () => {
    const clearMarker = withPiWebMarker();
    try {
      const { ui, widget } = await admitThree();

      expect(Array.isArray(widget)).toBe(true);
      expect(widget?.length).toBeLessThanOrEqual(3);
      expect(widget?.[0]).toContain("+1 more");
      const status = ui.setStatus.mock.calls.at(-1)?.[1] as string;
      expect(status).toBe("subagent 3 running, 0 queued");
      expect(status.length).toBeLessThanOrEqual(40);
    } finally {
      clearMarker();
    }
  });

  it("lists every run when the host has no line limit", async () => {
    const { widget } = await admitThree();

    expect(widget).toHaveLength(4);
    expect(widget?.[0]).not.toContain("more");
  });
});

/**
 * plan-mode 会把自己渲染成唯一的状态面：subagent 广播文本，然后在被接管时
 * 清掉自己的 footer 段，避免同一个计数出现两次。
 */
describe("plan-mode 接管 footer", () => {
  const admitThree = async () => {
    vi.mocked(createAgentSession).mockImplementation((async () => ({
      session: makeSession("never", { hang: true }),
    })) as never);
    const { pi, tools } = makePi();
    registerSubagent(pi as never);
    const ui = { setWidget: vi.fn(), setStatus: vi.fn(), theme: testTheme };
    const ctx = { cwd: "/repo", mode: "rpc", hasUI: true, ui };
    for (const id of ["a1", "a2", "a3"]) {
      await call(tools[0], { action: "run", agent: "explore", task: id }, ctx);
    }
    return { pi, ui };
  };

  const badgePayloads = (pi: ReturnType<typeof makePi>["pi"]) =>
    pi.events.emit.mock.calls
      .filter(([channel]) => channel === PLAN_MODE_BADGE_CHANNEL)
      .map(([, payload]) => payload as Record<string, unknown>);

  const ownerHandler = (pi: ReturnType<typeof makePi>["pi"]) =>
    pi.events.on.mock.calls.find(
      ([channel]) => channel === PLAN_MODE_STATUS_OWNER_CHANNEL,
    )?.[1] as (payload: unknown) => void;

  it("broadcasts the run count for plan-mode to render", async () => {
    const { pi } = await admitThree();

    expect(badgePayloads(pi).at(-1)).toMatchObject({
      type: "plan-mode.badge",
      cwd: "/repo",
      key: "subagent",
      text: "subagent 3 running, 0 queued",
    });
  });

  it("yields its footer while plan-mode owns the surface and restores it on release", async () => {
    const { pi, ui } = await admitThree();
    expect(ui.setStatus).toHaveBeenLastCalledWith(
      "subagent",
      "subagent 3 running, 0 queued",
    );

    ownerHandler(pi)({ type: "plan-mode.status-owner", active: true });
    expect(ui.setStatus).toHaveBeenLastCalledWith("subagent", undefined);

    ownerHandler(pi)({ type: "plan-mode.status-owner", active: false });
    expect(ui.setStatus).toHaveBeenLastCalledWith(
      "subagent",
      "subagent 3 running, 0 queued",
    );
  });

  it("ignores repeated ownership notices", async () => {
    const { pi, ui } = await admitThree();
    ownerHandler(pi)({ type: "plan-mode.status-owner", active: true });
    const afterClaim = ui.setStatus.mock.calls.length;

    ownerHandler(pi)({ type: "plan-mode.status-owner", active: true });

    expect(ui.setStatus.mock.calls.length).toBe(afterClaim);
  });

  it("yields the footer on the same publish when plan-mode claims synchronously", async () => {
    vi.mocked(createAgentSession).mockImplementation((async () => ({
      session: makeSession("never", { hang: true }),
    })) as never);
    const { pi, tools } = makePi();
    // 真事件总线：plan-mode 的接管发生在 subagent 正在刷新的那一刻（同步回环）。
    const handlers = new Map<string, Array<(payload: unknown) => void>>();
    const bus = {
      emit: (channel: string, payload: unknown) => {
        for (const handler of handlers.get(channel) ?? []) handler(payload);
      },
      on: (channel: string, handler: (payload: unknown) => void) => {
        handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
        return () => {};
      },
    };
    (pi as any).events = bus;
    bus.on(PLAN_MODE_BADGE_CHANNEL, (payload) => {
      const text = (payload as { text: string | null }).text;
      bus.emit(PLAN_MODE_STATUS_OWNER_CHANNEL, {
        type: "plan-mode.status-owner",
        active: text !== null,
      });
    });
    registerSubagent(pi as never);
    const ui = { setWidget: vi.fn(), setStatus: vi.fn(), theme: testTheme };
    const ctx = { cwd: "/repo", mode: "rpc", hasUI: true, ui };

    await call(tools[0], { action: "run", agent: "explore", task: "a1" }, ctx);

    expect(ui.setStatus).toHaveBeenLastCalledWith("subagent", undefined);
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

    // 后台调用是「已受理」，不是「已完成」：终态只在 deliver 之后出现。
    expect(result.structuredContent.status).toBeNull();
    expect(result.structuredContent.runId).toBeTypeOf("string");
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(1));

    const [message, options] = pi.sendMessage.mock.calls[0];
    expect(options).toEqual({ triggerTurn: true });
    expect(message.content[0].text).toContain("3 directories");
    expect(message.details).toMatchObject({ agent: "explore", status: "done" });
  });
});

describe("wait", () => {
  /** 手动放行的子会话：wait 的契约是「什么时候终态」，必须由测试控制。 */
  const gated = (text: string) => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = makeSession(text);
    session.prompt = vi.fn(async () => {
      await gate;
      session.messages.push({
        role: "assistant",
        content: [{ type: "text", text }],
      });
    });
    return { session, release: () => release() };
  };

  const callWithSignal = (
    tool: any,
    params: Record<string, unknown>,
    ctx: Record<string, unknown>,
    signal: AbortSignal,
  ) => tool.execute("call-1", params, signal, undefined, ctx);

  const startBackground = async (text: string) => {
    const gate = gated(text);
    vi.mocked(createAgentSession).mockImplementation((async () => ({
      session: gate.session,
    })) as never);
    const { pi, tools } = makePi();
    const runtime = registerSubagent(pi as never);

    const started = await call(
      tools[0],
      { action: "run", agent: "explore", task: "count dirs" },
      makeCtx(),
    );
    // 等 launch 真拿到会话再返回，否则未完成的 launch 会把这次调用算进下一个测试。
    await vi.waitFor(() =>
      expect(vi.mocked(createAgentSession)).toHaveBeenCalledTimes(1),
    );
    return {
      pi,
      runtime,
      tool: tools[0],
      runId: started.structuredContent.runId as string,
      release: gate.release,
    };
  };

  it("returns the child's text instead of making the caller poll", async () => {
    const { tool, runId, release } = await startBackground("3 directories");

    const waiting = call(tool, { action: "wait", runIds: [runId] }, makeCtx());
    release();
    const result = await waiting;

    expect(result.content[0].text).toContain("3 directories");
    expect(result.structuredContent).toMatchObject({
      timedOut: false,
      runs: [
        { runId, agent: "explore", status: "done", text: "3 directories" },
      ],
    });
  });

  it("waits for every active run when no ids are given", async () => {
    const gate = gated("both done");
    vi.mocked(createAgentSession).mockImplementation((async () => ({
      session: gate.session,
    })) as never);
    const { pi, tools } = makePi();
    registerSubagent(pi as never);

    await call(tools[0], { action: "run", task: "a" }, makeCtx());
    await call(tools[0], { action: "run", task: "b" }, makeCtx());
    await vi.waitFor(() =>
      expect(vi.mocked(createAgentSession)).toHaveBeenCalledTimes(2),
    );

    const waiting = call(tools[0], { action: "wait" }, makeCtx());
    gate.release();
    const result = await waiting;

    expect(result.structuredContent.runs).toHaveLength(2);
    expect(
      result.structuredContent.runs.every(
        (run: { status: string }) => run.status === "done",
      ),
    ).toBe(true);
  });

  it("returns immediately when there is nothing active", async () => {
    const { pi, tools } = makePi();
    registerSubagent(pi as never);

    const result = await call(tools[0], { action: "wait" }, makeCtx());

    expect(result.content[0].text).toBe("no subagent runs to wait for");
    expect(result.structuredContent.runs).toEqual([]);
  });

  it("returns the same result when called twice on one run", async () => {
    const { tool, runId, release } = await startBackground("settled once");
    release();

    const first = await call(
      tool,
      { action: "wait", runIds: [runId] },
      makeCtx(),
    );
    const second = await call(
      tool,
      { action: "wait", runIds: [runId] },
      makeCtx(),
    );

    expect(second.structuredContent).toEqual(first.structuredContent);
  });

  it("names the unknown id instead of hanging on it", async () => {
    const { pi, tools } = makePi();
    registerSubagent(pi as never);

    await expect(
      call(tools[0], { action: "wait", runIds: ["nope"] }, makeCtx()),
    ).rejects.toThrow('unknown run "nope"');
  });

  it("reports partial progress when the timeout fires first", async () => {
    const { tool, runId, release } = await startBackground("too late");

    const result = await call(
      tool,
      { action: "wait", runIds: [runId], timeoutMs: 5 },
      makeCtx(),
    );

    expect(result.structuredContent.timedOut).toBe(true);
    expect(result.structuredContent.runs[0]).toMatchObject({
      runId,
      status: "running",
      text: "",
    });
    expect(result.content[0].text).toContain("0/1 settled");
    release();
  });

  it("does not re-trigger a turn after wait returned the result", async () => {
    const { pi, runtime, tool, runId, release } =
      await startBackground("3 directories");

    const waiting = call(tool, { action: "wait", runIds: [runId] }, makeCtx());
    release();
    await waiting;

    // wait 已经把结果交给调用方，再发一条 subagent:result 会多烧一轮模型调用。
    await vi.waitFor(() =>
      expect(runtime.readState().runs[0]?.status).toBe("done"),
    );
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("stops waiting when the host cancels the tool call", async () => {
    const { tool, runId, release } = await startBackground("cancelled");

    const controller = new AbortController();
    const waiting = callWithSignal(
      tool,
      { action: "wait", runIds: [runId] },
      makeCtx(),
      controller.signal,
    );
    controller.abort();

    await expect(waiting).rejects.toThrow("cancelled");
    release();
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

describe("session reset", () => {
  it("settles a pending foreground run instead of leaving it hanging", async () => {
    vi.mocked(createAgentSession).mockImplementation((async () => ({
      session: makeSession("never", { hang: true }),
    })) as never);
    const { pi, tools } = makePi();
    registerSubagent(pi as never);

    const pendingRun = call(
      tools[0],
      { action: "run", task: "slow", background: false },
      makeCtx(),
    );
    await vi.waitFor(() =>
      expect(vi.mocked(createAgentSession)).toHaveBeenCalledTimes(1),
    );

    const onSessionStart = pi.on.mock.calls.find(
      ([event]) => event === "session_start",
    )?.[1];
    expect(onSessionStart).toBeTypeOf("function");
    onSessionStart?.();

    const result = await pendingRun;
    expect(result.structuredContent.status).toBe("stopped");
    expect(result.content[0].text).toContain("stopped");
  });
});

describe("stale host context", () => {
  it("settles a run even when the host context throws on read", async () => {
    vi.mocked(createAgentSession).mockResolvedValue({
      session: makeSession("ok"),
    } as never);
    const { pi, tools } = makePi();
    registerSubagent(pi as never);

    // 会话结束后宿主 ctx 会 stale，读 ui / mode / hasUI 都抛。widget 刷新是
    // best-effort，不能让它从 launch 的 finally 里逃出去把进程打死。
    const ctx = makeCtx();
    for (const key of ["ui", "mode", "hasUI"]) {
      Object.defineProperty(ctx, key, {
        get() {
          throw new Error("This extension ctx is stale");
        },
      });
    }

    const result = await call(
      tools[0],
      { action: "run", task: "x", background: false },
      ctx,
    );

    expect(result.structuredContent.status).toBe("done");
    expect(result.content[0].text).toBe("ok");
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

  it("does not hand the child the parent's MCP", async () => {
    const { pi, tools } = makePi();
    pi.getAllTools.mockReturnValue([
      { name: "read" },
      { name: "mcp__toolverse__search" },
    ]);
    registerSubagent(pi as never);

    const options = await runOnce(tools);

    // 每个 child 都新建一份 MCP 客户端，dispose 不关它的 socket；默认不连。
    expect(options.extensionFactories).toEqual([]);
  });

  it("lets a project agent opt in with mcp: inherit", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "subagent-caps-"));
    tempDirs.push(cwd);
    writeAgent(cwd, "explore", "---\nname: explore\nmcp: inherit\n---\nbody\n");

    const { pi, tools } = makePi();
    pi.getAllTools.mockReturnValue([{ name: "mcp__toolverse__search" }]);
    registerSubagent(pi as never);

    const options = await runOnce(tools, cwd);

    // MCP + 它需要的 codemode。
    expect(options.extensionFactories).toHaveLength(2);
  });

  it("keeps MCP off when the parent has none", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "subagent-caps-"));
    tempDirs.push(cwd);
    writeAgent(cwd, "explore", "---\nname: explore\nmcp: inherit\n---\nbody\n");

    const { pi, tools } = makePi();
    pi.getAllTools.mockReturnValue([{ name: "read" }]);
    registerSubagent(pi as never);

    const options = await runOnce(tools, cwd);

    expect(options.extensionFactories).toEqual([]);
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

    expect(text).toContain("codemode=inherit mcp=none");
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
