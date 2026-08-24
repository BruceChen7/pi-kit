// biome-ignore-all lint/style/noNonNullAssertion: tests use ! for brevity
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockComplete = vi.fn();

vi.mock("@earendil-works/pi-ai/compat", () => ({
  complete: (...args: unknown[]) => mockComplete(...args),
}));

const mocks = vi.hoisted(() => ({
  BorderedLoader: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<
    typeof import("@earendil-works/pi-coding-agent")
  >("@earendil-works/pi-coding-agent");
  return {
    ...actual,
    BorderedLoader: mocks.BorderedLoader,
  };
});

import extension, {
  __getLastBeforeForTest,
  __resetLastBeforeForTest,
} from "./index.ts";

type CommandHandler = (
  args: string,
  ctx: ExtensionCommandContext,
) => Promise<void>;

type InputHandler = (
  event: { text: string; source: string },
  ctx: ExtensionContext,
) => Promise<{ action: "continue" | "handled" }>;

function createExtensionHarness() {
  const commands = new Map<string, { handler: CommandHandler }>();
  let inputHandler: InputHandler | null = null;

  const pi = {
    registerCommand: vi.fn((name: string, reg: { handler: CommandHandler }) => {
      commands.set(name, reg);
    }),
    on: vi.fn((event: string, handler: InputHandler) => {
      if (event === "input") inputHandler = handler;
    }),
  } as unknown as ExtensionAPI;

  extension(pi);

  return { pi, commands, getInputHandler: () => inputHandler };
}

function createModel() {
  return {
    provider: "test-provider",
    id: "test-model",
  } as unknown as ExtensionContext["model"];
}

function createCtx(
  overrides: Partial<ExtensionContext> = {},
): ExtensionContext {
  const model = overrides.model !== undefined ? overrides.model : createModel();
  const ui = {
    notify: vi.fn(),
    setEditorText: vi.fn(),
    getEditorText: vi.fn(() => "prev editor text"),
    custom: vi.fn(),
    ...((overrides.ui as unknown as Record<string, unknown> | undefined) ?? {}),
  } as unknown as ExtensionContext["ui"];

  return {
    cwd: "/tmp",
    hasUI: overrides.hasUI ?? true,
    mode: (overrides.mode as string) ?? "default",
    model,
    modelRegistry: {
      find: vi.fn(),
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

function mockCompleteResponse(text: string) {
  mockComplete.mockResolvedValue({
    stopReason: "stop" as const,
    content: [{ type: "text" as const, text }],
  });
}

beforeEach(() => {
  mockComplete.mockReset();
  mocks.BorderedLoader.mockReset();
  __resetLastBeforeForTest();
  // default loader mock: constructible
  mocks.BorderedLoader.mockImplementation(function (
    this: unknown,
    _tui: unknown,
    _theme: unknown,
    _message: unknown,
  ) {
    const self = this as Record<string, unknown>;
    self.signal = new AbortController().signal;
    self.dispose = () => {};
    return self;
  });
});

describe("prompt-clarify commands", () => {
  it("rewrites /clarify <idea> and writes to editor, storing lastBefore", async () => {
    const { commands } = createExtensionHarness();
    const ctx = createCtx();
    mockCompleteResponse("precise prompt");

    const handler = commands.get("clarify")!.handler;
    await handler(
      "make the cards not jump when I drag them",
      ctx as unknown as ExtensionCommandContext,
    );

    expect(mockComplete).toHaveBeenCalledTimes(1);
    expect(ctx.ui.setEditorText).toHaveBeenCalledWith("precise prompt");
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Rewrite ready"),
      "info",
    );
    expect(__getLastBeforeForTest()).toBe("prev editor text");
  });

  it("alias /prompt-clarify works same as /clarify", async () => {
    const { commands } = createExtensionHarness();
    const ctx = createCtx();
    mockCompleteResponse("alias result");

    const handler = commands.get("prompt-clarify")!.handler;
    await handler("hello", ctx as unknown as ExtensionCommandContext);

    expect(mockComplete).toHaveBeenCalledTimes(1);
    expect(ctx.ui.setEditorText).toHaveBeenCalledWith("alias result");
  });

  it("uses editor text when /clarify has no args", async () => {
    const { commands } = createExtensionHarness();
    const ctx = createCtx({
      ui: {
        notify: vi.fn(),
        setEditorText: vi.fn(),
        getEditorText: vi.fn(() => "editor rough idea"),
        custom: vi.fn(),
      } as unknown as ExtensionContext["ui"],
    } as unknown as Partial<ExtensionContext>);

    mockCompleteResponse("from editor");

    const handler = commands.get("clarify")!.handler;
    await handler("", ctx as unknown as ExtensionCommandContext);

    expect(mockComplete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({ text: "editor rough idea" }),
            ]),
          }),
        ]),
      }),
      expect.anything(),
    );
    expect(ctx.ui.setEditorText).toHaveBeenCalledWith("from editor");
  });

  it("warns when /clarify has no args and editor is empty", async () => {
    const { commands } = createExtensionHarness();
    const ctx = createCtx({
      ui: {
        notify: vi.fn(),
        setEditorText: vi.fn(),
        getEditorText: vi.fn(() => "   "),
        custom: vi.fn(),
      } as unknown as ExtensionContext["ui"],
    } as unknown as Partial<ExtensionContext>);

    const handler = commands.get("clarify")!.handler;
    await handler("", ctx as unknown as ExtensionCommandContext);

    expect(mockComplete).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Usage:"),
      "warning",
    );
  });

  it("reverts last rewrite via /clarify revert", async () => {
    const { commands } = createExtensionHarness();
    const ctx = createCtx();
    mockCompleteResponse("new text");

    const handler = commands.get("clarify")!.handler;
    await handler("idea", ctx as unknown as ExtensionCommandContext);
    expect(__getLastBeforeForTest()).toBe("prev editor text");

    // second ctx for revert, same ui mock will capture setEditorText
    const revertCtx = createCtx({
      ui: ctx.ui,
    });
    await handler("revert", revertCtx as unknown as ExtensionCommandContext);

    expect(revertCtx.ui.setEditorText).toHaveBeenCalledWith("prev editor text");
    expect(revertCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Reverted"),
      "info",
    );
    expect(__getLastBeforeForTest()).toBe(null);
  });

  it("revert via alias /prompt-clarify revert also works", async () => {
    const { commands } = createExtensionHarness();
    const ctx = createCtx();
    mockCompleteResponse("x");
    await commands
      .get("clarify")!
      .handler("idea", ctx as unknown as ExtensionCommandContext);

    const aliasHandler = commands.get("prompt-clarify")!.handler;
    const revertCtx = createCtx({ ui: ctx.ui });
    await aliasHandler(
      "revert",
      revertCtx as unknown as ExtensionCommandContext,
    );
    expect(revertCtx.ui.setEditorText).toHaveBeenCalledWith("prev editor text");
  });

  it("revert warns Nothing to revert when no history", async () => {
    const { commands } = createExtensionHarness();
    const ctx = createCtx();
    await commands
      .get("clarify")!
      .handler("revert", ctx as unknown as ExtensionCommandContext);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Nothing to revert"),
      "warning",
    );
  });

  it("revert is case-insensitive", async () => {
    const { commands } = createExtensionHarness();
    const ctx = createCtx();
    mockCompleteResponse("x");
    await commands
      .get("clarify")!
      .handler("idea", ctx as unknown as ExtensionCommandContext);
    const revertCtx = createCtx({ ui: ctx.ui });
    await commands
      .get("clarify")!
      .handler("Revert", revertCtx as unknown as ExtensionCommandContext);
    expect(revertCtx.ui.setEditorText).toHaveBeenCalledWith("prev editor text");
  });

  it("headless fallback notifies rewritten when no setEditorText", async () => {
    const { commands } = createExtensionHarness();
    const ctx = createCtx({
      ui: {
        notify: vi.fn(),
        custom: vi.fn(),
      } as unknown as ExtensionContext["ui"],
    } as unknown as Partial<ExtensionContext>);
    mockCompleteResponse("fallback text");
    // remove setEditorText to trigger fallback
    delete (ctx.ui as unknown as Record<string, unknown>).setEditorText;

    await commands
      .get("clarify")!
      .handler("idea", ctx as unknown as ExtensionCommandContext);
    expect(ctx.ui.notify).toHaveBeenCalledWith("fallback text", "info");
  });

  it("notifies when no session model", async () => {
    const { commands } = createExtensionHarness();
    const ctx = createCtx({
      model: null,
    } as unknown as Partial<ExtensionContext>);
    await commands
      .get("clarify")!
      .handler("idea", ctx as unknown as ExtensionCommandContext);
    expect(mockComplete).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("No model"),
      "error",
    );
    // putRewrite then notifies Cancelled
    expect(ctx.ui.notify).toHaveBeenCalledWith("Cancelled", "info");
  });
});

