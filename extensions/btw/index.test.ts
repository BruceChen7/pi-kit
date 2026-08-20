import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_HISTORY_EXCHANGES } from "./core.js";
import btwExtension from "./index.js";

// 边界测试：mock 掉 @earendil-works/pi-coding-agent（createAgentSession 等会话 boot
// 依赖）与 @earendil-works/pi-ai/compat（completeSimple），注入假 AgentSession，
// 通过命令 handler 驱动真实扩展编排逻辑。overlay 组件本身不测。

type ModelLike = { provider: string; id: string };
type PromptOptions = { source?: string };
type SessionEvent = { type: string; [key: string]: unknown };

interface TestContext {
  mode: string;
  cwd: string;
  model: ModelLike;
  getSystemPromptOptions: () => {
    cwd: string;
    customPrompt: string;
    appendSystemPrompt: string;
  };
  sessionManager: {
    getEntries: () => unknown[];
    getLeafId: () => string;
  };
  modelRegistry: {
    find: () => ModelLike | undefined;
    getApiKeyAndHeaders: () => Promise<{ ok: boolean; apiKey: string }>;
  };
  ui: {
    notify: (message: string, level?: string) => void;
    custom: () => Promise<undefined>;
  };
  [key: string]: unknown;
}

interface FakeSession {
  messages: unknown[];
  subscribe: (fn: (event: SessionEvent) => void) => () => void;
  prompt: (question: string, options?: PromptOptions) => Promise<void>;
  setModel: (model: ModelLike) => Promise<void>;
  setThinkingLevel: (level: string) => void;
  abort: () => Promise<void>;
  dispose: () => void;
}

const createAgentSession = vi.hoisted(() => vi.fn());
const SessionManager = vi.hoisted(() => vi.fn());
const buildSessionContext = vi.hoisted(() => vi.fn(() => ({ messages: [] })));
const convertToLlm = vi.hoisted(() => vi.fn((messages: unknown) => messages));
const getAgentDir = vi.hoisted(() => vi.fn(() => "/tmp/agent-dir"));
const getMarkdownTheme = vi.hoisted(() => vi.fn(() => ({})));
const copyToClipboard = vi.hoisted(() => vi.fn(async () => {}));
const DefaultResourceLoader = vi.hoisted(() => {
  return class DefaultResourceLoaderMock {
    options: unknown;
    reload = vi.fn(async () => {});
    constructor(options: unknown) {
      this.options = options;
    }
  };
});
const completeSimple = vi.hoisted(() => vi.fn());

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession,
  SessionManager,
  buildSessionContext,
  convertToLlm,
  DefaultResourceLoader,
  getAgentDir,
  getMarkdownTheme,
  copyToClipboard,
}));

vi.mock("@earendil-works/pi-ai/compat", () => ({
  completeSimple,
}));

const activeModel = { provider: "openai", id: "active-model" };
const fastModel = { provider: "google", id: "gemini-flash-lite-latest" };

type CommandRegistration = {
  description: string;
  handler: (args: string, ctx: TestContext) => Promise<void>;
};

type ShortcutRegistration = {
  description: string;
  handler: () => void;
};

function assistantMsg(text: string, stopReason = "stop") {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    model: "m",
    provider: "openai",
    api: "",
    usage: {},
    stopReason,
    timestamp: 0,
  };
}

function createFakeSession() {
  const listeners: Array<(event: SessionEvent) => void> = [];
  const session: FakeSession = {
    messages: [] as unknown[],
    subscribe: vi.fn((fn: (event: SessionEvent) => void) => {
      listeners.push(fn);
      return () => {};
    }),
    prompt: vi.fn(async () => {}),
    setModel: vi.fn(async () => {}),
    setThinkingLevel: vi.fn(() => {}),
    abort: vi.fn(async () => {}),
    dispose: vi.fn(() => {}),
  };
  return { session, listeners };
}

