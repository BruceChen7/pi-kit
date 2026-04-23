import { afterEach, describe, expect, it, vi } from "vitest";

import promptCopyExtension from "./index.js";

const STALE_MESSAGE =
  "This extension instance is stale after session replacement or reload. Use the provided replacement-session context instead.";

type TestCtx = {
  hasUI: boolean;
  ui: {
    getEditorText: () => string;
    notify: ReturnType<typeof vi.fn>;
    setStatus: ReturnType<typeof vi.fn>;
  };
};

type ShortcutRegistration = {
  description: string;
  handler: (ctx: TestCtx) => Promise<void> | void;
};

const createCtx = (): TestCtx => ({
  hasUI: true,
  ui: {
    getEditorText: () => "copy this prompt",
    notify: vi.fn(),
    setStatus: vi.fn(),
  },
});

const createFakePi = () => {
  const shortcuts = new Map<string, ShortcutRegistration>();

  return {
    shortcuts,
    api: {
      registerShortcut: vi.fn(
        (shortcut: unknown, registration: ShortcutRegistration) => {
          shortcuts.set(String(shortcut), registration);
        },
      ),
    },
  };
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("prompt-copy", () => {
  it("registers the Ctrl+Shift+Y shortcut", () => {
    const { api, shortcuts } = createFakePi();

    promptCopyExtension(api as never);

    expect(shortcuts.has("ctrl+shift+y")).toBe(true);
    expect(shortcuts.get("ctrl+shift+y")?.description).toContain(
      "Ctrl+Shift+Y",
    );
  });

  it("does not touch stale UI when clearing status after session replacement", async () => {
    vi.useFakeTimers();

    const { api, shortcuts } = createFakePi();
    promptCopyExtension(api as never);

    const handler = shortcuts.get("ctrl+shift+y")?.handler;
    expect(handler).toBeTypeOf("function");
    if (!handler) return;

    const ctx = createCtx();
    ctx.ui.getEditorText = () => "   ";

    let stale = false;
    ctx.ui.setStatus.mockImplementation(() => {
      if (stale) {
        throw new Error(STALE_MESSAGE);
      }
    });

    await expect(Promise.resolve(handler(ctx))).resolves.toBeUndefined();

    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "prompt-copy",
      "Nothing to copy",
    );

    stale = true;
    expect(() => vi.advanceTimersByTime(2_000)).not.toThrow();
  });
});
