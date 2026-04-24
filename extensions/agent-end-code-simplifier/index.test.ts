import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_END_CODE_SIMPLIFIER_APPROVAL_CHANNEL } from "../shared/internal-events.ts";
import {
  buildCodeSimplifierPrompt,
  collectSupportedPaths,
  DEFAULT_PROMPT_TEMPLATE,
  DEFAULT_SUPPORTED_EXTENSIONS,
  isSupportedCodePath,
  normalizeConfig,
} from "./index.js";

const createMockLogger = () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

const mockExtensionDependencies = (logger = createMockLogger()) => {
  vi.doMock("../shared/logger.ts", () => ({
    createLogger: () => logger,
  }));
  vi.doMock("../shared/settings.ts", () => ({
    loadSettings: () => ({ merged: {} }),
  }));
  return logger;
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("../shared/logger.ts");
  vi.doUnmock("../shared/settings.ts");
});

describe("normalizeConfig", () => {
  it("uses defaults when settings are missing", () => {
    expect(normalizeConfig({})).toEqual({
      enabled: true,
      extensions: [...DEFAULT_SUPPORTED_EXTENSIONS],
      promptTemplate: DEFAULT_PROMPT_TEMPLATE,
    });
  });

  it("merges base and extra extensions", () => {
    const config = normalizeConfig({
      agentEndCodeSimplifier: {
        enabled: false,
        extensions: ["ts", ".py"],
        extraExtensions: [".rb", "ts"],
        promptTemplate: "custom {{files}}",
      },
    });

    expect(config).toEqual({
      enabled: false,
      extensions: [".ts", ".py", ".rb"],
      promptTemplate: "custom {{files}}",
    });
  });
});

describe("isSupportedCodePath", () => {
  it("matches supported extensions case-insensitively", () => {
    expect(isSupportedCodePath("src/App.TS", { extensions: [".ts"] })).toBe(
      true,
    );
    expect(isSupportedCodePath("src/App.md", { extensions: [".ts"] })).toBe(
      false,
    );
  });
});

describe("collectSupportedPaths", () => {
  it("filters non-code files and de-duplicates paths", () => {
    expect(
      collectSupportedPaths(["a.ts", "b.py", "README.md", "a.ts"], {
        extensions: [".ts", ".py"],
      }),
    ).toEqual(["a.ts", "b.py"]);
  });
});

describe("buildCodeSimplifierPrompt", () => {
  it("injects changed file paths as XML into the prompt template", () => {
    expect(
      buildCodeSimplifierPrompt(
        ["a.ts", "src/a&b.ts"],
        "<files>\n{{files}}\n</files>",
      ),
    ).toBe(
      "<files>\n  <file>a.ts</file>\n  <file>src/a&amp;b.ts</file>\n</files>",
    );
  });

  it("uses an XML default prompt payload", () => {
    expect(buildCodeSimplifierPrompt(["a.ts"])).toContain(
      "<code_simplifier_request>",
    );
    expect(buildCodeSimplifierPrompt(["a.ts"])).toContain(
      "  <file>a.ts</file>",
    );
  });

  it("tells automatic code-simplifier follow-ups to inspect full file context", () => {
    const prompt = buildCodeSimplifierPrompt(["a.ts"]);

    expect(prompt).toContain(
      "先遵循 code-simplifier skill 中定义的规则，再遵循以下附加约束",
    );
    expect(prompt).toContain("这是自动后处理任务，不要创建 plan");
    expect(prompt).toContain("读取 modified_files 中每个文件的完整内容");
    expect(prompt).toContain("不要只看 diff 或刚改动的片段");
    expect(prompt).toContain("浅封装/pass-through helper");
  });
});

describe("extension diagnostics", () => {
  it("logs why agent_end skips when UI is unavailable", async () => {
    const logger = mockExtensionDependencies();

    const extension = (await import("./index.ts")).default;
    const handlers = new Map<
      string,
      (event: unknown, ctx: unknown) => unknown
    >();
    extension({
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
        handlers.set(name, handler);
      },
      registerShortcut: vi.fn(),
      events: { emit: vi.fn() },
      sendUserMessage: vi.fn(),
    } as never);

    const ctx = {
      cwd: process.cwd(),
      hasUI: false,
      ui: { confirm: vi.fn() },
    };
    await handlers.get("session_start")?.({}, ctx);
    await handlers.get("tool_result")?.(
      {
        isError: false,
        toolName: "edit",
        input: { path: "extensions/demo.ts" },
      },
      ctx,
    );
    await handlers.get("agent_end")?.({ messages: [] }, ctx);

    expect(logger.debug).toHaveBeenCalledWith(
      "agent_end_skipped_no_ui",
      expect.objectContaining({
        cwd: process.cwd(),
        modifiedPaths: ["extensions/demo.ts"],
      }),
    );
  });

  it("registers Ctrl+Alt+Y to manually trigger code-simplifier", async () => {
    mockExtensionDependencies();

    const extension = (await import("./index.ts")).default;
    const handlers = new Map<
      string,
      (event: unknown, ctx: unknown) => unknown
    >();
    const shortcuts = new Map<string, { handler: (ctx: unknown) => unknown }>();
    const sendUserMessage = vi.fn();

    extension({
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
        handlers.set(name, handler);
      },
      registerShortcut(
        shortcut: string,
        registration: { handler: (ctx: unknown) => unknown },
      ) {
        shortcuts.set(shortcut, registration);
      },
      events: { emit: vi.fn() },
      sendUserMessage,
    } as never);

    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      ui: { confirm: vi.fn(), notify: vi.fn() },
    };

    await handlers.get("session_start")?.({}, ctx);
    await handlers.get("tool_result")?.(
      {
        isError: false,
        toolName: "edit",
        input: { path: "src/manual.ts" },
      },
      ctx,
    );
    await shortcuts.get("ctrl+alt+y")?.handler(ctx);

    expect(sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("src/manual.ts"),
      { deliverAs: "followUp" },
    );
  });

  it("emits a remote approval event and accepts attached remote allow decisions", async () => {
    mockExtensionDependencies();

    const extension = (await import("./index.ts")).default;
    const handlers = new Map<
      string,
      (event: unknown, ctx: unknown) => unknown
    >();
    const events = {
      emit: vi.fn(
        (_channel: string, event: { attachRemoteDecision?: unknown }) => {
          if (typeof event.attachRemoteDecision === "function") {
            event.attachRemoteDecision(Promise.resolve(true));
          }
        },
      ),
    };
    const sendUserMessage = vi.fn();

    extension({
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
        handlers.set(name, handler);
      },
      registerShortcut: vi.fn(),
      events,
      sendUserMessage,
    } as never);

    const localConfirm = new Promise<boolean>(() => undefined);
    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      ui: { confirm: vi.fn(() => localConfirm) },
    };

    await handlers.get("session_start")?.({}, ctx);
    await handlers.get("tool_result")?.(
      {
        isError: false,
        toolName: "write",
        input: { path: "src/demo.ts" },
      },
      ctx,
    );
    await handlers.get("agent_end")?.({ messages: [] }, ctx);

    expect(events.emit).toHaveBeenCalledWith(
      AGENT_END_CODE_SIMPLIFIER_APPROVAL_CHANNEL,
      expect.objectContaining({
        type: "agent-end-code-simplifier.approval",
        filePaths: ["src/demo.ts"],
      }),
    );
    expect(sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("src/demo.ts"),
      { deliverAs: "followUp" },
    );
  });
});
