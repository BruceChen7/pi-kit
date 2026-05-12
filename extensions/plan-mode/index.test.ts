import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import planModeExtension from "./index.js";

type Handler = (event: unknown, ctx: TestCtx) => Promise<unknown> | unknown;
type CommandRegistration = {
  description: string;
  handler: (args: string, ctx: TestCtx) => Promise<unknown> | unknown;
};
type ToolRegistration = {
  name: string;
  description?: string;
  promptGuidelines?: string[];
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: (update: unknown) => void,
    ctx: TestCtx,
  ) => Promise<unknown> | unknown;
};
type CustomEntry = {
  type: "custom";
  customType: string;
  data?: unknown;
};
type TestCtx = {
  cwd: string;
  hasUI: boolean;
  isIdle: () => boolean;
  signal?: AbortSignal;
  ui: {
    select: ReturnType<typeof vi.fn>;
    notify: ReturnType<typeof vi.fn>;
    confirm: ReturnType<typeof vi.fn>;
    setStatus: ReturnType<typeof vi.fn>;
    setWidget: ReturnType<typeof vi.fn>;
    theme: {
      fg: (tone: string, text: string) => string;
      strikethrough: (text: string) => string;
    };
  };
  sessionManager: {
    getSessionFile: () => string;
    getEntries: () => CustomEntry[];
    getBranch: () => CustomEntry[];
  };
};

const PLAN_MODE_STATE_ENTRY = "plan-mode-state";
const PLAN_MODE_TODOS_WIDGET = "plan-mode-todos";
const PLAN_MODE_TODO_TOOL = "plan_mode_todo";
const PLANNOTATOR_REVIEW_TOOL = "plannotator_auto_submit_review";

const buildHarness = () => {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, CommandRegistration>();
  const tools = new Map<string, ToolRegistration>();
  const entries: CustomEntry[] = [];
  let activeTools = ["read", "grep", "find", "ls", "bash", "edit", "write"];

  const api = {
    on: vi.fn((event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }),
    registerCommand: vi.fn(
      (name: string, registration: CommandRegistration) => {
        commands.set(name, registration);
      },
    ),
    registerTool: vi.fn((tool: ToolRegistration) => {
      tools.set(tool.name, tool);
    }),
    appendEntry: vi.fn((customType: string, data: unknown) => {
      entries.push({ type: "custom", customType, data });
    }),
    sendUserMessage: vi.fn(),
    setActiveTools: vi.fn((names: string[]) => {
      activeTools = names;
    }),
    getActiveTools: vi.fn(() => activeTools),
    registerFlag: vi.fn(),
    getFlag: vi.fn(() => false),
  };

  const emit = async (event: string, payload: unknown, ctx: TestCtx) => {
    let result: unknown;
    for (const handler of handlers.get(event) ?? []) {
      result = await handler(payload, ctx);
    }
    return result;
  };

  const runCommand = async (name: string, args: string, ctx: TestCtx) => {
    const command = commands.get(name);
    if (!command) throw new Error(`Missing command: ${name}`);
    return command.handler(args, ctx);
  };

  const runTool = async (
    name: string,
    params: Record<string, unknown>,
    ctx: TestCtx,
  ) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`Missing tool: ${name}`);
    return tool.execute(
      "tool-call-1",
      params,
      new AbortController().signal,
      () => {},
      ctx,
    );
  };

  const runToolCall = async (
    toolName: string,
    input: Record<string, unknown>,
    ctx: TestCtx,
  ) => emit("tool_call", { toolName, input }, ctx);

  return {
    api,
    emit,
    runCommand,
    runTool,
    runToolCall,
  };
};

const buildCtx = (
  entries: CustomEntry[] = [],
  branchEntries: CustomEntry[] = entries,
): TestCtx => ({
  cwd: "/repo",
  hasUI: true,
  isIdle: () => true,
  ui: {
    select: vi.fn(async () => undefined),
    notify: vi.fn(),
    confirm: vi.fn(async () => true),
    setStatus: vi.fn(),
    setWidget: vi.fn(),
    theme: {
      fg: vi.fn((tone: string, text: string) => `<${tone}>${text}</${tone}>`),
      strikethrough: (text: string) => `~~${text}~~`,
    },
  },
  sessionManager: {
    getSessionFile: () => "/repo/.pi/session.jsonl",
    getEntries: () => entries,
    getBranch: () => branchEntries,
  },
});

const lastTodoWidgetCall = (ctx: TestCtx) => {
  const call = ctx.ui.setWidget.mock.calls.findLast(
    ([key]) => key === PLAN_MODE_TODOS_WIDGET,
  );
  if (!call) throw new Error("Expected a plan-mode TODO widget call");
  return call;
};

const lastWidgetLines = (ctx: TestCtx): string[] =>
  lastTodoWidgetCall(ctx)[1] as string[];

const plainWidgetText = (ctx: TestCtx): string =>
  lastWidgetLines(ctx)
    .join("\n")
    .replace(/<[^>]+>/gu, "");

const planModeStateEntry = (data: Record<string, unknown>): CustomEntry => ({
  type: "custom",
  customType: PLAN_MODE_STATE_ENTRY,
  data,
});

const lastPersistedPlanModeSnapshot = (
  harness: ReturnType<typeof buildHarness>,
): Record<string, unknown> => {
  const call = harness.api.appendEntry.mock.calls.findLast(
    ([customType]) => customType === PLAN_MODE_STATE_ENTRY,
  );
  if (!call) throw new Error("Expected a plan-mode state entry");
  return call[1] as Record<string, unknown>;
};

const createTempCtx = (): { ctx: TestCtx; cleanup: () => void } => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "plan-mode-policy-"));
  return {
    ctx: { ...buildCtx(), cwd },
    cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }),
  };
};

const withTempCtx = async (
  run: (ctx: TestCtx) => Promise<void>,
): Promise<void> => {
  const { ctx, cleanup } = createTempCtx();
  try {
    await run(ctx);
  } finally {
    cleanup();
  }
};

const writePlanArtifact = (
  cwd: string,
  relativePath: string,
  content: string,
): void => {
  const absolutePath = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content, "utf-8");
};

const writeProjectSettings = (
  cwd: string,
  settings: Record<string, unknown>,
): void => {
  const settingsPath = path.join(cwd, ".pi", "third_extension_settings.json");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings), "utf-8");
};

const writeSourceFile = (
  ctx: TestCtx,
  relativePath: string,
  content = "export {};\n",
): void => {
  const absolutePath = path.join(ctx.cwd, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content, "utf-8");
};

const markFileRead = async (
  harness: ReturnType<typeof buildHarness>,
  ctx: TestCtx,
  targetPath: string,
): Promise<void> => {
  await harness.emit(
    "tool_result",
    { toolName: "read", input: { path: targetPath }, isError: false },
    ctx,
  );
};

