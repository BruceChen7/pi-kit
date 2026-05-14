import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import cwdHistoryExtension from "./cwd-history.js";

type Handler = (event: unknown, ctx: unknown) => Promise<void> | void;
type EditorHarness = {
  render(width: number): string[];
  setText(text: string): void;
  getText(): string;
  handleInput(data: string): void;
};

type EditorFactory = (
  tui: unknown,
  theme: unknown,
  keybindings: unknown,
) => EditorHarness;

type SessionEntry = {
  type: "message";
  message: {
    role: "user";
    content: Array<{ type: "text"; text: string }>;
    timestamp: number;
  };
};

const STALE_MESSAGE =
  "This extension instance is stale after session replacement or reload. Use the provided replacement-session context instead.";

function userPromptEntry(text: string): SessionEntry {
  return {
    type: "message",
    message: {
      role: "user",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    },
  };
}

function buildPiHarness(options?: {
  throwThemeOnStale?: boolean;
  throwThinkingLevelOnStale?: boolean;
}) {
  const handlers = new Map<string, Handler[]>();
  let stale = false;
  let editorFactory: EditorFactory | undefined;

  const theme = {
    getBashModeBorderColor: vi.fn(
      () => (text: string) => `<bash>${text}</bash>`,
    ),
    getThinkingBorderColor: vi.fn(
      (level: string) => (text: string) =>
        `<thinking:${level}>${text}</thinking:${level}>`,
    ),
  };

  const ui: Record<string, unknown> = {
    setEditorComponent: vi.fn((factory?: EditorFactory) => {
      editorFactory = factory;
    }),
    getEditorText: vi.fn(() => ""),
  };

  Object.defineProperty(ui, "theme", {
    get() {
      if (stale && options?.throwThemeOnStale) {
        throw new Error(STALE_MESSAGE);
      }
      return theme;
    },
  });

  const api = {
    on(event: string, handler: Handler) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
    getThinkingLevel: vi.fn(() => {
      if (stale && options?.throwThinkingLevelOnStale) {
        throw new Error(STALE_MESSAGE);
      }
      return "medium";
    }),
  };

  let branch: unknown[] = [];
  const ctx = {
    hasUI: true,
    cwd: "/repo-cwd-history-test-nonexistent",
    sessionManager: {
      getSessionFile: vi.fn(() => undefined),
      getBranch: vi.fn(() => branch),
    },
    ui,
  };

  const emit = async (event: string) => {
    for (const handler of handlers.get(event) ?? []) {
      await handler({}, ctx);
    }
  };

  const createEditor = () => {
    expect(editorFactory).toBeTypeOf("function");
    if (!editorFactory) {
      throw new Error("Editor factory was not registered");
    }

    return editorFactory(
      {
        requestRender: vi.fn(),
        terminal: { rows: 24 },
      },
      {
        borderColor: (text: string) => text,
        selectList: {},
      },
      {
        matches: vi.fn(() => false),
      },
    );
  };

  return {
    api,
    ctx,
    emit,
    createEditor,
    setBranch(nextBranch: unknown[]) {
      branch = nextBranch;
    },
    makeStale() {
      stale = true;
    },
  };
}

describe("cwd-history extension", () => {
  it("keeps rendering when the old session theme context becomes stale", async () => {
    const harness = buildPiHarness({ throwThemeOnStale: true });

    cwdHistoryExtension(harness.api as ExtensionAPI);
    await harness.emit("session_start");

    const editor = harness.createEditor();
    harness.makeStale();

    expect(() => editor.render(12)).not.toThrow();
    expect(editor.render(12)[0]).toContain("<thinking:medium>");
  });

  it("falls back to the cached thinking border color when thinking-level access becomes stale", async () => {
    const harness = buildPiHarness({ throwThinkingLevelOnStale: true });

    cwdHistoryExtension(harness.api as ExtensionAPI);
    await harness.emit("session_start");

    const editor = harness.createEditor();
    harness.makeStale();

    expect(() => editor.render(12)).not.toThrow();
    expect(editor.render(12)[0]).toContain("<thinking:medium>");
  });

  it("keeps prompts submitted while previous-session history loads", async () => {
    const harness = buildPiHarness();

    cwdHistoryExtension(harness.api as ExtensionAPI);
    await harness.emit("session_start");
    harness.setBranch([userPromptEntry("first prompt after startup")]);

    await vi.waitFor(() => {
      expect(harness.ctx.ui.setEditorComponent).toHaveBeenCalledTimes(2);
    });

    const editor = harness.createEditor();

    editor.handleInput("\x1b[A");

    expect(editor.getText()).toBe("first prompt after startup");
  });
});
