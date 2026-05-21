import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, vi } from "vitest";
import {
  ACT_TODO_TOOL_NAME as ACT_MODE_TODO_TOOL,
  MODE_WIDGET_KEY as PLAN_MODE_CURRENT_MODE_WIDGET,
  STATE_ENTRY_TYPE as PLAN_MODE_STATE_ENTRY,
  TODO_TOOL_NAME as PLAN_MODE_TODO_TOOL,
  TODO_WIDGET_KEY as PLAN_MODE_TODOS_WIDGET,
  PLANNOTATOR_SUBMIT_TOOL_NAME as PLANNOTATOR_REVIEW_TOOL,
} from "./constants.js";
import planModeExtension, {
  getPlanModeArgumentCompletions,
  parsePlanModeCommand,
} from "./index.js";

export {
  ACT_MODE_TODO_TOOL,
  fs,
  getPlanModeArgumentCompletions,
  PLAN_MODE_CURRENT_MODE_WIDGET,
  PLAN_MODE_STATE_ENTRY,
  PLAN_MODE_TODO_TOOL,
  PLAN_MODE_TODOS_WIDGET,
  PLANNOTATOR_REVIEW_TOOL,
  parsePlanModeCommand,
  path,
  planModeExtension,
  vi,
};

export type Handler = (
  event: unknown,
  ctx: TestCtx,
) => Promise<unknown> | unknown;
export type CommandRegistration = {
  description: string;
  handler: (args: string, ctx: TestCtx) => Promise<unknown> | unknown;
};
export type ToolRegistration = {
  name: string;
  label?: string;
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
export type ShortcutRegistration = {
  description?: string;
  handler: (ctx: TestCtx) => Promise<void> | void;
};
export type CustomEntry = {
  type: "custom";
  customType: string;
  data?: unknown;
};
export type TestCtx = {
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

export const buildHarness = () => {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, CommandRegistration>();
  const shortcuts = new Map<string, ShortcutRegistration>();
  const tools = new Map<string, ToolRegistration>();
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
    registerShortcut: vi.fn(
      (shortcut: string, registration: ShortcutRegistration) => {
        shortcuts.set(shortcut, registration);
      },
    ),
    appendEntry: vi.fn(),
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

  const runShortcut = async (shortcut: string, ctx: TestCtx) => {
    const registration = shortcuts.get(shortcut);
    if (!registration) throw new Error(`Missing shortcut: ${shortcut}`);
    return registration.handler(ctx);
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
    runShortcut,
    runTool,
    runToolCall,
  };
};

export const buildCtx = (
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

export const lastTodoWidgetCall = (ctx: TestCtx) => {
  const call = ctx.ui.setWidget.mock.calls.findLast(
    ([key]) => key === PLAN_MODE_TODOS_WIDGET,
  );
  if (!call) throw new Error("Expected a plan-mode TODO widget call");
  return call;
};

export const lastModeWidgetCall = (ctx: TestCtx) => {
  const call = ctx.ui.setWidget.mock.calls.findLast(
    ([key]) => key === PLAN_MODE_CURRENT_MODE_WIDGET,
  );
  if (!call) throw new Error("Expected a plan-mode current mode widget call");
  return call;
};

export const lastWidgetLines = (ctx: TestCtx): string[] =>
  lastTodoWidgetCall(ctx)[1] as string[];

export const expectPromptContract = (prompt: string, terms: string[]): void => {
  for (const term of terms) {
    expect(prompt).toContain(term);
  }
};

export const plainWidgetText = (ctx: TestCtx): string =>
  lastWidgetLines(ctx)
    .join("\n")
    .replace(/<[^>]+>/gu, "");

export const planModeStateEntry = (
  data: Record<string, unknown>,
): CustomEntry => ({
  type: "custom",
  customType: PLAN_MODE_STATE_ENTRY,
  data,
});

export const lastPersistedPlanModeSnapshot = (
  harness: ReturnType<typeof buildHarness>,
): Record<string, unknown> => {
  const call = harness.api.appendEntry.mock.calls.findLast(
    ([customType]) => customType === PLAN_MODE_STATE_ENTRY,
  );
  if (!call) throw new Error("Expected a plan-mode state entry");
  return call[1] as Record<string, unknown>;
};

export const registeredTool = (
  harness: ReturnType<typeof buildHarness>,
  name: string,
): ToolRegistration => {
  const tool = harness.api.registerTool.mock.calls
    .map(([registration]) => registration)
    .find((registration) => registration.name === name);
  if (!tool) throw new Error(`Expected registered tool: ${name}`);
  return tool;
};

export const createTempCtx = (): { ctx: TestCtx; cleanup: () => void } => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "plan-mode-policy-"));
  return {
    ctx: { ...buildCtx(), cwd },
    cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }),
  };
};

export const withTempCtx = async (
  run: (ctx: TestCtx) => Promise<void>,
): Promise<void> => {
  const { ctx, cleanup } = createTempCtx();
  try {
    await run(ctx);
  } finally {
    cleanup();
  }
};

