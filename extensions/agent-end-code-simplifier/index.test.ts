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

const mockExtensionDependencies = (
  logger = createMockLogger(),
  settings: Record<string, unknown> = {},
  updateSettings = vi.fn(),
) => {
  vi.doMock("../shared/logger.ts", () => ({
    createLogger: () => logger,
  }));
  vi.doMock("../shared/settings.ts", () => ({
    loadSettings: () => ({ merged: settings }),
    updateSettings,
  }));
  return logger;
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("../shared/logger.ts");
  vi.doUnmock("../shared/settings.ts");
});

type Handler = (event: unknown, ctx: unknown) => unknown;
type ShortcutRegistration = { handler: (ctx: unknown) => unknown };
type CommandRegistration = {
  handler: (args: string, ctx: unknown) => unknown;
};

type ExtensionHarnessOptions = {
  events?: { emit: ReturnType<typeof vi.fn> };
  registerShortcut?: (
    shortcut: string,
    registration: ShortcutRegistration,
  ) => void;
  registerCommand?: (name: string, registration: CommandRegistration) => void;
  sendUserMessage?: ReturnType<typeof vi.fn>;
};

const createExtensionHarness = async (
  options: ExtensionHarnessOptions = {},
) => {
  const extension = (await import("./index.ts")).default;
  const handlers = new Map<string, Handler>();
  const shortcuts = new Map<string, ShortcutRegistration>();
  const commands = new Map<string, CommandRegistration>();
  const events = options.events ?? { emit: vi.fn() };
  const sendUserMessage = options.sendUserMessage ?? vi.fn();
  const registerShortcut =
    options.registerShortcut ??
    ((shortcut: string, registration: ShortcutRegistration) => {
      shortcuts.set(shortcut, registration);
    });
  const registerCommand =
    options.registerCommand ??
    ((name: string, registration: CommandRegistration) => {
      commands.set(name, registration);
    });

  extension({
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
    registerShortcut,
    registerCommand,
    events,
    sendUserMessage,
  } as never);

  return { handlers, shortcuts, commands, events, sendUserMessage };
};

describe("normalizeConfig", () => {
  it("uses defaults when settings are missing", () => {
    expect(normalizeConfig({})).toEqual({
      enabled: true,
      extensions: [...DEFAULT_SUPPORTED_EXTENSIONS],
      promptTemplate: DEFAULT_PROMPT_TEMPLATE,
      abortBehavior: "skip",
      autoRun: true,
      confirmBeforeRun: false,
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
      abortBehavior: "skip",
      autoRun: true,
      confirmBeforeRun: false,
    });
  });

  it("normalizes automatic run and confirmation behavior", () => {
    const config = normalizeConfig({
      agentEndCodeSimplifier: {
        autoRun: false,
        confirmBeforeRun: true,
      },
    });

    expect(config.autoRun).toBe(false);
    expect(config.confirmBeforeRun).toBe(true);
  });

  it("normalizes abort behavior", () => {
    expect(
      normalizeConfig({
        agentEndCodeSimplifier: { abortBehavior: "confirm" },
      }).abortBehavior,
    ).toBe("confirm");

    expect(
      normalizeConfig({
        agentEndCodeSimplifier: { abortBehavior: "invalid" },
      }).abortBehavior,
    ).toBe("skip");
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
    const prompt = buildCodeSimplifierPrompt(["a.ts"]);

    expect(prompt).toContain("<code_simplifier_request>");
    expect(prompt).toContain("  <file>a.ts</file>");
  });

  it("tells automatic me-code-simplifier follow-ups to inspect full file context", () => {
    const prompt = buildCodeSimplifierPrompt(["a.ts"]);
    const expectedFragments = [
      "先遵循 me-code-simplifier、software-design-philosophy 与 push-ifs-up-fors-down skills 中定义的规则",
      "这是自动后处理任务，不要创建 plan",
      "读取 modified_files 中每个文件的完整内容",
      "不要只看 diff 或刚改动的片段",
      "change amplification",
      "deep module",
      "information leakage",
      "temporal decomposition",
      "浅封装/pass-through helper",
      "push ifs up and fors down",
      "集中分支决策",
      "批量处理",
    ];

    for (const fragment of expectedFragments) {
      expect(prompt).toContain(fragment);
    }
  });
});