function createHarness() {
  const commands = new Map<string, CommandRegistration>();
  const shortcuts = new Map<string, ShortcutRegistration>();
  const sendUserMessage = vi.fn();
  btwExtension({
    on() {},
    getThinkingLevel: () => "medium",
    registerCommand(name: string, registration: CommandRegistration) {
      commands.set(name, registration);
    },
    registerShortcut(name: string, registration: ShortcutRegistration) {
      shortcuts.set(name, registration);
    },
    sendUserMessage,
  } as never);
  return { commands, shortcuts, sendUserMessage };
}

function createContext(overrides: Record<string, unknown> = {}): TestContext {
  return {
    mode: "tui",
    cwd: "/tmp/work",
    model: activeModel,
    getSystemPromptOptions: () => ({
      cwd: "/tmp/work",
      customPrompt: "custom prompt",
      appendSystemPrompt: "append prompt",
    }),
    sessionManager: {
      getEntries: () => [],
      getLeafId: () => "leaf-id",
    },
    modelRegistry: {
      find: () => undefined,
      getApiKeyAndHeaders: vi.fn(async () => ({
        ok: true,
        apiKey: "test-key",
      })),
    },
    ui: {
      notify: vi.fn(),
      custom: vi.fn(async () => undefined),
    },
    ...overrides,
  };
}

function requireCommand(
  commands: Map<string, CommandRegistration>,
  name: string,
): CommandRegistration {
  const command = commands.get(name);
  if (!command) throw new Error(`Expected /${name} to be registered`);
  return command;
}

/** 让 fake session 每次 prompt 都推一条 assistant 消息（stop），再返回最新。 */
function withAutoAnswer(session: FakeSession) {
  const prompt = vi.fn(async () => {
    session.messages.push(assistantMsg("side answer"));
  });
  session.prompt = prompt as FakeSession["prompt"];
}

