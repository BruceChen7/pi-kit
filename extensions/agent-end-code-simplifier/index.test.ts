import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_END_CODE_SIMPLIFIER_APPROVAL_CHANNEL } from "../shared/internal-events.ts";
import {
  buildCodeSimplifierPrompt,
  collectSupportedPaths,
  collectToolResultPaths,
  consumeSuppressedAgentEnd,
  containsAbortedMessage,
  containsAutoTriggerMarker,
  createAgentEndCodeSimplifierLifecycleState,
  DEFAULT_PROMPT_TEMPLATE,
  DEFAULT_SUPPORTED_EXTENSIONS,
  decideAgentEndSimplifierAction,
  decideInputLifecycleTransition,
  extractAutoTriggerRunId,
  isSupportedCodePath,
  lastUserMessageLooksAutoTriggered,
  normalizeConfig,
  resetLifecycleForAgentStart,
  resetLifecycleForNewSession,
  startSimplifierRun,
  trackModifiedPaths,
  turnWasAborted,
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
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("../shared/logger.ts");
  vi.doUnmock("../shared/settings.ts");
  vi.doUnmock("../shared/git.ts");
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
  sendMessage?: ReturnType<typeof vi.fn>;
  sendUserMessage?: ReturnType<typeof vi.fn>;
};

type BasicTestContext = {
  cwd: string;
  hasUI: true;
  signal?: AbortSignal;
  ui: {
    confirm: ReturnType<typeof vi.fn>;
    notify: ReturnType<typeof vi.fn>;
  };
};

type WidgetTestContext = {
  cwd: string;
  hasUI: true;
  isIdle?: ReturnType<typeof vi.fn>;
  ui: BasicTestContext["ui"] & {
    setWidget: ReturnType<typeof vi.fn>;
  };
};

const RUNNING_WIDGET_KEY = "agent-end-code-simplifier";

const createBasicTestContext = ({
  cwd = process.cwd(),
  signal,
}: {
  cwd?: string;
  signal?: AbortSignal;
} = {}): BasicTestContext => ({
  cwd,
  hasUI: true,
  ...(signal ? { signal } : {}),
  ui: { confirm: vi.fn(), notify: vi.fn() },
});

const createWidgetTestContext = ({
  isIdle,
}: {
  isIdle?: ReturnType<typeof vi.fn>;
} = {}): WidgetTestContext => ({
  cwd: process.cwd(),
  hasUI: true,
  ...(isIdle ? { isIdle } : {}),
  ui: {
    confirm: vi.fn(),
    notify: vi.fn(),
    setWidget: vi.fn(),
  },
});

const expectRunningWidgetShown = (ctx: WidgetTestContext): void => {
  expect(ctx.ui.setWidget).toHaveBeenCalledWith(RUNNING_WIDGET_KEY, [
    expect.stringContaining("me-code-simplifier running"),
  ]);
};

const expectRunningWidgetCleared = (ctx: WidgetTestContext): void => {
  expect(ctx.ui.setWidget).toHaveBeenCalledWith(RUNNING_WIDGET_KEY, undefined);
};

type PromptSendMocks = {
  sendMessage: ReturnType<typeof vi.fn>;
  sendUserMessage: ReturnType<typeof vi.fn>;
};

const expectSimplifierPromptSent = (
  mocks: PromptSendMocks,
  filePath: string,
): void => {
  expect(mocks.sendMessage).not.toHaveBeenCalled();
  expect(mocks.sendUserMessage).toHaveBeenCalledWith(
    expect.stringContaining(filePath),
  );
};

const flushDeferredSimplifierPrompt = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

const trackSuccessfulToolResult = async (
  handlers: Map<string, Handler>,
  input: Record<string, unknown>,
  ctx: unknown,
  toolName = "edit",
): Promise<void> => {
  await handlers.get("tool_result")?.(
    {
      isError: false,
      toolName,
      input,
    },
    ctx,
  );
};