describe("prompt-clarify input marker", () => {
  it("intercepts -clarify marker and writes rewrite, returns handled", async () => {
    const { getInputHandler } = createExtensionHarness();
    const handler = getInputHandler()!;
    const ctx = createCtx();
    mockCompleteResponse("marker rewritten");

    const result = await handler(
      { text: "make cards smooth -clarify", source: "user" },
      ctx,
    );
    expect(result).toEqual({ action: "handled" });
    expect(mockComplete).toHaveBeenCalledTimes(1);
    expect(ctx.ui.setEditorText).toHaveBeenCalledWith("marker rewritten");
  });

  it("intercepts -prompt-clarify alias marker", async () => {
    const { getInputHandler } = createExtensionHarness();
    const handler = getInputHandler()!;
    const ctx = createCtx();
    mockCompleteResponse("alias marker");

    const result = await handler(
      { text: "hello -prompt-clarify", source: "user" },
      ctx,
    );
    expect(result).toEqual({ action: "handled" });
    expect(mockComplete).toHaveBeenCalledTimes(1);
  });

  it("ignores pre-clarify and continues", async () => {
    const { getInputHandler } = createExtensionHarness();
    const handler = getInputHandler()!;
    const ctx = createCtx();

    const result = await handler(
      { text: "pre-clarify this", source: "user" },
      ctx,
    );
    expect(result).toEqual({ action: "continue" });
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it("ignores source=extension", async () => {
    const { getInputHandler } = createExtensionHarness();
    const handler = getInputHandler()!;
    const ctx = createCtx();

    const result = await handler(
      { text: "hello -clarify", source: "extension" },
      ctx,
    );
    expect(result).toEqual({ action: "continue" });
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it("handles marker with no rough -> warns USAGE and handled", async () => {
    const { getInputHandler } = createExtensionHarness();
    const handler = getInputHandler()!;
    const ctx = createCtx();

    const result = await handler({ text: "-clarify", source: "user" }, ctx);
    expect(result).toEqual({ action: "handled" });
    expect(mockComplete).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Usage:"),
      "warning",
    );
  });

  it("handles marker with only spaces after stripping", async () => {
    const { getInputHandler } = createExtensionHarness();
    const handler = getInputHandler()!;
    const ctx = createCtx();

    const result = await handler(
      { text: "   -prompt-clarify   ", source: "user" },
      ctx,
    );
    expect(result).toEqual({ action: "handled" });
    expect(mockComplete).not.toHaveBeenCalled();
  });
});

describe("callModel edge cases", () => {
  it("aborted response results in Cancelled", async () => {
    const { commands } = createExtensionHarness();
    const ctx = createCtx();
    mockComplete.mockResolvedValue({ stopReason: "aborted", content: [] });

    await commands
      .get("clarify")!
      .handler("idea", ctx as unknown as ExtensionCommandContext);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Cancelled", "info");
  });

  it("empty text response notifies error then Cancelled", async () => {
    const { commands } = createExtensionHarness();
    const ctx = createCtx();
    mockComplete.mockResolvedValue({
      stopReason: "stop",
      content: [{ type: "text", text: "   " }],
    });

    await commands
      .get("clarify")!
      .handler("idea", ctx as unknown as ExtensionCommandContext);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Clarify returned empty text"),
      "error",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith("Cancelled", "info");
  });

  it("apiKey missing notifies error then Cancelled", async () => {
    const { commands } = createExtensionHarness();
    const ctx = createCtx({
      modelRegistry: {
        find: vi.fn(),
        getApiKeyAndHeaders: vi.fn(async () => ({
          ok: false,
          error: "no key",
        })),
      },
    } as unknown as Partial<ExtensionContext>);
    // need model present
    (ctx as unknown as Record<string, unknown>).model = createModel();

    await commands
      .get("clarify")!
      .handler("idea", ctx as unknown as ExtensionCommandContext);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("no key"),
      "error",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith("Cancelled", "info");
  });

  it("TUI loader path uses BorderedLoader and resolves", async () => {
    const { commands } = createExtensionHarness();
    const custom = vi.fn(
      async (
        factory: (
          tui: unknown,
          theme: unknown,
          kb: unknown,
          done: (v: unknown) => void,
        ) => unknown,
      ) => {
        return new Promise<unknown>((resolve) => {
          const loader = factory(
            { requestRender() {} },
            {
              fg(_c: string, t: string) {
                return t;
              },
            },
            {},
            (v: unknown) => resolve(v),
          );
          // factory internally does void run() which will call done -> resolve
          // loader is returned but we already wired resolve
          void loader;
        });
      },
    );
    const ctx = createCtx({
      mode: "tui",
      hasUI: true,
      ui: {
        notify: vi.fn(),
        setEditorText: vi.fn(),
        getEditorText: vi.fn(() => "prev"),
        custom,
      },
    } as unknown as Partial<ExtensionContext>);
    mockCompleteResponse("tui result");

    await commands
      .get("clarify")!
      .handler("idea", ctx as unknown as ExtensionCommandContext);
    expect(custom).toHaveBeenCalledTimes(1);
    expect(mocks.BorderedLoader).toHaveBeenCalledTimes(1);
    expect(ctx.ui.setEditorText).toHaveBeenCalledWith("tui result");
  });
});