const startPlanModeSession = async (
  mode: "plan" | "act" = "plan",
  ctx: TestCtx = buildCtx(),
) => {
  const harness = buildHarness();
  planModeExtension(harness.api as unknown as ExtensionAPI);
  await harness.emit("session_start", {}, ctx);
  if (mode !== "act") {
    await harness.runCommand("plan-mode", mode, ctx);
    ctx.ui.notify.mockClear();
  }
  return { harness, ctx };
};

const expectToolBlocked = async (
  harness: ReturnType<typeof buildHarness>,
  ctx: TestCtx,
  toolName: string,
  input: Record<string, unknown>,
  expected: Record<string, unknown> = { block: true },
): Promise<void> => {
  await expect(
    harness.runToolCall(toolName, input, ctx),
  ).resolves.toMatchObject(expected);
};

const expectToolAllowed = async (
  harness: ReturnType<typeof buildHarness>,
  ctx: TestCtx,
  toolName: string,
  input: Record<string, unknown>,
): Promise<void> => {
  await expect(
    harness.runToolCall(toolName, input, ctx),
  ).resolves.toBeUndefined();
};

const sendInput = async (
  harness: ReturnType<typeof buildHarness>,
  ctx: TestCtx,
  text: string,
  source: string,
) => harness.emit("input", { text, source }, ctx);

const sendAgentPrompt = async (
  harness: ReturnType<typeof buildHarness>,
  ctx: TestCtx,
  prompt: string,
  intentFeedback?: unknown,
) =>
  harness.emit(
    "before_agent_start",
    {
      prompt,
      systemPrompt: "base",
      intentFeedback,
    },
    ctx,
  );

const commitWithoutBranchPrompt = "commit and no extra branch";
const directActTodoGuidance =
  "In direct act mode, create concrete TODOs before using tools or making changes.";

const validPlanContent = `## Context
- 用户希望用中文描述计划背景、成功标准和受影响模块。

## Steps
- [ ] 编写失败测试
- [ ] 实现最小代码

## Verification
- 运行 npm test -- extensions/plan-mode

## Review
- 待实现后记录改动点、验证结果、剩余风险和 bug 修复原因。
`;

const invalidPlanContent = validPlanContent.replace("## Review", "## Notes");
const oneItemCompletedSummary = "✅ 任务已完成 · 1/1 项任务已交付";
const completedTaskSummary = (heading: string, tasks: string[]): string =>
  [
    heading,
    "已交付：",
    ...tasks.map((task, index) => `  #${index + 1} ${task}`),
  ].join("\n");
const actCompletedTaskSummary = (...tasks: string[]): string =>
  `【act:completed】${completedTaskSummary(oneItemCompletedSummary, tasks)}`;
const planCompletedTaskSummary = (...tasks: string[]): string =>
  `【plan:completed】${completedTaskSummary(oneItemCompletedSummary, tasks)}`;
const actOneItemCompletedSummary = actCompletedTaskSummary("完成第一批任务");
const planOneItemCompletedSummary = planCompletedTaskSummary("完成后清理");
const demoPlanPath = ".pi/plans/pi-kit/plan/2026-05-08-demo.md";
const demoCompletedSummary = completedTaskSummary(
  "✅ 计划「demo」已完成 · 3/3 项任务已交付",
  ["编写测试", "实现改动", "验证结果"],
);

const expectApprovedContinuationFollowUp = (
  harness: ReturnType<typeof buildHarness>,
): void => {
  expect(harness.api.sendUserMessage).toHaveBeenCalledWith(
    expect.stringContaining(
      `Continue implementing approved plan: ${demoPlanPath}`,
    ),
    { deliverAs: "followUp" },
  );
};
const actCompletedDemoSummary = `【act:completed】${demoCompletedSummary}`;
const approvedPlanPolicyFixPrompt = [
  "Plan Mode artifact policy requires fixes for an already approved plan.",
  `Path: ${demoPlanPath}`,
  "",
  "Fix the plan format before continuing with the approved plan:",
  "- ## Review 缺少后续结果记录要求。 (Review)",
].join("\n");

const approveDemoPlan = async (
  harness: ReturnType<typeof buildHarness>,
  ctx: TestCtx,
): Promise<void> => {
  await harness.emit(
    "tool_result",
    {
      toolName: PLANNOTATOR_REVIEW_TOOL,
      isError: false,
      input: { path: demoPlanPath },
      content: [
        {
          type: "text",
          text: `Review approved for ${demoPlanPath}.`,
        },
      ],
    },
    ctx,
  );
};

const startApprovedDemoRun = async (
  harness: ReturnType<typeof buildHarness>,
  ctx: TestCtx,
  todoText = "实现已批准任务",
): Promise<void> => {
  await harness.runTool(
    PLAN_MODE_TODO_TOOL,
    {
      action: "set",
      items: [{ text: todoText, status: "todo" }],
    },
    ctx,
  );
  await approveDemoPlan(harness, ctx);
};

const completeApprovedDemoRun = async (
  harness: ReturnType<typeof buildHarness>,
  ctx: TestCtx,
  todoText = "实现已批准任务",
): Promise<void> => {
  await startApprovedDemoRun(harness, ctx, todoText);
  await harness.runTool(
    PLAN_MODE_TODO_TOOL,
    { action: "update", id: 1, status: "done" },
    ctx,
  );
};