export const writePlanArtifact = (
  cwd: string,
  relativePath: string,
  content: string,
): void => {
  const absolutePath = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content, "utf-8");
};

export const writeProjectSettings = (
  cwd: string,
  settings: Record<string, unknown>,
): void => {
  const settingsPath = path.join(cwd, ".pi", "third_extension_settings.json");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings), "utf-8");
};

export const writeSourceFile = (
  ctx: TestCtx,
  relativePath: string,
  content = "export {};\n",
): void => {
  const absolutePath = path.join(ctx.cwd, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content, "utf-8");
};

export const markFileRead = async (
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

export const startPlanModeSession = async (
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

export const expectToolBlocked = async (
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

export const expectToolAllowed = async (
  harness: ReturnType<typeof buildHarness>,
  ctx: TestCtx,
  toolName: string,
  input: Record<string, unknown>,
): Promise<void> => {
  await expect(
    harness.runToolCall(toolName, input, ctx),
  ).resolves.toBeUndefined();
};

export const sendInput = async (
  harness: ReturnType<typeof buildHarness>,
  ctx: TestCtx,
  text: string,
  source: string,
) => harness.emit("input", { text, source }, ctx);

export const sendAgentPrompt = async (
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

export const commitWithoutBranchPrompt = "commit and no extra branch";
export const directActTodoGuidance =
  "In direct act mode, create concrete TODOs before using tools or making changes.";

export const validPlanContent = `## Context
- 用户希望用中文描述计划背景、成功标准和受影响模块。

## Steps
- [ ] 编写失败测试
- [ ] 实现最小代码

## Verification
- 运行 npm test -- extensions/plan-mode

## Review
- 待实现后记录改动点、验证结果、剩余风险和 bug 修复原因。
`;

export const invalidPlanContent = validPlanContent.replace(
  "## Review",
  "## Notes",
);
export const oneItemCompletedSummary = "✅ 任务已完成 · 1/1 项任务已交付";
export const completedTaskSummary = (
  heading: string,
  tasks: string[],
): string =>
  [
    heading,
    "已交付：",
    ...tasks.map((task, index) => `  #${index + 1} ${task}`),
  ].join("\n");
export const prefixedCompletedSummary = (...tasks: string[]): string =>
  `【completed】${completedTaskSummary(oneItemCompletedSummary, tasks)}`;
export const actOneItemCompletedSummary =
  prefixedCompletedSummary("完成第一批任务");
export const planOneItemCompletedSummary =
  prefixedCompletedSummary("完成后清理");
export const demoPlanPath = ".pi/plans/pi-kit/plan/2026-05-08-demo.md";
export const demoCompletedSummary = completedTaskSummary(
  "✅ 计划「demo」已完成 · 3/3 项任务已交付",
  ["编写测试", "实现改动", "验证结果"],
);

export const expectNoApprovedContinuationFollowUp = (
  harness: ReturnType<typeof buildHarness>,
): void => {
  expect(harness.api.sendUserMessage).not.toHaveBeenCalledWith(
    expect.stringContaining(
      `Continue implementing approved plan: ${demoPlanPath}`,
    ),
    expect.anything(),
  );
  expect(harness.api.sendUserMessage).not.toHaveBeenCalledWith(
    expect.stringContaining("Update act_mode_todo"),
    expect.anything(),
  );
};

export const expectNoApprovedArtifactChangedFollowUp = (
  harness: ReturnType<typeof buildHarness>,
): void => {
  expect(harness.api.sendUserMessage).not.toHaveBeenCalledWith(
    expect.stringContaining("approved artifact changed"),
    expect.anything(),
  );
};

export const actCompletedDemoSummary = `【completed, back to Act】${demoCompletedSummary}`;
export const approvedPlanPolicyFixPrompt = [
  "Plan Mode artifact policy requires fixes for an already approved plan.",
  `Path: ${demoPlanPath}`,
  "",
  "Fix the plan format before continuing with the approved plan:",
  "- ## Review 缺少后续结果记录要求。 (Review)",
].join("\n");

export const emitApprovedReview = async (
  harness: ReturnType<typeof buildHarness>,
  ctx: TestCtx,
  planPath: string,
): Promise<void> => {
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
};

export const approveDemoPlan = async (
  harness: ReturnType<typeof buildHarness>,
  ctx: TestCtx,
): Promise<void> => {
  await emitApprovedReview(harness, ctx, demoPlanPath);
};

export const startApprovedDemoRun = async (
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

export const emitAbortedAgentEnd = async (
  harness: ReturnType<typeof buildHarness>,
  ctx: TestCtx,
): Promise<void> => {
  await harness.emit(
    "agent_end",
    { messages: [{ role: "assistant", stopReason: "aborted" }] },
    ctx,
  );
};

export const emitReviewArtifactWrite = async (
  harness: ReturnType<typeof buildHarness>,
  ctx: TestCtx,
  artifactPath: string,
): Promise<void> => {
  await harness.emit(
    "tool_result",
    {
      toolName: "write",
      isError: false,
      input: { path: artifactPath },
    },
    ctx,
  );
};

export const completeApprovedDemoRun = async (
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