const createExtensionHarness = async (
  options: ExtensionHarnessOptions = {},
) => {
  const extension = (await import("./index.ts")).default;
  const handlers = new Map<string, Handler>();
  const shortcuts = new Map<string, ShortcutRegistration>();
  const commands = new Map<string, CommandRegistration>();
  const events = options.events ?? { emit: vi.fn() };
  const sendMessage = options.sendMessage ?? vi.fn();
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
    sendMessage,
    sendUserMessage,
  } as never);

  return {
    handlers,
    shortcuts,
    commands,
    events,
    sendMessage,
    sendUserMessage,
  };
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
      skipExtensionPrompts: true,
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
      skipExtensionPrompts: true,
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

  it("normalizes extension-origin prompt skipping", () => {
    expect(normalizeConfig({}).skipExtensionPrompts).toBe(true);
    expect(
      normalizeConfig({
        agentEndCodeSimplifier: { skipExtensionPrompts: false },
      }).skipExtensionPrompts,
    ).toBe(false);
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

  it("supports common language extensions by default", () => {
    const config = { extensions: [...DEFAULT_SUPPORTED_EXTENSIONS] };

    expect(isSupportedCodePath("src/main.cpp", config)).toBe(true);
    expect(isSupportedCodePath("src/Main.java", config)).toBe(true);
    expect(isSupportedCodePath("src/app.rb", config)).toBe(true);
    expect(isSupportedCodePath("src/plugin.lua", config)).toBe(true);
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

describe("collectToolResultPaths", () => {
  it.each([
    [
      "single edit path",
      { isError: false, toolName: "edit", input: { path: "src/a.ts" } },
      ["src/a.ts"],
    ],
    [
      "multi edit input",
      {
        isError: false,
        toolName: "edit",
        input: {
          multi: [
            { path: "src/multi-a.ts", oldText: "a", newText: "b" },
            { path: "src/multi-b.py", oldText: "a", newText: "b" },
          ],
        },
      },
      ["src/multi-a.ts", "src/multi-b.py"],
    ],
    [
      "Codex patch with final-content files only",
      {
        isError: false,
        toolName: "edit",
        input: {
          patch: [
            "*** Begin Patch",
            "*** Update File: src/patched.ts",
            "*** Add File: src/added.ts",
            "*** Delete File: src/deleted.ts",
            "*** End Patch",
          ].join("\n"),
        },
      },
      ["src/patched.ts", "src/added.ts"],
    ],
    [
      "errored tool result",
      { isError: true, toolName: "edit", input: { path: "src/a.ts" } },
      [],
    ],
    [
      "unsupported tool",
      { isError: false, toolName: "read", input: { path: "src/a.ts" } },
      [],
    ],
  ])("extracts paths from %s", (_label, input, expected) => {
    expect(collectToolResultPaths(input)).toEqual(expected);
  });
});

describe("auto-trigger detection", () => {
  it.each([
    ["skill prompt", "/skill:me-code-simplifier", true],
    ["run marker", "[agent-end-code-simplifier run_id=12]", true],
    ["ordinary extension path", "extensions/agent-end-code-simplifier", false],
  ])("detects %s", (_label, text, expected) => {
    expect(containsAutoTriggerMarker(text)).toBe(expected);
  });

  it("extracts safe integer run ids from hidden follow-up markers", () => {
    expect(
      extractAutoTriggerRunId("[agent-end-code-simplifier run_id=42]"),
    ).toBe(42);
    expect(extractAutoTriggerRunId("ordinary message")).toBeNull();
  });

  it("checks only the latest user message for auto-trigger markers", () => {
    expect(
      lastUserMessageLooksAutoTriggered([
        { role: "user", content: "/skill:me-code-simplifier" },
        { role: "assistant", content: "done" },
        { role: "user", content: "next task" },
      ]),
    ).toBe(false);

    expect(
      lastUserMessageLooksAutoTriggered([
        { role: "assistant", content: "done" },
        {
          role: "user",
          content: [
            { type: "text", text: "[agent-end-code-simplifier run_id=1]" },
          ],
        },
      ]),
    ).toBe(true);
  });

  it("detects aborted turns from either signal or assistant messages", () => {
    expect(containsAbortedMessage([{ stopReason: "aborted" }])).toBe(true);
    expect(
      turnWasAborted({ messages: [] }, { signal: AbortSignal.abort() }),
    ).toBe(true);
    expect(
      turnWasAborted(
        { messages: [{ role: "assistant", stopReason: "aborted" }] },
        {},
      ),
    ).toBe(true);
  });
});

describe("agent-end code simplifier lifecycle", () => {
  it("tracks modified paths as sorted plain values", () => {
    const state = trackModifiedPaths(
      createAgentEndCodeSimplifierLifecycleState(),
      ["src/b.ts", "src/a.ts", "src/b.ts"],
    );

    expect(state.modifiedPaths).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("resets tracked files across sessions and agent starts", () => {
    const activeState = {
      modifiedPaths: ["src/a.ts"],
      suppressNextPrompt: true,
      runGeneration: 7,
      currentInputSource: "extension",
    };

    expect(resetLifecycleForNewSession(activeState)).toEqual({
      modifiedPaths: [],
      suppressNextPrompt: false,
      runGeneration: 7,
      currentInputSource: null,
    });
    expect(resetLifecycleForAgentStart(activeState)).toEqual({
      modifiedPaths: [],
      suppressNextPrompt: true,
      runGeneration: 7,
      currentInputSource: "extension",
    });
  });

  it("records prompt source while preserving it across agent_start", () => {
    const state = createAgentEndCodeSimplifierLifecycleState();
    const transition = decideInputLifecycleTransition(state, {
      source: "extension",
      text: "plugin prompt",
    });

    expect(transition.state).toMatchObject({
      currentInputSource: "extension",
    });
    expect(resetLifecycleForAgentStart(transition.state)).toMatchObject({
      currentInputSource: "extension",
    });
  });

  it("starts and consumes simplifier suppression as pure state transitions", () => {
    const runningState = startSimplifierRun(
      createAgentEndCodeSimplifierLifecycleState(),
    );

    expect(runningState).toMatchObject({
      suppressNextPrompt: true,
      runGeneration: 1,
    });
    expect(consumeSuppressedAgentEnd(runningState)).toMatchObject({
      suppressNextPrompt: false,
      runGeneration: 1,
    });
  });

  it("handles stale extension inputs without shell mocks", () => {
    const state = startSimplifierRun(
      createAgentEndCodeSimplifierLifecycleState(),
    );

    const transition = decideInputLifecycleTransition(state, {
      source: "extension",
      text: "[agent-end-code-simplifier run_id=999]",
    });

    expect(transition).toMatchObject({
      action: "handled",
      clearRunningWidget: true,
      logEvent: "input_handled_stale_code_simplifier_prompt",
      staleRunId: 999,
      state: { suppressNextPrompt: false, runGeneration: 1 },
    });
  });

  it("invalidates queued simplifier prompts on new user input", () => {
    const state = startSimplifierRun(
      createAgentEndCodeSimplifierLifecycleState(),
    );

    expect(
      decideInputLifecycleTransition(state, {
        source: "user",
        text: "new task",
      }),
    ).toMatchObject({
      action: "continue",
      clearRunningWidget: true,
      state: { suppressNextPrompt: false, runGeneration: 2 },
    });
  });
});

describe("decideAgentEndSimplifierAction", () => {
  const baseInput = {
    enabled: true,
    hasUI: true,
    suppressNextPrompt: false,
    lastUserMessageAutoTriggered: false,
    supportedPaths: ["src/a.ts"],
    abortBehavior: "skip" as const,
    turnAborted: false,
    autoRun: true,
    confirmBeforeRun: false,
    inputSource: "interactive",
    skipExtensionPrompts: true,
  };

  it.each([
    [
      "disabled extension",
      { enabled: false },
      { kind: "skip", logEvent: "agent_end_skipped_disabled" },
    ],
    [
      "missing UI",
      { hasUI: false },
      { kind: "skip", logEvent: "agent_end_skipped_no_ui" },
    ],
    [
      "no supported files",
      { supportedPaths: [] },
      { kind: "skip", logEvent: "agent_end_skipped_no_supported_paths" },
    ],
  ])("skips when %s", (_label, input, expected) => {
    expect(decideAgentEndSimplifierAction({ ...baseInput, ...input })).toEqual(
      expected,
    );
  });

  it("clears and consumes suppression after a simplifier follow-up", () => {
    expect(
      decideAgentEndSimplifierAction({
        ...baseInput,
        suppressNextPrompt: true,
      }),
    ).toMatchObject({
      kind: "skip_suppressed",
      clearRunningWidget: true,
      resetSuppressNextPrompt: true,
    });
  });

  it("keeps manual retry available instead of auto-running after aborted turns", () => {
    expect(
      decideAgentEndSimplifierAction({ ...baseInput, turnAborted: true }),
    ).toMatchObject({
      kind: "notify_manual_available",
      reason: "this turn was aborted",
      supportedPaths: ["src/a.ts"],
    });
  });

  it("keeps manual retry available for extension-origin prompts by default", () => {
    expect(
      decideAgentEndSimplifierAction({
        ...baseInput,
        inputSource: "extension",
      }),
    ).toMatchObject({
      kind: "notify_manual_available",
      reason: "this turn was started by an extension prompt",
      supportedPaths: ["src/a.ts"],
    });

    expect(
      decideAgentEndSimplifierAction({
        ...baseInput,
        inputSource: "extension",
        skipExtensionPrompts: false,
      }),
    ).toEqual({ kind: "send", supportedPaths: ["src/a.ts"] });
  });

  it("sends directly by default and requests confirmation when configured", () => {
    expect(decideAgentEndSimplifierAction(baseInput)).toEqual({
      kind: "send",
      supportedPaths: ["src/a.ts"],
    });

    const confirmation = decideAgentEndSimplifierAction({
      ...baseInput,
      confirmBeforeRun: true,
    });

    expect(confirmation).toMatchObject({
      kind: "confirm",
      supportedPaths: ["src/a.ts"],
    });
    expect(confirmation).toHaveProperty("title");
    expect(confirmation).toHaveProperty(
      "body",
      expect.stringContaining("src/a.ts"),
    );
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

  it("keeps automatic follow-up requirements in structured XML", () => {
    const prompt = buildCodeSimplifierPrompt(["a.ts"]);

    expect(prompt).toContain("<scope>");
    expect(prompt).toContain(
      "<modified_files>\n  <file>a.ts</file>\n  </modified_files>",
    );
    expect(prompt).toContain("<requirements>");
    expect(prompt).toContain("<requirement>");
    expect(prompt).toContain("</code_simplifier_request>");
  });
});

describe("extension diagnostics", () => {
  it("registers Ctrl+Alt+Y to manually trigger me-code-simplifier", async () => {
    mockExtensionDependencies();

    const { handlers, shortcuts, sendMessage, sendUserMessage } =
      await createExtensionHarness();

    const ctx = createBasicTestContext();

    await handlers.get("session_start")?.({}, ctx);
    await trackSuccessfulToolResult(handlers, { path: "src/manual.ts" }, ctx);
    await shortcuts.get("ctrl+alt+y")?.handler(ctx);

    expectSimplifierPromptSent(
      { sendMessage, sendUserMessage },
      "src/manual.ts",
    );
  });

  it("uses repo dirty code files when manual shortcut has no tracked files", async () => {
    mockExtensionDependencies();
    vi.doMock("../shared/git.ts", () => ({
      DEFAULT_GIT_TIMEOUT_MS: 5000,
      getRepoRoot: vi.fn(() => "/repo"),
      checkRepoDirty: vi.fn(() => ({
        porcelain:
          "M  src/staged.ts\n M src/unstaged.py\n?? README.md\n?? src/new.ts\n",
        summary: { staged: 1, unstaged: 1, untracked: 2, dirty: true },
      })),
      listDirtyPaths: vi.fn(() => [
        "src/staged.ts",
        "src/unstaged.py",
        "README.md",
        "src/new.ts",
      ]),
    }));

    const { handlers, shortcuts, sendMessage, sendUserMessage } =
      await createExtensionHarness();

    const ctx = createBasicTestContext({ cwd: "/repo/subdir" });

    await handlers.get("session_start")?.({}, ctx);
    await shortcuts.get("ctrl+alt+y")?.handler(ctx);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendUserMessage).toHaveBeenCalledTimes(1);

    const sentPrompt = String(sendUserMessage.mock.calls[0]?.[0]);
    expect(sentPrompt).toContain("src/staged.ts");
    expect(sentPrompt).toContain("src/unstaged.py");
    expect(sentPrompt).toContain("src/new.ts");
    expect(sentPrompt).not.toContain("README.md");
  });

  it("defers automatic hidden prompts until after agent_end returns", async () => {
    vi.useFakeTimers();
    mockExtensionDependencies();

    const { handlers, sendMessage, sendUserMessage } =
      await createExtensionHarness();

    const ctx = createBasicTestContext();

    await handlers.get("session_start")?.({}, ctx);
    await trackSuccessfulToolResult(
      handlers,
      { path: "src/deferred-auto.ts" },
      ctx,
    );
    await handlers.get("agent_end")?.({ messages: [] }, ctx);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendUserMessage).not.toHaveBeenCalled();

    await vi.runOnlyPendingTimersAsync();

    expectSimplifierPromptSent(
      { sendMessage, sendUserMessage },
      "src/deferred-auto.ts",
    );
  });

  it("skips automatic simplifier prompts after extension-origin turns", async () => {
    mockExtensionDependencies();

    const { handlers, sendMessage, sendUserMessage } =
      await createExtensionHarness();

    const ctx = createBasicTestContext();

    await handlers.get("session_start")?.({}, ctx);
    await handlers.get("input")?.(
      { source: "extension", text: "plugin follow-up" },
      ctx,
    );
    await handlers.get("agent_start")?.({}, ctx);
    await trackSuccessfulToolResult(
      handlers,
      { path: "src/extension-origin.ts" },
      ctx,
    );
    await handlers.get("agent_end")?.({ messages: [] }, ctx);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Skipped me-code-simplifier"),
      "info",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Ctrl+Alt+Y"),
      "info",
    );
  });

  it("waits for idle before sending automatic simplifier prompts", async () => {
    vi.useFakeTimers();
    mockExtensionDependencies();

    const { handlers, sendMessage, sendUserMessage } =
      await createExtensionHarness();
    const isIdle = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    const ctx = createWidgetTestContext({ isIdle });

    await handlers.get("session_start")?.({}, ctx);
    await trackSuccessfulToolResult(
      handlers,
      { path: "src/wait-for-idle.ts" },
      ctx,
    );
    await handlers.get("agent_end")?.({ messages: [] }, ctx);

    await vi.advanceTimersByTimeAsync(0);

    expect(sendUserMessage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(25);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("src/wait-for-idle.ts"),
    );
  });

  it("shows a running widget when manual simplifier follow-up starts", async () => {
    mockExtensionDependencies();

    const { handlers, shortcuts } = await createExtensionHarness();
    const ctx = createWidgetTestContext();

    await handlers.get("session_start")?.({}, ctx);
    await trackSuccessfulToolResult(
      handlers,
      { path: "src/manual-widget.ts" },
      ctx,
    );
    await shortcuts.get("ctrl+alt+y")?.handler(ctx);

    expectRunningWidgetShown(ctx);
  });

  it("keeps the running widget until the simplifier follow-up ends", async () => {
    mockExtensionDependencies();

    const { handlers } = await createExtensionHarness();
    const ctx = createWidgetTestContext();

    await handlers.get("session_start")?.({}, ctx);
    await trackSuccessfulToolResult(
      handlers,
      { path: "src/auto-widget-clear.ts" },
      ctx,
    );
    await handlers.get("agent_end")?.({ messages: [] }, ctx);
    await flushDeferredSimplifierPrompt();

    ctx.ui.setWidget.mockClear();
    await handlers.get("agent_start")?.({}, ctx);

    expect(ctx.ui.setWidget).not.toHaveBeenCalledWith(
      RUNNING_WIDGET_KEY,
      undefined,
    );

    await handlers.get("agent_end")?.(
      {
        messages: [{ role: "user", content: "[agent-end-code-simplifier]" }],
      },
      ctx,
    );

    expectRunningWidgetCleared(ctx);
  });

  it("clears the running widget when the user submits a new prompt", async () => {
    mockExtensionDependencies();

    const { handlers } = await createExtensionHarness();
    const ctx = createWidgetTestContext();

    await handlers.get("session_start")?.({}, ctx);
    await trackSuccessfulToolResult(
      handlers,
      { path: "src/user-new-prompt-widget.ts" },
      ctx,
    );
    await handlers.get("agent_end")?.({ messages: [] }, ctx);
    expectRunningWidgetShown(ctx);

    ctx.ui.setWidget.mockClear();
    await handlers.get("input")?.({ source: "user", text: "new prompt" }, ctx);

    expectRunningWidgetCleared(ctx);
  });

  it("drops stale queued simplifier follow-ups after a newer user prompt", async () => {
    mockExtensionDependencies();

    const { handlers, sendUserMessage } = await createExtensionHarness();
    const ctx = createWidgetTestContext();

    await handlers.get("session_start")?.({}, ctx);
    await trackSuccessfulToolResult(
      handlers,
      { path: "src/stale-follow-up.ts" },
      ctx,
    );
    await handlers.get("agent_end")?.({ messages: [] }, ctx);
    await flushDeferredSimplifierPrompt();

    const queuedPrompt = String(sendUserMessage.mock.calls[0]?.[0]);
    expect(queuedPrompt).toContain("src/stale-follow-up.ts");

    await handlers.get("input")?.({ source: "user", text: "newer task" }, ctx);
    const result = await handlers.get("input")?.(
      { source: "extension", text: queuedPrompt },
      ctx,
    );

    expect(result).toEqual({ action: "handled" });
  });

  it("skips automatic simplifier approval after an aborted turn by default", async () => {
    mockExtensionDependencies();

    const { handlers, events, sendMessage, sendUserMessage } =
      await createExtensionHarness();

    const ctx = createBasicTestContext({ signal: AbortSignal.abort() });

    await handlers.get("session_start")?.({}, ctx);
    await trackSuccessfulToolResult(handlers, { path: "src/aborted.ts" }, ctx);
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
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Skipped me-code-simplifier"),
      "info",
    );
  });

  it("keeps manually triggering simplifier for tracked files after an aborted turn", async () => {
    mockExtensionDependencies();

    const { handlers, shortcuts, sendMessage, sendUserMessage } =
      await createExtensionHarness();

    const ctx = createBasicTestContext({ signal: AbortSignal.abort() });

    await handlers.get("session_start")?.({}, ctx);
    await trackSuccessfulToolResult(
      handlers,
      { path: "src/manual-after-abort.ts" },
      ctx,
      "write",
    );
    await handlers.get("agent_end")?.(
      {
        messages: [{ role: "assistant", stopReason: "aborted" }],
      },
      ctx,
    );
    await shortcuts.get("ctrl+alt+y")?.handler(ctx);

    expectSimplifierPromptSent(
      { sendMessage, sendUserMessage },
      "src/manual-after-abort.ts",
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
    const ctx = createBasicTestContext();

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
    const { handlers, sendMessage, sendUserMessage } =
      await createExtensionHarness({
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
    await trackSuccessfulToolResult(
      handlers,
      { path: "src/demo.ts" },
      ctx,
      "write",
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
    await flushDeferredSimplifierPrompt();
    expectSimplifierPromptSent({ sendMessage, sendUserMessage }, "src/demo.ts");
  });
});
