// biome-ignore-all lint/style/noNonNullAssertion: tests use ! for brevity
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeEntry, type QueryLogEntry } from "./core.ts";
import extension, { createSessionStore } from "./index.ts";

const mockComplete = vi.hoisted(() => vi.fn());
const storeMocks = vi.hoisted(() => ({
  loadRecentEntries: vi.fn(),
  appendEntry: vi.fn(),
  incrementRepeat: vi.fn(),
  resolveLogDir: vi.fn(() => "/tmp/qnl-test"),
}));
const loggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai/compat", () => ({
  complete: (...args: unknown[]) => mockComplete(...args),
}));

vi.mock("../shared/logger.ts", () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: (...args: unknown[]) => loggerMocks.info(...args),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock("./store.ts", () => storeMocks);

type InputHandler = (
  event: { text: string; source: string },
  ctx: ExtensionContext,
) => Promise<unknown>;
type AgentEndHandler = (event: unknown, ctx: ExtensionContext) => Promise<void>;
type CommandHandler = (
  args: string,
  ctx: ExtensionCommandContext,
) => Promise<void>;

/** 真实 createSessionStore + 方法级 spy，兼作注入的 session 接缝 */
function createHarness() {
  const commands = new Map<string, { handler: CommandHandler }>();
  const handlers = new Map<string, unknown>();
  const store = createSessionStore();
  const storeSpies = {
    add: vi.spyOn(store, "add"),
    drain: vi.spyOn(store, "drain"),
    reset: vi.spyOn(store, "reset"),
  };

  const pi = {
    registerCommand: vi.fn((name: string, reg: { handler: CommandHandler }) => {
      commands.set(name, reg);
    }),
    on: vi.fn((event: string, handler: unknown) => {
      handlers.set(event, handler);
    }),
  } as unknown as ExtensionAPI;

  extension(pi, store);

  return {
    pi,
    commands,
    store: storeSpies,
    getInput: () => handlers.get("input") as InputHandler,
    getAgentEnd: () => handlers.get("agent_end") as AgentEndHandler,
    getSessionStart: () => handlers.get("session_start") as () => void,
  };
}

function createCtx(
  overrides: Partial<ExtensionContext> = {},
): ExtensionContext {
  const hasModel = "model" in overrides;
  const ui = {
    notify: vi.fn(),
    ...((overrides.ui as unknown as Record<string, unknown> | undefined) ?? {}),
  } as unknown as ExtensionContext["ui"];
  return {
    cwd: "/tmp",
    hasUI: overrides.hasUI ?? true,
    mode: "tui",
    model: hasModel ? overrides.model : createModel(),
    modelRegistry: {
      getApiKeyAndHeaders: vi.fn(async () => ({
        ok: true,
        apiKey: "key",
        headers: {},
        env: {},
      })),
      ...((overrides.modelRegistry as unknown as
        | Record<string, unknown>
        | undefined) ?? {}),
    } as unknown as ExtensionContext["modelRegistry"],
    ui,
    ...overrides,
  } as unknown as ExtensionContext;
}

function createModel() {
  return { provider: "p", id: "m" } as unknown as NonNullable<
    ExtensionContext["model"]
  >;
}

beforeEach(() => {
  mockComplete.mockReset();
  storeMocks.loadRecentEntries.mockReset();
  storeMocks.appendEntry.mockReset();
  storeMocks.incrementRepeat.mockReset();
  loggerMocks.info.mockReset();
});

describe("input wiring", () => {
  it("stages /query-notes queries into the session store and continues", async () => {
    const { getInput, store } = createHarness();
    const result = await getInput()!(
      { text: "/query-notes malloc 怎么实现", source: "user" },
      createCtx(),
    );
    expect(result).toEqual({ action: "continue" });
    expect(store.add).toHaveBeenCalledWith("malloc 怎么实现");
  });

  it("accumulates multiple query-notes inputs", async () => {
    const { getInput, store } = createHarness();

    await getInput()!({ text: "/query-notes q1", source: "user" }, createCtx());
    await getInput()!({ text: "/query-notes q2", source: "user" }, createCtx());
    expect(store.add).toHaveBeenNthCalledWith(1, "q1");
    expect(store.add).toHaveBeenNthCalledWith(2, "q2");
  });

  it("ignores non-query-notes input and extension source", async () => {
    const { getInput, store } = createHarness();

    await getInput()!({ text: "hello", source: "user" }, createCtx());
    await getInput()!(
      { text: "/query-notes q1", source: "extension" },
      createCtx(),
    );
    expect(store.add).not.toHaveBeenCalled();
  });

  it("session_start resets the staged queries", async () => {
    const { getInput, getSessionStart, store } = createHarness();
    await getInput()!({ text: "/query-notes q1", source: "user" }, createCtx());

    getSessionStart()!();

    expect(store.reset).toHaveBeenCalled();
    expect(store.drain()).toEqual([]);
  });
});

describe("agent_end wiring", () => {
  it("flushes pending queries as new entries when no duplicate", async () => {
    const { getInput, getAgentEnd } = createHarness();
    storeMocks.loadRecentEntries.mockResolvedValue([]);
    await getInput()!(
      { text: "/query-notes malloc 怎么实现", source: "user" },
      createCtx(),
    );

    await getAgentEnd()!(null, createCtx());

    expect(storeMocks.appendEntry).toHaveBeenCalledTimes(1);
    const entry = storeMocks.appendEntry.mock.calls[0][1] as QueryLogEntry;
    expect(entry.q).toBe("malloc 怎么实现");
    expect(entry.repeats).toBe(1);
    expect(storeMocks.incrementRepeat).not.toHaveBeenCalled();
  });

  it("increments repeats when a near-identical query already exists", async () => {
    const { getInput, getAgentEnd } = createHarness();
    const existing = makeEntry("malloc 怎么实现", Date.now() - 1000);
    storeMocks.loadRecentEntries.mockResolvedValue([existing]);
    await getInput()!(
      { text: "/query-notes malloc 怎么实现", source: "user" },
      createCtx(),
    );

    await getAgentEnd()!(null, createCtx());

    expect(storeMocks.incrementRepeat).toHaveBeenCalledWith(
      expect.anything(),
      existing,
    );
    expect(storeMocks.appendEntry).not.toHaveBeenCalled();
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it("records as a new entry without a session model (maybe band, no LLM)", async () => {
    const { getInput, getAgentEnd } = createHarness();
    const existing = makeEntry("malloc 怎么实现", Date.now() - 1000);
    storeMocks.loadRecentEntries.mockResolvedValue([existing]);
    await getInput()!(
      { text: "/query-notes malloc 是怎么实现的呢", source: "user" },
      createCtx(),
    );

    await getAgentEnd()!(
      null,
      createCtx({ model: undefined } as Partial<ExtensionContext>),
    );

    expect(mockComplete).not.toHaveBeenCalled();
    expect(storeMocks.appendEntry).toHaveBeenCalledTimes(1);
    expect(storeMocks.incrementRepeat).not.toHaveBeenCalled();
  });

  it("keeps recording on store failures without throwing", async () => {
    const { getInput, getAgentEnd } = createHarness();
    storeMocks.loadRecentEntries.mockRejectedValue(new Error("disk error"));
    await getInput()!({ text: "/query-notes q1", source: "user" }, createCtx());

    await expect(getAgentEnd()!(null, createCtx())).resolves.toBeUndefined();
    expect(storeMocks.appendEntry).not.toHaveBeenCalled();
  });
});

describe("query-recent-notes-log command", () => {
  it("renders recent entries with repeat counts via notify", async () => {
    const { commands } = createHarness();
    const entries: QueryLogEntry[] = [
      {
        id: "1",
        ts: Date.parse("2026-09-08T10:30:00"),
        q: "malloc 怎么实现",
        repeats: 2,
      },
      {
        id: "2",
        ts: Date.parse("2026-09-08T09:00:00"),
        q: "eBPF 观测",
        repeats: 1,
      },
    ];
    storeMocks.loadRecentEntries.mockResolvedValue(entries);
    const ctx = createCtx();

    const handler = commands.get("query-recent-notes-log")!.handler;
    await handler("", ctx as unknown as ExtensionCommandContext);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("[x2] malloc 怎么实现"),
      "info",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("eBPF 观测"),
      "info",
    );
  });

  it("shows a placeholder when the log is empty", async () => {
    const { commands } = createHarness();
    storeMocks.loadRecentEntries.mockResolvedValue([]);
    const ctx = createCtx();

    await commands
      .get("query-recent-notes-log")!
      .handler("", ctx as unknown as ExtensionCommandContext);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "(no queries logged yet)",
      "info",
    );
  });

  it("falls back to shared logger output without UI", async () => {
    const { commands } = createHarness();
    storeMocks.loadRecentEntries.mockResolvedValue([
      {
        id: "1",
        ts: Date.parse("2026-09-08T10:30:00"),
        q: "malloc 怎么实现",
        repeats: 1,
      },
    ]);
    const ctx = createCtx({ hasUI: false });

    await commands
      .get("query-recent-notes-log")!
      .handler("", ctx as unknown as ExtensionCommandContext);
    expect(loggerMocks.info).toHaveBeenCalledWith(
      expect.stringContaining("malloc 怎么实现"),
    );
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });
});