describe("plan-mode extension", () => {
  it("defaults new sessions to act mode", async () => {
    const { harness, ctx } = await startPlanModeSession("act");

    const result = await sendAgentPrompt(harness, ctx, "answer directly");

    expect(result).toMatchObject({
      systemPrompt: expect.stringContaining("Current mode: act."),
    });
  });

  it("requires concrete todos before direct act-mode task execution", async () => {
    const { harness, ctx } = await startPlanModeSession("act");

    const result = await sendAgentPrompt(
      harness,
      ctx,
      "commit all the changes",
    );

    expect(result.systemPrompt).toContain(directActTodoGuidance);
  });

  it("prompts once before non-plan agent execution and defaults to act after timeout", async () => {
    const { harness, ctx } = await startPlanModeSession("act");

    await sendInput(harness, ctx, "implement this", "interactive");
    await sendAgentPrompt(harness, ctx, "implement this");
    await sendAgentPrompt(harness, ctx, "implement this again");

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("5s"),
      "info",
    );
    expect(ctx.ui.select).toHaveBeenCalledTimes(1);
    expect(ctx.ui.select).toHaveBeenCalledWith(
      "Choose Plan Mode for this run",
      ["act", "plan"],
      { timeout: 5000 },
    );
    const result = await sendAgentPrompt(harness, ctx, "post-timeout prompt");
    expect(result).toMatchObject({
      systemPrompt: expect.stringContaining("Current mode: act."),
    });
  });

  it("enters plan directly without prompting when the prompt explicitly asks for plan", async () => {
    const { harness, ctx } = await startPlanModeSession();

    await sendInput(harness, ctx, "plan this change", "interactive");
    const result = await sendAgentPrompt(
      harness,
      ctx,
      "please plan this change first",
    );

    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      systemPrompt: expect.stringContaining("Current mode: plan."),
    });
  });

  it("rejects removed auto, fast, and review modes", async () => {
    const { harness, ctx } = await startPlanModeSession("act");

    await harness.runCommand("plan-mode", "auto", ctx);
    await harness.runCommand("plan-mode", "fast", ctx);
    await harness.runCommand("plan-mode", "review", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Unknown plan-mode: auto",
      "error",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Unknown plan-mode: fast",
      "error",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Unknown plan-mode: review",
      "error",
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("blocks source writes during plan mode phase but allows review artifact writes", async () => {
    const { harness, ctx } = await startPlanModeSession();

    await expectToolBlocked(harness, ctx, "write", { path: "x.ts" });
    await expectToolBlocked(harness, ctx, "edit", { path: "x.ts" });
    await expectToolBlocked(harness, ctx, "bash", { command: "npm test" });
    await expectToolAllowed(harness, ctx, "write", {
      path: ".pi/plans/pi-kit/plan/2026-05-08-demo.md",
    });
    await expectToolAllowed(harness, ctx, "write", {
      path: ".pi/plans/pi-kit/specs/2026-05-08-demo-design.md",
    });

    await harness.runCommand("plan-mode", "act", ctx);
    await expectToolAllowed(harness, ctx, "write", { path: "x.ts" });
  });

  it("allows date-prefixed plan writes even when .pi does not exist yet", async () => {
    await withTempCtx(async (ctx) => {
      const { harness } = await startPlanModeSession("act", ctx);

      expect(fs.existsSync(path.join(ctx.cwd, ".pi"))).toBe(false);
      await expectToolAllowed(harness, ctx, "write", {
        path: ".pi/plans/pi-kit/plan/2026-05-08-demo.md",
      });
    });
  });

  it("explains the date-prefixed review artifact filename when blocking plan writes", async () => {
    const harness = buildHarness();
    const ctx = buildCtx();
    planModeExtension(harness.api as unknown as ExtensionAPI);

    await harness.emit("session_start", {}, ctx);
    await harness.runCommand("plan-mode", "plan", ctx);

    const result = await harness.runToolCall(
      "write",
      { path: ".pi/plans/pi-kit/plan/demo.md" },
      ctx,
    );

    expect(result).toMatchObject({
      block: true,
      reason: expect.stringContaining(
        ".pi/plans/<repo>/plan/YYYY-MM-DD-<slug>.md",
      ),
    });
    expect(result).toMatchObject({
      reason: expect.stringContaining("No mkdir is needed"),
    });
  });

  it("allows read-only tools outside cwd while still blocking writes", async () => {
    const { harness, ctx } = await startPlanModeSession("act");
    const outsidePath = "/tmp/outside-cwd.txt";

    for (const toolName of ["read", "grep", "find", "ls", "rg", "fd"]) {
      await expectToolAllowed(harness, ctx, toolName, { path: outsidePath });
    }

    for (const toolName of ["write", "edit"]) {
      await expectToolBlocked(
        harness,
        ctx,
        toolName,
        { path: outsidePath },
        {
          block: true,
          reason: expect.stringContaining("path is outside cwd"),
        },
      );
    }
  });

  it("allows act patch edits for existing files that were read first", async () => {
    await withTempCtx(async (ctx) => {
      const targetPath = "src/example.ts";
      writeSourceFile(ctx, targetPath, "export const value = 1;\n");

      const { harness } = await startPlanModeSession("act", ctx);
      await markFileRead(harness, ctx, targetPath);

      await expectToolAllowed(harness, ctx, "edit", {
        patch: `*** Begin Patch
*** Update File: ${targetPath}
@@
-export const value = 1;
+export const value = 2;
*** End Patch`,
      });
    });
  });

  it("requires every existing multi-edit target to be read first", async () => {
    await withTempCtx(async (ctx) => {
      const firstPath = "src/first.ts";
      const secondPath = "src/second.ts";
      for (const targetPath of [firstPath, secondPath]) {
        writeSourceFile(ctx, targetPath);
      }

      const { harness } = await startPlanModeSession("act", ctx);
      await markFileRead(harness, ctx, firstPath);

      await expectToolBlocked(
        harness,
        ctx,
        "edit",
        {
          multi: [
            { path: firstPath, oldText: "export {};", newText: "export {};" },
            { path: secondPath, oldText: "export {};", newText: "export {};" },
          ],
        },
        {
          block: true,
          reason: expect.stringContaining(secondPath),
        },
      );
    });
  });

  it("allows patch add-file writes inside cwd without requiring a prior read", async () => {
    await withTempCtx(async (ctx) => {
      const { harness } = await startPlanModeSession("act", ctx);

      await expectToolAllowed(harness, ctx, "edit", {
        patch: `*** Begin Patch
*** Add File: src/new-file.ts
+export const value = 1;
*** End Patch`,
      });
    });
  });

  it("blocks patch add-file writes outside cwd", async () => {
    const { harness, ctx } = await startPlanModeSession("act");

    await expectToolBlocked(
      harness,
      ctx,
      "edit",
      {
        patch: `*** Begin Patch
*** Add File: /tmp/outside-plan-mode.ts
+export const value = 1;
*** End Patch`,
      },
      {
        block: true,
        reason: expect.stringContaining("path is outside cwd"),
      },
    );
  });

  it("requires patch delete-file targets to be read first", async () => {
    await withTempCtx(async (ctx) => {
      const targetPath = "src/delete-me.ts";
      writeSourceFile(ctx, targetPath);
      const { harness } = await startPlanModeSession("act", ctx);

      await expectToolBlocked(
        harness,
        ctx,
        "edit",
        {
          patch: `*** Begin Patch
*** Delete File: ${targetPath}
*** End Patch`,
        },
        {
          block: true,
          reason: expect.stringContaining(targetPath),
        },
      );
    });
  });

  it("keeps read-only tools using dot as their default path", async () => {
    const { harness, ctx } = await startPlanModeSession("act");

    await expectToolAllowed(harness, ctx, "ls", {});
  });

  it("blocks unresolved write targets without falling back to dot", async () => {
    const { harness, ctx } = await startPlanModeSession("act");

    const result = await harness.runToolCall(
      "edit",
      { patch: "*** Begin Patch\n*** End Patch" },
      ctx,
    );

    expect(result).toMatchObject({
      block: true,
      reason: expect.stringContaining("unable to determine target file paths"),
    });
    expect(result).not.toMatchObject({
      reason: expect.stringContaining(": ."),
    });
  });

  it("updates the act widget with the current in-progress step and completion counts", async () => {
    const harness = buildHarness();
    const ctx = buildCtx();
    planModeExtension(harness.api as unknown as ExtensionAPI);
    await harness.emit("session_start", {}, ctx);
    await harness.runCommand("plan-mode", "act", ctx);

    await harness.runTool(
      PLAN_MODE_TODO_TOOL,
      {
        action: "set",
        items: [
          { text: "实现状态机", status: "in_progress" },
          { text: "补充 README", status: "todo" },
        ],
      },
      ctx,
    );

    const [heading, progress, firstTodo] = lastWidgetLines(ctx);
    expect(heading).toBe("<accent>【act】进行中 #1/2：实现状态机</accent>");
    expect(progress).toBe("已完成 0/2 · 剩余 2 项");
    expect(firstTodo).toBe("→ #1 [~] 实现状态机");
    expect(ctx.ui.theme.fg).toHaveBeenCalledWith(
      "accent",
      "【act】进行中 #1/2：实现状态机",
    );
  });

  it("keeps completed todo details below the editor", async () => {
    const harness = buildHarness();
    const ctx = buildCtx();
    planModeExtension(harness.api as unknown as ExtensionAPI);
    await harness.emit("session_start", {}, ctx);

    await harness.emit(
      "tool_result",
      {
        toolName: PLANNOTATOR_REVIEW_TOOL,
        isError: false,
        content: [
          {
            type: "text",
            text: "Review approved for .pi/plans/pi-kit/plan/2026-05-08-demo.md.",
          },
        ],
      },
      ctx,
    );
    await harness.runTool(
      PLAN_MODE_TODO_TOOL,
      {
        action: "set",
        items: [
          { text: "编写测试", status: "done" },
          { text: "实现改动", status: "done" },
          { text: "验证结果", status: "done" },
        ],
      },
      ctx,
    );

    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("plan-mode", undefined);
    expect(ctx.ui.setStatus).not.toHaveBeenCalledWith(
      "plan-mode",
      expect.stringContaining("review:act 3/3"),
    );
    expect(plainWidgetText(ctx)).toBe(actCompletedDemoSummary);
    expect(lastTodoWidgetCall(ctx)[2]).toEqual({ placement: "belowEditor" });
  });

  it("replaces a completed summary when a new todo list starts", async () => {
    const harness = buildHarness();
    const ctx = buildCtx();
    planModeExtension(harness.api as unknown as ExtensionAPI);
    await harness.emit("session_start", {}, ctx);
    await harness.runCommand("plan-mode", "act", ctx);

    await harness.runTool(
      PLAN_MODE_TODO_TOOL,
      {
        action: "set",
        items: [{ text: "完成第一批任务", status: "done" }],
      },
      ctx,
    );
    expect(plainWidgetText(ctx)).toBe(actOneItemCompletedSummary);

    await harness.runTool(
      PLAN_MODE_TODO_TOOL,
      {
        action: "set",
        items: [{ text: "继续处理新任务", status: "todo" }],
      },
      ctx,
    );
    const widget = plainWidgetText(ctx);
    expect(widget).toContain("继续处理新任务");
    expect(widget).toContain("已完成 0/1 · 剩余 1 项");
  });

  it("hides a completed summary when the next user turn starts", async () => {
    const harness = buildHarness();
    const ctx = buildCtx();
    planModeExtension(harness.api as unknown as ExtensionAPI);
    await harness.emit("session_start", {}, ctx);
    await harness.runCommand("plan-mode", "act", ctx);

    await harness.runTool(
      PLAN_MODE_TODO_TOOL,
      {
        action: "set",
        items: [{ text: "完成第一批任务", status: "done" }],
      },
      ctx,
    );
    expect(plainWidgetText(ctx)).toBe(actOneItemCompletedSummary);

    await sendInput(harness, ctx, "继续下一个需求", "interactive");
    await sendAgentPrompt(harness, ctx, "继续下一个需求");

    expect(lastTodoWidgetCall(ctx)).toEqual([
      PLAN_MODE_TODOS_WIDGET,
      undefined,
    ]);
    expect(lastPersistedPlanModeSnapshot(harness)).toMatchObject({
      todos: [],
      activeRun: null,
      recentRuns: [{ status: "archived" }],
    });
  });

  it("hides the completed summary when todos are cleared", async () => {
    const { harness, ctx } = await startPlanModeSession();

    await harness.runTool(
      PLAN_MODE_TODO_TOOL,
      {
        action: "set",
        items: [{ text: "完成后清理", status: "done" }],
      },
      ctx,
    );
    expect(plainWidgetText(ctx)).toBe(planOneItemCompletedSummary);

    await harness.runTool(PLAN_MODE_TODO_TOOL, { action: "clear" }, ctx);

    expect(lastTodoWidgetCall(ctx)).toEqual([
      PLAN_MODE_TODOS_WIDGET,
      undefined,
    ]);
  });

  it("clears plan-mode UI on session shutdown after completed todos", async () => {
    const { harness, ctx } = await startPlanModeSession();

    await harness.runTool(
      PLAN_MODE_TODO_TOOL,
      {
        action: "set",
        items: [{ text: "完成后关闭 session", status: "done" }],
      },
      ctx,
    );
    expect(plainWidgetText(ctx)).toBe(
      planCompletedTaskSummary("完成后关闭 session"),
    );

    await expect(
      harness.emit("session_shutdown", {}, ctx),
    ).resolves.toBeUndefined();

    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("plan-mode", undefined);
    expect(lastTodoWidgetCall(ctx)).toEqual([
      PLAN_MODE_TODOS_WIDGET,
      undefined,
    ]);
  });

  it("marks the active plan run completed when all todos are done", async () => {
    const { harness, ctx } = await startPlanModeSession();

    const result = await harness.runTool(
      PLAN_MODE_TODO_TOOL,
      {
        action: "set",
        items: [{ text: "完成生命周期", status: "done" }],
      },
      ctx,
    );

    expect(result).toMatchObject({
      details: { activeRun: { status: "completed" } },
    });
    expect(plainWidgetText(ctx)).toContain(oneItemCompletedSummary);
  });

  it("archives completed runs before starting a new todo list", async () => {
    const { harness, ctx } = await startPlanModeSession();

    await harness.runTool(
      PLAN_MODE_TODO_TOOL,
      {
        action: "set",
        items: [{ text: "完成旧计划", status: "done" }],
      },
      ctx,
    );
    const result = await harness.runTool(
      PLAN_MODE_TODO_TOOL,
      {
        action: "set",
        items: [{ text: "开始新计划", status: "todo" }],
      },
      ctx,
    );

    expect(result).toMatchObject({
      details: {
        activeRun: { status: "draft", planPath: null },
        recentRuns: [{ status: "archived" }],
      },
    });
    expect(plainWidgetText(ctx)).toContain("开始新计划");
  });

  it("does not carry an old approved plan name into unrelated completed work", async () => {
    const { harness, ctx } = await startPlanModeSession();

    await completeApprovedDemoRun(harness, ctx);
    await harness.runCommand("plan-mode", "act", ctx);

    const started = await harness.runTool(
      PLAN_MODE_TODO_TOOL,
      {
        action: "set",
        items: [{ text: "补测试覆盖新的默认 prompt", status: "in_progress" }],
      },
      ctx,
    );

    expect(started).toMatchObject({
      details: { activeRun: { planPath: null, status: "draft" } },
    });

    await harness.runTool(
      PLAN_MODE_TODO_TOOL,
      { action: "update", id: 1, status: "done" },
      ctx,
    );

    const widget = plainWidgetText(ctx);
    expect(widget).toBe(actCompletedTaskSummary("补测试覆盖新的默认 prompt"));
    expect(widget).not.toContain("demo");
  });

  it("restores plan-mode state from the active session branch", async () => {
    const staleCompletedEntry = planModeStateEntry({
      mode: "act",
      phase: "act",
      todos: [{ id: 1, text: "旧分支任务", status: "done" }],
      nextTodoId: 2,
      activeRun: {
        id: "run-stale",
        status: "completed",
        planPath: demoPlanPath,
        todos: [{ id: 1, text: "旧分支任务", status: "done" }],
        nextTodoId: 2,
        createdAt: new Date(0).toISOString(),
      },
      readFiles: [],
      activePlanPath: demoPlanPath,
      reviewApprovedPlanPaths: [demoPlanPath],
      endConversationRequested: false,
    });
    const activeBranchEntry = planModeStateEntry({
      mode: "act",
      phase: "act",
      todos: [{ id: 1, text: "当前分支任务", status: "in_progress" }],
      nextTodoId: 2,
      activeRun: null,
      readFiles: [],
      activePlanPath: null,
      reviewApprovedPlanPaths: [],
      endConversationRequested: false,
    });
    const harness = buildHarness();
    const ctx = buildCtx(
      [activeBranchEntry, staleCompletedEntry],
      [activeBranchEntry],
    );
    planModeExtension(harness.api as unknown as ExtensionAPI);

    await harness.emit("session_start", {}, ctx);

    const widget = plainWidgetText(ctx);
    expect(widget).toContain("当前分支任务");
    expect(widget).not.toContain("demo");
  });

  it("shows user-facing run state in plan-mode status", async () => {
    const { harness, ctx } = await startPlanModeSession();

    await harness.runTool(
      PLAN_MODE_TODO_TOOL,
      {
        action: "set",
        items: [{ text: "查看状态", status: "todo" }],
      },
      ctx,
    );
    await harness.runCommand("plan-mode", "status", ctx);

    expect(ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("status: Waiting for review"),
      "info",
    );
  });

  it("normalizes pending todo input to todo", async () => {
    const harness = buildHarness();
    const ctx = buildCtx();
    planModeExtension(harness.api as unknown as ExtensionAPI);
    await harness.emit("session_start", {}, ctx);

    const result = await harness.runTool(
      PLAN_MODE_TODO_TOOL,
      {
        action: "set",
        items: [{ text: "确认需求", status: "pending" }],
      },
      ctx,
    );

    expect(result).toMatchObject({
      details: { todos: [{ text: "确认需求", status: "todo" }] },
    });
    expect(plainWidgetText(ctx)).toContain("#1 [ ] 确认需求");
  });

  it("guides agents to use set or add instead of create for TODOs", () => {
    const harness = buildHarness();
    planModeExtension(harness.api as unknown as ExtensionAPI);

    const todoTool = harness.api.registerTool.mock.calls
      .map(([tool]) => tool)
      .find((tool) => tool.name === PLAN_MODE_TODO_TOOL);
    const promptGuidance = todoTool?.promptGuidelines?.join("\n") ?? "";

    expect(promptGuidance).toContain('Use action "set"');
    expect(promptGuidance).toContain('action "add"');
    expect(promptGuidance).toContain('Do not use action "create"');
  });

  it("restores mode and todos from the latest session snapshot", async () => {
    const restoredEntries: CustomEntry[] = [
      planModeStateEntry({
        mode: "act",
        phase: "act",
        todos: [{ id: 1, text: "恢复后的当前步骤", status: "in_progress" }],
        nextTodoId: 2,
        readFiles: [],
        activePlanPath: null,
        reviewApprovedPlanPaths: [],
        endConversationRequested: false,
      }),
    ];
    const harness = buildHarness();
    const ctx = buildCtx(restoredEntries);
    planModeExtension(harness.api as unknown as ExtensionAPI);

    await harness.emit("session_start", {}, ctx);

    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("plan-mode", undefined);
    expect(plainWidgetText(ctx)).toContain("恢复后的当前步骤");
  });

  it("reminds the agent to create a TODO before ending plan mode", async () => {
    const harness = buildHarness();
    const ctx = buildCtx();
    planModeExtension(harness.api as unknown as ExtensionAPI);
    await harness.emit("session_start", {}, ctx);
    await harness.runCommand("plan-mode", "plan", ctx);

    await harness.emit("agent_end", { messages: [] }, ctx);

    expect(harness.api.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("plan_mode_todo"),
      { deliverAs: "followUp" },
    );
  });

  it("requires a TODO for plan mode turns even when read-only feedback is provided", async () => {
    const { harness, ctx } = await startPlanModeSession();

    await sendAgentPrompt(
      harness,
      ctx,
      "why does the todo widget keep showing?",
    );
    await harness.emit("agent_end", { messages: [] }, ctx);

    expect(harness.api.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("plan_mode_todo"),
      { deliverAs: "followUp" },
    );
  });

  it("injects architecture testing guidance into implementation plans", async () => {
    const { harness, ctx } = await startPlanModeSession();

    const result = await sendAgentPrompt(
      harness,
      ctx,
      "fix the plan mode guard bug",
    );

    expect(result).toMatchObject({
      systemPrompt: expect.stringMatching(
        /写测试[\s\S]+Module[\s\S]+Interface[\s\S]+test surface/u,
      ),
    });
  });

  it("injects mandatory diagrams guidance for code logic changes", async () => {
    const { harness, ctx } = await startPlanModeSession();

    const result = await sendAgentPrompt(
      harness,
      ctx,
      "fix the plan mode guard bug",
    );

    expect(result).toMatchObject({
      systemPrompt: expect.stringMatching(
        /写代码且涉及逻辑、状态、数据模型、控制流或流程变更[\s\S]+必须包含变更前后/u,
      ),
    });
  });

  it("requires color-coded diagram changes in implementation plans", async () => {
    const { harness, ctx } = await startPlanModeSession();

    const result = await sendAgentPrompt(
      harness,
      ctx,
      "fix the plan mode guard bug",
    );

    expect(result).toMatchObject({
      systemPrompt: expect.stringMatching(
        /颜色[\s\S]+数据变更[\s\S]+逻辑变更[\s\S]+新增[\s\S]+删除[\s\S]+修改/u,
      ),
    });
  });

  it("requires key code sketches in code-changing plans", async () => {
    const { harness, ctx } = await startPlanModeSession();
    const keyCodeSketchPattern = [
      "关键代码草案",
      "类型",
      "函数签名",
      "条件判断",
      "状态迁移",
      "测试断言",
    ].join("[\\s\\S]+");

    const result = await sendAgentPrompt(
      harness,
      ctx,
      "fix the plan mode guard bug",
    );

    expect(result).toMatchObject({
      systemPrompt: expect.stringMatching(
        new RegExp(keyCodeSketchPattern, "u"),
      ),
    });
    expect(result).toMatchObject({
      systemPrompt: expect.stringMatching(/## Context[\s\S]+不能新增顶层章节/u),
    });
  });

  it("still requires a TODO for user implementation prompts in plan mode", async () => {
    const { harness, ctx } = await startPlanModeSession();

    await sendInput(harness, ctx, "fix the plan mode guard bug", "interactive");
    await sendAgentPrompt(harness, ctx, "fix the plan mode guard bug");
    await harness.emit("agent_end", { messages: [] }, ctx);

    expect(harness.api.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("plan_mode_todo"),
      { deliverAs: "followUp" },
    );
    expect(harness.api.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("plan mode requires a reviewed plan/spec"),
      { deliverAs: "followUp" },
    );
  });

  it("does not require plan review for extension-sourced implementation prompts", async () => {
    const { harness, ctx } = await startPlanModeSession();

    await sendInput(harness, ctx, "refactor the modified code", "extension");
    await sendAgentPrompt(harness, ctx, "refactor the modified code");
    await harness.emit("agent_end", { messages: [] }, ctx);

    expect(harness.api.sendUserMessage).not.toHaveBeenCalledWith(
      expect.stringContaining("plan_mode_todo"),
      expect.anything(),
    );
    expect(harness.api.sendUserMessage).not.toHaveBeenCalledWith(
      expect.stringContaining("approved Plannotator plan/spec"),
      expect.anything(),
    );
  });

  it("allows any tool during extension-sourced implementation prompts", async () => {
    const { harness, ctx } = await startPlanModeSession();

    await sendInput(harness, ctx, "refactor the modified code", "extension");
    await sendAgentPrompt(harness, ctx, "refactor the modified code");

    await expect(
      harness.runToolCall("bash", { command: "rm -rf src" }, ctx),
    ).resolves.toBeUndefined();
    await expect(
      harness.runToolCall("write", { path: "src/demo.ts" }, ctx),
    ).resolves.toBeUndefined();
  });

  it("explains why plan mode is waiting for approved review", async () => {
    const { harness, ctx } = await startPlanModeSession();

    await sendAgentPrompt(
      harness,
      ctx,
      "why is this workflow asking for TODOs?",
    );
    await harness.runTool(
      PLAN_MODE_TODO_TOOL,
      {
        action: "set",
        items: [{ text: "记录诊断结论", status: "todo" }],
      },
      ctx,
    );
    await harness.emit("agent_end", { messages: [] }, ctx);

    expect(harness.api.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("approved Plannotator plan/spec"),
      { deliverAs: "followUp" },
    );
    expect(harness.api.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining(
        "Reason: active TODO run has no approved plan/spec artifact",
      ),
      { deliverAs: "followUp" },
    );
  });

  it("keeps plan mode guarded even when workflow feedback is provided", async () => {
    const { harness, ctx } = await startPlanModeSession();

    const result = await sendAgentPrompt(harness, ctx, "提交当前改动", {
      kind: "workflow_only",
      confidence: 0.9,
      reason: "User requested only an operational workflow.",
      evidence: ["commit existing changes"],
      requestedOperations: ["git status", "git commit"],
    });

    expect(result).toMatchObject({
      systemPrompt: expect.stringContaining("Current mode: plan."),
    });
    await expect(
      harness.runToolCall("bash", { command: "git status --short" }, ctx),
    ).resolves.toMatchObject({ block: true });
  });

  it("keeps commit-only prompts in normal plan mode", async () => {
    const { harness, ctx } = await startPlanModeSession();

    await sendAgentPrompt(harness, ctx, commitWithoutBranchPrompt);

    expect(lastPersistedPlanModeSnapshot(harness)).toMatchObject({
      mode: "plan",
      phase: "plan",
    });
    await expect(
      harness.runToolCall("bash", { command: "git status --short" }, ctx),
    ).resolves.toMatchObject({ block: true });
  });

  it("keeps implementation prompts in normal plan mode", async () => {
    const { harness, ctx } = await startPlanModeSession();

    await sendAgentPrompt(harness, ctx, "fix the bug and commit");

    await expect(
      harness.runToolCall("bash", { command: "git status --short" }, ctx),
    ).resolves.toMatchObject({ block: true });
  });

  it("skips plan reminders after an aborted assistant turn", async () => {
    const harness = buildHarness();
    const ctx = buildCtx();
    planModeExtension(harness.api as unknown as ExtensionAPI);
    await harness.emit("session_start", {}, ctx);
    await harness.runCommand("plan-mode", "plan", ctx);

    await harness.emit(
      "agent_end",
      { messages: [{ role: "assistant", stopReason: "aborted" }] },
      ctx,
    );

    expect(harness.api.sendUserMessage).not.toHaveBeenCalled();
  });

  it("skips plan reminders when the runtime signal was aborted", async () => {
    const harness = buildHarness();
    const abortController = new AbortController();
    abortController.abort();
    const ctx = { ...buildCtx(), signal: abortController.signal };
    planModeExtension(harness.api as unknown as ExtensionAPI);
    await harness.emit("session_start", {}, ctx);
    await harness.runCommand("plan-mode", "plan", ctx);

    await harness.emit("agent_end", { messages: [] }, ctx);

    expect(harness.api.sendUserMessage).not.toHaveBeenCalled();
  });

  it("switches plan mode to act phase after plannotator approves the submitted plan", async () => {
    const harness = buildHarness();
    const ctx = buildCtx();
    planModeExtension(harness.api as unknown as ExtensionAPI);
    await harness.emit("session_start", {}, ctx);
    await harness.runCommand("plan-mode", "plan", ctx);

    await approveDemoPlan(harness, ctx);

    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("plan-mode", undefined);
    await expect(
      harness.runToolCall("write", { path: "x.ts" }, ctx),
    ).resolves.toBeUndefined();
  });

  it("plan-continues approved plans for balanced preset", async () => {
    const harness = buildHarness();
    const { ctx, cleanup } = createTempCtx();
    writeProjectSettings(ctx.cwd, {
      planMode: { defaultMode: "plan", preset: "balanced" },
    });
    writePlanArtifact(ctx.cwd, demoPlanPath, validPlanContent);
    planModeExtension(harness.api as unknown as ExtensionAPI);
    await harness.emit("session_start", {}, ctx);

    try {
      await completeApprovedDemoRun(harness, ctx, "提交 reviewable plan");
      await harness.emit("agent_end", { messages: [] }, ctx);

      expect(ctx.ui.confirm).not.toHaveBeenCalled();
      expectApprovedContinuationFollowUp(harness);
    } finally {
      cleanup();
    }
  });

  it("ignores legacy manual approval continuation config", async () => {
    const harness = buildHarness();
    const { ctx, cleanup } = createTempCtx();
    writeProjectSettings(ctx.cwd, {
      planMode: { approval: { continueAfterApproval: "manual" } },
    });
    writePlanArtifact(ctx.cwd, demoPlanPath, validPlanContent);
    planModeExtension(harness.api as unknown as ExtensionAPI);
    await harness.emit("session_start", {}, ctx);
    await harness.runCommand("plan-mode", "plan", ctx);

    try {
      await completeApprovedDemoRun(harness, ctx, "提交 reviewable plan");
      await harness.emit("agent_end", { messages: [] }, ctx);

      expect(ctx.ui.confirm).not.toHaveBeenCalled();
      expectApprovedContinuationFollowUp(harness);
      expect(lastPersistedPlanModeSnapshot(harness)).toMatchObject({
        confirmedApprovedContinuationPath: demoPlanPath,
      });
    } finally {
      cleanup();
    }
  });

  it("solo preset disables review waiting reminders", async () => {
    const harness = buildHarness();
    const { ctx, cleanup } = createTempCtx();
    writeProjectSettings(ctx.cwd, { planMode: { preset: "solo" } });
    planModeExtension(harness.api as unknown as ExtensionAPI);
    await harness.emit("session_start", {}, ctx);

    try {
      await harness.runTool(
        PLAN_MODE_TODO_TOOL,
        {
          action: "set",
          items: [{ text: "solo task", status: "todo" }],
        },
        ctx,
      );
      await harness.emit("agent_end", { messages: [] }, ctx);

      expect(harness.api.sendUserMessage).not.toHaveBeenCalledWith(
        expect.stringContaining("approved Plannotator plan/spec"),
        expect.anything(),
      );
    } finally {
      cleanup();
    }
  });

  it("injects an implementation follow-up after approved continuation is confirmed", async () => {
    const harness = buildHarness();
    const { ctx, cleanup } = createTempCtx();
    writePlanArtifact(ctx.cwd, demoPlanPath, validPlanContent);
    planModeExtension(harness.api as unknown as ExtensionAPI);
    await harness.emit("session_start", {}, ctx);
    await harness.runCommand("plan-mode", "plan", ctx);

    try {
      await completeApprovedDemoRun(harness, ctx, "提交 reviewable plan");
      await harness.emit("agent_end", { messages: [] }, ctx);

      expect(ctx.ui.confirm).not.toHaveBeenCalled();
      expectApprovedContinuationFollowUp(harness);
      expect(lastPersistedPlanModeSnapshot(harness)).toMatchObject({
        confirmedApprovedContinuationPath: demoPlanPath,
      });
    } finally {
      cleanup();
    }
  });

  it("consumes confirmed continuation and allows act tools without prompt matching", async () => {
    const harness = buildHarness();
    const { ctx, cleanup } = createTempCtx();
    writePlanArtifact(ctx.cwd, demoPlanPath, validPlanContent);
    planModeExtension(harness.api as unknown as ExtensionAPI);
    await harness.emit("session_start", {}, ctx);

    try {
      await completeApprovedDemoRun(harness, ctx, "提交 reviewable plan");
      await harness.emit("agent_end", { messages: [] }, ctx);
      await sendAgentPrompt(harness, ctx, "start");

      await expect(
        harness.runToolCall("bash", { command: "npm test" }, ctx),
      ).resolves.toBeUndefined();
      expect(lastPersistedPlanModeSnapshot(harness)).toMatchObject({
        phase: "act",
        activePlanPath: demoPlanPath,
        confirmedApprovedContinuationPath: null,
      });
    } finally {
      cleanup();
    }
  });

  it("does not offer a decline path for approved continuation", async () => {
    const harness = buildHarness();
    const { ctx, cleanup } = createTempCtx();
    ctx.ui.confirm.mockResolvedValueOnce(false);
    writePlanArtifact(ctx.cwd, demoPlanPath, validPlanContent);
    planModeExtension(harness.api as unknown as ExtensionAPI);
    await harness.emit("session_start", {}, ctx);
    await harness.runCommand("plan-mode", "plan", ctx);

    try {
      await completeApprovedDemoRun(harness, ctx, "提交 reviewable plan");
      await harness.emit("agent_end", { messages: [] }, ctx);

      expect(ctx.ui.confirm).not.toHaveBeenCalled();
      expectApprovedContinuationFollowUp(harness);
      expect(lastPersistedPlanModeSnapshot(harness)).toMatchObject({
        confirmedApprovedContinuationPath: demoPlanPath,
      });
    } finally {
      cleanup();
    }
  });

  it("does not recover approved act context from prompt matching alone", async () => {
    const harness = buildHarness();
    const ctx = buildCtx();
    planModeExtension(harness.api as unknown as ExtensionAPI);
    await harness.emit("session_start", {}, ctx);
    await harness.runCommand("plan-mode", "plan", ctx);

    await completeApprovedDemoRun(harness, ctx, "提交 reviewable plan");
    await sendAgentPrompt(harness, ctx, "迁移到 Svelte + Vite");
    await sendAgentPrompt(harness, ctx, "impl it");

    await expect(
      harness.runToolCall("write", { path: "x.ts" }, ctx),
    ).resolves.toMatchObject({ block: true });
  });

  it("returns plan act to plan after a completed run gets a new implementation prompt", async () => {
    const harness = buildHarness();
    const ctx = buildCtx();
    planModeExtension(harness.api as unknown as ExtensionAPI);
    await harness.emit("session_start", {}, ctx);
    await harness.runCommand("plan-mode", "plan", ctx);

    await completeApprovedDemoRun(harness, ctx);

    await sendAgentPrompt(harness, ctx, "迁移到 Svelte + Vite");

    await expect(
      harness.runToolCall("write", { path: "x.ts" }, ctx),
    ).resolves.toMatchObject({ block: true });
    await expect(
      harness.runToolCall("bash", { command: "npm test" }, ctx),
    ).resolves.toMatchObject({ block: true });
  });

  it("does not keep plan act from approved continuation prompt matching", async () => {
    const harness = buildHarness();
    const ctx = buildCtx();
    planModeExtension(harness.api as unknown as ExtensionAPI);
    await harness.emit("session_start", {}, ctx);
    await harness.runCommand("plan-mode", "plan", ctx);

    await completeApprovedDemoRun(harness, ctx, "写入并提交 reviewable plan");

    await sendAgentPrompt(harness, ctx, "impl the plan");

    await expect(
      harness.runToolCall("write", { path: "x.ts" }, ctx),
    ).resolves.toMatchObject({ block: true });

    const result = await harness.runTool(
      PLAN_MODE_TODO_TOOL,
      {
        action: "set",
        items: [{ text: "实现已批准 plan", status: "todo" }],
      },
      ctx,
    );
    expect(result).toMatchObject({
      details: {
        activeRun: {
          planPath: null,
          status: "draft",
        },
      },
    });
  });

  it("keeps plan act for a new prompt while the approved run is unfinished", async () => {
    const harness = buildHarness();
    const ctx = buildCtx();
    planModeExtension(harness.api as unknown as ExtensionAPI);
    await harness.emit("session_start", {}, ctx);

    await startApprovedDemoRun(harness, ctx);

    await sendAgentPrompt(harness, ctx, "go ahead");

    await expect(
      harness.runToolCall("write", { path: "x.ts" }, ctx),
    ).resolves.toBeUndefined();
  });

  it("does not restore approved act context while fixing approved artifact policy", async () => {
    const { harness, ctx } = await startPlanModeSession();

    await completeApprovedDemoRun(harness, ctx);

    await sendAgentPrompt(harness, ctx, approvedPlanPolicyFixPrompt);

    const result = await harness.runTool(
      PLAN_MODE_TODO_TOOL,
      {
        action: "set",
        items: [
          {
            text: "修正已批准计划的 Review 段",
            status: "in_progress",
          },
        ],
      },
      ctx,
    );

    expect(result).toMatchObject({
      details: {
        activeRun: {
          planPath: null,
          status: "draft",
        },
      },
    });
    await expect(
      harness.runToolCall("write", { path: "x.ts" }, ctx),
    ).resolves.toMatchObject({ block: true });
  });

  it("uses the submitted path when approved review details omit the path", async () => {
    const harness = buildHarness();
    const ctx = buildCtx();
    planModeExtension(harness.api as unknown as ExtensionAPI);
    await harness.emit("session_start", {}, ctx);

    await harness.emit(
      "tool_result",
      {
        toolName: PLANNOTATOR_REVIEW_TOOL,
        isError: false,
        input: { path: ".pi/plans/pi-kit/plan/2026-05-08-demo.md" },
        content: [{ type: "text", text: "Review approved." }],
        details: { status: "approved" },
      },
      ctx,
    );

    await expect(
      harness.runToolCall("write", { path: "x.ts" }, ctx),
    ).resolves.toBeUndefined();
  });

  it("requires review again after a newer plan artifact is written", async () => {
    const harness = buildHarness();
    const { ctx, cleanup } = createTempCtx();
    const firstPlanPath = ".pi/plans/pi-kit/plan/2026-05-08-first.md";
    const secondPlanPath = ".pi/plans/pi-kit/plan/2026-05-08-second.md";
    writePlanArtifact(ctx.cwd, firstPlanPath, validPlanContent);
    writePlanArtifact(ctx.cwd, secondPlanPath, validPlanContent);
    planModeExtension(harness.api as unknown as ExtensionAPI);

    try {
      await harness.emit("session_start", {}, ctx);

      await harness.emit(
        "tool_result",
        {
          toolName: "write",
          isError: false,
          input: { path: firstPlanPath },
        },
        ctx,
      );
      await harness.emit(
        "tool_result",
        {
          toolName: PLANNOTATOR_REVIEW_TOOL,
          isError: false,
          input: { path: firstPlanPath },
          content: [
            { type: "text", text: `Review approved for ${firstPlanPath}.` },
          ],
        },
        ctx,
      );
      await harness.runCommand("plan-mode", "plan", ctx);
      await harness.runTool(
        PLAN_MODE_TODO_TOOL,
        {
          action: "set",
          items: [{ text: "实现第二个任务", status: "todo" }],
        },
        ctx,
      );
      await harness.emit(
        "tool_result",
        {
          toolName: "write",
          isError: false,
          input: { path: secondPlanPath },
        },
        ctx,
      );

      await harness.emit("agent_end", { messages: [] }, ctx);

      expect(harness.api.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining("approved Plannotator plan/spec"),
        { deliverAs: "followUp" },
      );
    } finally {
      cleanup();
    }
  });

  it("blocks review submission when a plan artifact violates the policy", async () => {
    await withTempCtx(async (ctx) => {
      const planPath = ".pi/plans/pi-kit/plan/2026-05-08-demo.md";
      writePlanArtifact(ctx.cwd, planPath, invalidPlanContent);
      const { harness } = await startPlanModeSession("act", ctx);

      await expectToolBlocked(
        harness,
        ctx,
        PLANNOTATOR_REVIEW_TOOL,
        { path: planPath },
        {
          block: true,
          reason: expect.stringContaining("Plan Mode artifact policy"),
        },
      );
    });
  });

  it("allows review submission when a plan artifact satisfies the policy", async () => {
    await withTempCtx(async (ctx) => {
      const planPath = ".pi/plans/pi-kit/plan/2026-05-08-demo.md";
      writePlanArtifact(ctx.cwd, planPath, validPlanContent);
      const { harness } = await startPlanModeSession("act", ctx);

      await expectToolAllowed(harness, ctx, PLANNOTATOR_REVIEW_TOOL, {
        path: planPath,
      });
    });
  });

  it("reminds the agent to fix the latest invalid plan artifact", async () => {
    await withTempCtx(async (ctx) => {
      const planPath = ".pi/plans/pi-kit/plan/2026-05-08-demo.md";
      writePlanArtifact(ctx.cwd, planPath, invalidPlanContent);
      const { harness } = await startPlanModeSession("act", ctx);

      await harness.runTool(
        PLAN_MODE_TODO_TOOL,
        {
          action: "set",
          items: [{ text: "修复 plan 格式", status: "todo" }],
        },
        ctx,
      );
      await harness.emit(
        "tool_result",
        {
          toolName: "write",
          isError: false,
          input: { path: planPath },
        },
        ctx,
      );

      await harness.emit("agent_end", { messages: [] }, ctx);

      const [[message, options]] = harness.api.sendUserMessage.mock.calls;
      expect(message).toEqual(
        expect.stringContaining("Plan Mode artifact policy"),
      );
      expect(message).toEqual(
        expect.stringContaining("plannotator_auto_submit_review"),
      );
      expect(options).toEqual({ deliverAs: "followUp" });
    });
  });

  it("does not ask to resubmit review for an approved invalid plan artifact", async () => {
    await withTempCtx(async (ctx) => {
      const planPath = ".pi/plans/pi-kit/plan/2026-05-08-demo.md";
      writePlanArtifact(ctx.cwd, planPath, invalidPlanContent);
      const { harness } = await startPlanModeSession("act", ctx);

      await harness.runTool(
        PLAN_MODE_TODO_TOOL,
        {
          action: "set",
          items: [{ text: "修复已批准 plan 格式", status: "todo" }],
        },
        ctx,
      );
      await harness.emit(
        "tool_result",
        {
          toolName: PLANNOTATOR_REVIEW_TOOL,
          isError: false,
          input: { path: planPath },
          content: [{ type: "text", text: `Review approved for ${planPath}.` }],
        },
        ctx,
      );

      await harness.emit("agent_end", { messages: [] }, ctx);

      const [[message, options]] = harness.api.sendUserMessage.mock.calls;
      expect(message).toEqual(
        expect.stringContaining("Plan Mode artifact policy"),
      );
      expect(message).not.toContain("plannotator_auto_submit_review");
      expect(options).toEqual({ deliverAs: "followUp" });
    });
  });
});