describe("extension diagnostics", () => {
  it("logs why agent_end skips when UI is unavailable", async () => {
    const logger = mockExtensionDependencies();

    const { handlers } = await createExtensionHarness();

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

  it("registers Ctrl+Alt+Y to manually trigger me-code-simplifier", async () => {
    mockExtensionDependencies();

    const { handlers, shortcuts, sendUserMessage } =
      await createExtensionHarness();

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

  it("automatically runs me-code-simplifier by default without confirmation", async () => {
    mockExtensionDependencies();

    const { handlers, events, sendUserMessage } =
      await createExtensionHarness();

    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      ui: { confirm: vi.fn(async () => false), notify: vi.fn() },
    };

    await handlers.get("session_start")?.({}, ctx);
    await handlers.get("tool_result")?.(
      {
        isError: false,
        toolName: "edit",
        input: { path: "src/auto.ts" },
      },
      ctx,
    );
    await handlers.get("agent_end")?.({ messages: [] }, ctx);

    expect(ctx.ui.confirm).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
    expect(sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("src/auto.ts"),
      { deliverAs: "followUp" },
    );
  });

  it("skips automatic simplifier approval after an aborted turn by default", async () => {
    mockExtensionDependencies();

    const { handlers, events, sendUserMessage } =
      await createExtensionHarness();

    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      signal: AbortSignal.abort(),
      ui: { confirm: vi.fn(), notify: vi.fn() },
    };

    await handlers.get("session_start")?.({}, ctx);
    await handlers.get("tool_result")?.(
      {
        isError: false,
        toolName: "edit",
        input: { path: "src/aborted.ts" },
      },
      ctx,
    );
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            stopReason: "aborted",
          },
        ],
      },
      ctx,
    );

    expect(ctx.ui.confirm).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Skipped me-code-simplifier"),
      "info",
    );
  });

  it("can confirm automatic simplifier approval after an aborted turn when configured", async () => {
    mockExtensionDependencies(createMockLogger(), {
      agentEndCodeSimplifier: {
        abortBehavior: "confirm",
        confirmBeforeRun: true,
      },
    });

    const { handlers, sendUserMessage } = await createExtensionHarness();

    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      signal: AbortSignal.abort(),
      ui: { confirm: vi.fn(async () => true), notify: vi.fn() },
    };

    await handlers.get("session_start")?.({}, ctx);
    await handlers.get("tool_result")?.(
      {
        isError: false,
        toolName: "edit",
        input: { path: "src/aborted-confirm.ts" },
      },
      ctx,
    );
    await handlers.get("agent_end")?.(
      {
        messages: [{ role: "assistant", stopReason: "aborted" }],
      },
      ctx,
    );

    expect(ctx.ui.confirm).toHaveBeenCalledWith(
      "Run me-code-simplifier?",
      expect.stringContaining("src/aborted-confirm.ts"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("src/aborted-confirm.ts"),
      { deliverAs: "followUp" },
    );
  });

  it("keeps manually triggering simplifier for tracked files after an aborted turn", async () => {
    mockExtensionDependencies();

    const { handlers, shortcuts, sendUserMessage } =
      await createExtensionHarness();

    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      signal: AbortSignal.abort(),
      ui: { confirm: vi.fn(), notify: vi.fn() },
    };

    await handlers.get("session_start")?.({}, ctx);
    await handlers.get("tool_result")?.(
      {
        isError: false,
        toolName: "write",
        input: { path: "src/manual-after-abort.ts" },
      },
      ctx,
    );
    await handlers.get("agent_end")?.(
      {
        messages: [{ role: "assistant", stopReason: "aborted" }],
      },
      ctx,
    );
    await shortcuts.get("ctrl+alt+y")?.handler(ctx);

    expect(sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("src/manual-after-abort.ts"),
      { deliverAs: "followUp" },
    );
  });

  it("skips automatic runs while keeping the manual shortcut available", async () => {
    mockExtensionDependencies(createMockLogger(), {
      agentEndCodeSimplifier: {
        autoRun: false,
      },
    });

    const { handlers, shortcuts, sendUserMessage } =
      await createExtensionHarness();

    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      ui: { confirm: vi.fn(), notify: vi.fn() },
    };

    await handlers.get("session_start")?.({}, ctx);
    await handlers.get("tool_result")?.(
      {
        isError: false,
        toolName: "write",
        input: { path: "src/auto-disabled.ts" },
      },
      ctx,
    );
    await handlers.get("agent_end")?.({ messages: [] }, ctx);
    await shortcuts.get("ctrl+alt+y")?.handler(ctx);

    expect(ctx.ui.confirm).not.toHaveBeenCalled();
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("src/auto-disabled.ts"),
      { deliverAs: "followUp" },
    );
  });

  it("registers commands to toggle automatic runs and confirmation prompts", async () => {
    const logger = createMockLogger();
    const updateSettings = vi.fn(
      (
        _cwd: string,
        _scope: "project" | "global",
        updater: (settings: Record<string, unknown>) => Record<string, unknown>,
      ) => {
        const settings = updater({
          agentEndCodeSimplifier: {
            autoRun: true,
            confirmBeforeRun: false,
          },
        });
        return { path: "/repo/.pi/third_extension_settings.json", settings };
      },
    );

    mockExtensionDependencies(
      logger,
      {
        agentEndCodeSimplifier: {
          autoRun: true,
          confirmBeforeRun: false,
        },
      },
      updateSettings,
    );

    const { commands } = await createExtensionHarness();
    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      ui: { notify: vi.fn() },
    };

    await commands.get("agent-end-code-simplifier-auto")?.handler("off", ctx);
    await commands.get("agent-end-code-simplifier-confirm")?.handler("on", ctx);

    expect(updateSettings).toHaveBeenCalledTimes(2);
    expect(updateSettings.mock.results[0]?.value.settings).toMatchObject({
      agentEndCodeSimplifier: { autoRun: false },
    });
    expect(updateSettings.mock.results[1]?.value.settings).toMatchObject({
      agentEndCodeSimplifier: { confirmBeforeRun: true },
    });
    expect(ctx.ui.notify).toHaveBeenCalledTimes(2);
  });

  it("closes local confirmation when an attached remote allow decision wins", async () => {
    mockExtensionDependencies(createMockLogger(), {
      agentEndCodeSimplifier: {
        confirmBeforeRun: true,
      },
    });

    const events = {
      emit: vi.fn(
        (_channel: string, event: { attachRemoteDecision?: unknown }) => {
          if (typeof event.attachRemoteDecision === "function") {
            event.attachRemoteDecision(Promise.resolve(true));
          }
        },
      ),
    };
    const { handlers, sendUserMessage } = await createExtensionHarness({
      events,
    });

    let abortSignal: AbortSignal | undefined;
    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      ui: {
        confirm: vi.fn(
          async (
            _title: string,
            _body: string,
            options?: { signal?: AbortSignal },
          ) => {
            abortSignal = options?.signal;
            return await new Promise<boolean>((resolve) => {
              options?.signal?.addEventListener("abort", () => resolve(false));
            });
          },
        ),
      },
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
    expect(ctx.ui.confirm).toHaveBeenCalledWith(
      "Run me-code-simplifier?",
      expect.stringContaining("src/demo.ts"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(abortSignal?.aborted).toBe(true);
    expect(sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("src/demo.ts"),
      { deliverAs: "followUp" },
    );
  });
});