beforeEach(() => {
  buildSessionContext.mockReturnValue({
    messages: [{ role: "user", content: [{ type: "text", text: "seed" }] }],
  });
  convertToLlm.mockImplementation((messages: unknown) => messages);
  (
    SessionManager as unknown as { inMemory: ReturnType<typeof vi.fn> }
  ).inMemory = vi.fn(() => ({
    appendMessage: vi.fn(),
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  completeSimple.mockReset();
});

describe("btw extension（pi-btw 思路）", () => {
  it("注册 side-conversation 命令与焦点快捷键", () => {
    const { commands, shortcuts } = createHarness();

    expect([...commands.keys()]).toEqual([
      "btw",
      "btw:new",
      "btw:clear",
      "btw:inject",
      "btw:summarize",
    ]);
    expect(shortcuts.get("alt+/")?.description).toContain("btw");
    expect(shortcuts.get("ctrl+alt+w")?.description).toContain("btw");
  });

  it("非 TUI 模式报错且不开子会话", async () => {
    const { commands } = createHarness();
    const ctx = createContext({ mode: "print" });

    await requireCommand(commands, "btw").handler("question?", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "/btw requires interactive TUI mode",
      "error",
    );
    expect(createAgentSession).not.toHaveBeenCalled();
  });

  it("/btw 无参只打开 overlay，不建会话", async () => {
    const { commands } = createHarness();
    const ctx = createContext();

    await requireCommand(commands, "btw").handler("   ", ctx);

    expect(ctx.ui.custom).toHaveBeenCalled();
    expect(createAgentSession).not.toHaveBeenCalled();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("/btw 懒建只读子会话（seed 主消息 + 白名单工具 + 模型同步），完成流式交换", async () => {
    const { commands, sendUserMessage } = createHarness();
    const ctx = createContext();
    const { session } = createFakeSession();
    withAutoAnswer(session);
    createAgentSession.mockResolvedValue({ session });

    await requireCommand(commands, "btw").handler("what now?", ctx);

    // 会话 boot：一次且只一次
    expect(createAgentSession).toHaveBeenCalledTimes(1);
    const bootOpts = createAgentSession.mock.calls[0][0];
    expect(bootOpts.model).toBe(activeModel);
    expect(bootOpts.thinkingLevel).toBe("medium");
    expect(bootOpts.tools).toEqual(["read", "grep", "find", "ls"]);

    // seed 走 buildSessionContext + convertToLlm → SessionManager.inMemory().appendMessage
    expect(buildSessionContext).toHaveBeenCalledWith([], "leaf-id");
    expect(convertToLlm).toHaveBeenCalled();
    const inMemoryMock = (
      SessionManager as unknown as {
        inMemory: ReturnType<typeof vi.fn>;
      }
    ).inMemory;
    const sm = inMemoryMock.mock.results[0]?.value;
    expect(sm?.appendMessage).toHaveBeenCalled();

    // 每次 ask 前 re-sync 主会话模型 + thinking level
    expect(session.setModel).toHaveBeenCalledWith(activeModel);
    expect(session.setThinkingLevel).toHaveBeenCalledWith("medium");
    expect(session.prompt).toHaveBeenCalledWith("what now?", {
      source: "extension",
    });
    expect(ctx.ui.custom).toHaveBeenCalled();

    // exchanges 是 inject 真源：格式化为 <btw-thread> 注入，成功后 dispose 子会话
    await requireCommand(commands, "btw:inject").handler(
      "please implement",
      ctx,
    );
    expect(sendUserMessage).toHaveBeenCalledWith(
      [
        "Here's a side conversation I had. please implement",
        "",
        "<btw-thread>",
        "User: what now?",
        "Assistant: side answer",
        "</btw-thread>",
      ].join("\n"),
      { deliverAs: "followUp" },
    );
    expect(session.dispose).toHaveBeenCalled();
  });

  it("连续追问复用同一子会话，不重复 boot", async () => {
    const { commands } = createHarness();
    const ctx = createContext();
    const { session } = createFakeSession();
    withAutoAnswer(session);
    createAgentSession.mockResolvedValue({ session });

    await requireCommand(commands, "btw").handler("first?", ctx);
    await requireCommand(commands, "btw").handler("second?", ctx);

    expect(createAgentSession).toHaveBeenCalledTimes(1);
    expect(session.prompt).toHaveBeenCalledTimes(2);
    expect(session.dispose).not.toHaveBeenCalled();
  });

  it("流式事件（tool + message_update）把答案推进 exchanges", async () => {
    const { commands, sendUserMessage } = createHarness();
    const ctx = createContext();
    const { session, listeners } = createFakeSession();
    let resolvePrompt!: () => void;
    session.prompt = vi.fn(
      () => new Promise<void>((resolve) => (resolvePrompt = resolve)),
    );
    createAgentSession.mockResolvedValue({ session });

    const pending = requireCommand(commands, "btw").handler("q1", ctx);
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalled());

    listeners[0]({ type: "tool_execution_start", toolName: "read" });
    listeners[0]({
      type: "message_update",
      message: { role: "assistant", content: "streamed answer" },
    });
    listeners[0]({ type: "tool_execution_end" });
    resolvePrompt();
    await pending;

    await requireCommand(commands, "btw:inject").handler("", ctx);
    expect(sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("Assistant: streamed answer"),
      { deliverAs: "followUp" },
    );
  });

  it("/btw:clear 重置（dispose 子会话 + 清空线程）',", async () => {
    const { commands } = createHarness();
    const ctx = createContext();
    const { session } = createFakeSession();
    withAutoAnswer(session);
    createAgentSession.mockResolvedValue({ session });

    await requireCommand(commands, "btw").handler("q1", ctx);
    expect(session.dispose).not.toHaveBeenCalled();

    await requireCommand(commands, "btw:clear").handler("", ctx);
    expect(session.dispose).toHaveBeenCalled();

    // 线程已空 → inject 拒绝
    await requireCommand(commands, "btw:inject").handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "No active btw thread to inject",
      "warning",
    );
  });

  it("/btw:new 重置后重新懒建会话，并可带新问题直接问", async () => {
    const { commands } = createHarness();
    const ctx = createContext();

    const first = createFakeSession();
    withAutoAnswer(first.session);
    createAgentSession.mockResolvedValueOnce({ session: first.session });
    await requireCommand(commands, "btw").handler("old", ctx);
    expect(first.session.dispose).not.toHaveBeenCalled();

    const second = createFakeSession();
    withAutoAnswer(second.session);
    createAgentSession.mockResolvedValueOnce({ session: second.session });

    await requireCommand(commands, "btw:new").handler("fresh", ctx);

    expect(first.session.dispose).toHaveBeenCalled();
    expect(createAgentSession).toHaveBeenCalledTimes(2);
    expect(second.session.prompt).toHaveBeenCalledWith("fresh", {
      source: "extension",
    });
  });

  it("/btw:summarize 用 fast profile 摘要后注入，并重置", async () => {
    const { commands, sendUserMessage } = createHarness();
    const ctx = createContext();
    ctx.modelRegistry.find = () => fastModel;
    completeSimple.mockResolvedValue({
      role: "assistant",
      content: [{ type: "text", text: "summary only" }],
    });
    const { session } = createFakeSession();
    withAutoAnswer(session);
    createAgentSession.mockResolvedValue({ session });

    await requireCommand(commands, "btw").handler("what changed?", ctx);
    await requireCommand(commands, "btw:summarize").handler("carry this", ctx);

    expect(completeSimple).toHaveBeenCalledWith(
      fastModel,
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            content: [
              expect.objectContaining({
                text: expect.stringContaining("Assistant: side answer"),
              }),
            ],
          }),
        ],
      }),
      expect.objectContaining({ apiKey: "test-key", reasoning: "low" }),
    );
    expect(sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("<btw-summary>\nsummary only\n</btw-summary>"),
      { deliverAs: "followUp" },
    );
    expect(session.dispose).toHaveBeenCalled();
  });

  it("/btw:summarize 在 fast 不可用时回退主会话模型", async () => {
    const { commands } = createHarness();
    const ctx = createContext();
    ctx.modelRegistry.find = () => undefined;
    completeSimple.mockResolvedValue({
      content: [{ type: "text", text: "summary" }],
    });
    const { session } = createFakeSession();
    withAutoAnswer(session);
    createAgentSession.mockResolvedValue({ session });

    await requireCommand(commands, "btw").handler("q", ctx);
    await requireCommand(commands, "btw:summarize").handler("", ctx);

    expect(completeSimple).toHaveBeenCalledWith(
      activeModel,
      expect.anything(),
      {},
    );
  });

  it("历史超过 20 轮时裁掉最老的（capHistory）", async () => {
    const { commands, sendUserMessage } = createHarness();
    const ctx = createContext();
    const { session } = createFakeSession();
    let n = 0;
    session.prompt = vi.fn(async () => {
      session.messages.push(assistantMsg(`answer ${n}`));
      n += 1;
    });
    createAgentSession.mockResolvedValue({ session });

    for (let i = 0; i < MAX_HISTORY_EXCHANGES + 1; i++) {
      await requireCommand(commands, "btw").handler(`question ${i}`, ctx);
    }
    await requireCommand(commands, "btw:inject").handler("", ctx);

    const payload: string = sendUserMessage.mock.calls[0][0];
    const userLines = payload
      .split("\n")
      .filter((line) => line.startsWith("User: "));
    expect(userLines).toHaveLength(MAX_HISTORY_EXCHANGES);
    expect(payload).not.toContain("User: question 0");
    expect(payload).toContain(`User: question ${MAX_HISTORY_EXCHANGES - 1}`);
    expect(payload).toContain(`User: question ${MAX_HISTORY_EXCHANGES}`);
  });
});
