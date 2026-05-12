import { afterEach, describe, expect, it, vi } from "vitest";
import btwExtension from "./index.js";

const streamSimple = vi.hoisted(() => vi.fn());
const completeSimple = vi.hoisted(() => vi.fn());

vi.mock("@earendil-works/pi-ai", () => ({
  streamSimple,
  completeSimple,
}));

type CommandRegistration = {
  description: string;
  handler: (args: string, ctx: TestContext) => Promise<void>;
};

type ShortcutRegistration = {
  description: string;
  handler: (ctx: TestContext) => Promise<void> | void;
};

type SessionEntry = {
  type: string;
  timestamp: string;
  customType?: string;
  data?: unknown;
  message?: unknown;
};

type TestContext = {
  sessionManager: { getBranch: () => SessionEntry[] };
  modelRegistry: {
    find: ReturnType<typeof vi.fn>;
    getApiKeyAndHeaders: ReturnType<typeof vi.fn>;
  };
  model: { provider: string; id: string };
  ui: {
    notify: ReturnType<typeof vi.fn>;
    setWidget: ReturnType<typeof vi.fn>;
  };
};

const activeModel = {
  provider: "openai",
  id: "active-model",
};

const profileModel = {
  provider: "openai",
  id: "gpt-5.3-codex",
};

const fastModel = {
  provider: "google",
  id: "gemini-flash-lite-latest",
};

const emptyUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function createHarness() {
  const commands = new Map<string, CommandRegistration>();
  const shortcuts = new Map<string, ShortcutRegistration>();
  const entries: SessionEntry[] = [];
  const sendUserMessage = vi.fn();

  btwExtension({
    on() {},
    registerCommand(name: string, registration: CommandRegistration) {
      commands.set(name, registration);
    },
    registerShortcut(name: string, registration: ShortcutRegistration) {
      shortcuts.set(name, registration);
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({
        type: "custom",
        timestamp: new Date().toISOString(),
        customType,
        data,
      });
    },
    sendUserMessage,
  } as never);

  return {
    commands,
    shortcuts,
    entries,
    sendUserMessage,
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

function createContext(entries: SessionEntry[] = []): TestContext {
  return {
    sessionManager: { getBranch: () => entries },
    modelRegistry: {
      find: vi.fn((provider: string, id: string) => {
        if (provider === profileModel.provider && id === profileModel.id) {
          return profileModel;
        }
        if (provider === fastModel.provider && id === fastModel.id) {
          return fastModel;
        }
        return undefined;
      }),
      getApiKeyAndHeaders: vi.fn(async () => ({
        ok: true,
        apiKey: "test-key",
        headers: { "x-test": "yes" },
      })),
    },
    model: activeModel,
    ui: {
      notify: vi.fn(),
      setWidget: vi.fn(),
    },
  };
}

async function* streamResponse(answer: string, thinking = "") {
  if (thinking) {
    yield { type: "thinking_delta", delta: thinking };
  }
  yield { type: "text_delta", delta: answer };
}

async function waitForCompletedBtwEntry(entries: SessionEntry[]) {
  await vi.waitFor(() => {
    expect(entries.some((entry) => entry.customType === "btw")).toBe(true);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  streamSimple.mockReset();
  completeSimple.mockReset();
});

describe("btw extension", () => {
  it("registers the side-conversation commands and toggle shortcut", () => {
    const { commands, shortcuts } = createHarness();

    expect([...commands.keys()]).toEqual([
      "btw",
      "btw:new",
      "btw:clear",
      "btw:inject",
      "btw:summarize",
    ]);
    expect(shortcuts.get("ctrl+shift+b")?.description).toContain("btw");
  });

  it("warns instead of starting a side conversation without a question", async () => {
    const { commands } = createHarness();
    const ctx = createContext();

    await requireCommand(commands, "btw").handler("   ", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Usage: /btw <question>",
      "warning",
    );
    expect(streamSimple).not.toHaveBeenCalled();
  });

  it("streams a side answer into hidden session entries without messaging the main agent", async () => {
    streamSimple.mockReturnValue(streamResponse("side answer", "thinking"));
    const { commands, entries, sendUserMessage } = createHarness();
    const ctx = createContext(entries);

    await requireCommand(commands, "btw").handler("what now?", ctx);
    await waitForCompletedBtwEntry(entries);

    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(entries).toContainEqual(
      expect.objectContaining({
        customType: "btw",
        data: {
          question: "what now?",
          thinking: "thinking",
          answer: "side answer",
          model: "strong: openai/gpt-5.3-codex",
        },
      }),
    );
    expect(ctx.ui.setWidget).toHaveBeenCalledWith("btw", expect.any(Function), {
      placement: "aboveEditor",
    });
  });

  it("injects the completed side thread as a follow-up user message and resets it", async () => {
    streamSimple.mockReturnValue(streamResponse("ship it"));
    const { commands, entries, sendUserMessage } = createHarness();
    const ctx = createContext(entries);

    await requireCommand(commands, "btw").handler("ready?", ctx);
    await waitForCompletedBtwEntry(entries);
    await requireCommand(commands, "btw:inject").handler(
      "please implement",
      ctx,
    );

    expect(sendUserMessage).toHaveBeenCalledWith(
      [
        "Here's a side conversation I had. please implement",
        "",
        "<btw-thread>",
        "User: ready?",
        "Assistant: ship it",
        "</btw-thread>",
      ].join("\n"),
      { deliverAs: "followUp" },
    );
    expect(entries.at(-1)).toEqual(
      expect.objectContaining({
        customType: "btw-reset",
        data: { timestamp: expect.any(Number) },
      }),
    );
  });

  it("summarizes the side thread before injecting a follow-up user message", async () => {
    streamSimple.mockReturnValue(streamResponse("decision and context"));
    completeSimple.mockResolvedValue({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hidden" },
        { type: "text", text: "summary only" },
      ],
      api: "test-api",
      provider: "test-provider",
      model: "test-model",
      usage: emptyUsage,
      stopReason: "stop",
      timestamp: Date.now(),
    });
    const { commands, entries, sendUserMessage } = createHarness();
    const ctx = createContext(entries);

    await requireCommand(commands, "btw").handler("what changed?", ctx);
    await waitForCompletedBtwEntry(entries);
    await requireCommand(commands, "btw:summarize").handler("carry this", ctx);

    expect(completeSimple).toHaveBeenCalledWith(
      fastModel,
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            content: [
              expect.objectContaining({
                text: expect.stringContaining(
                  "Assistant: decision and context",
                ),
              }),
            ],
          }),
        ],
      }),
      expect.objectContaining({ apiKey: "test-key", reasoning: "low" }),
    );
    expect(sendUserMessage).toHaveBeenCalledWith(
      [
        "Here's a summary of a side conversation I had. carry this",
        "",
        "<btw-summary>",
        "summary only",
        "</btw-summary>",
      ].join("\n"),
      { deliverAs: "followUp" },
    );
  });
});
