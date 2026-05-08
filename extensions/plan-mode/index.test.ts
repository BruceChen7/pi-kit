import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import planModeExtension from "./index.js";

type Handler = (event: unknown, ctx: TestCtx) => Promise<unknown> | unknown;
type CommandRegistration = {
  description: string;
  handler: (args: string, ctx: TestCtx) => Promise<unknown> | unknown;
};
type ToolRegistration = {
  name: string;
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
  ui: {
    notify: ReturnType<typeof vi.fn>;
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
  };
};

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

const buildCtx = (entries: CustomEntry[] = []): TestCtx => ({
  cwd: "/repo",
  hasUI: true,
  isIdle: () => true,
  ui: {
    notify: vi.fn(),
    setStatus: vi.fn(),
    setWidget: vi.fn(),
    theme: {
      fg: (_tone: string, text: string) => text,
      strikethrough: (text: string) => `~~${text}~~`,
    },
  },
  sessionManager: {
    getSessionFile: () => "/repo/.pi/session.jsonl",
    getEntries: () => entries,
  },
});

const lastWidgetLines = (ctx: TestCtx): string[] => {
  const calls = ctx.ui.setWidget.mock.calls.filter(
    (call) => call[0] === "plan-mode-todos",
  );
  return calls.at(-1)?.[1] as string[];
};

const createTempCtx = (): { ctx: TestCtx; cleanup: () => void } => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "plan-mode-policy-"));
  return {
    ctx: { ...buildCtx(), cwd },
    cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }),
  };
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

describe("plan-mode extension", () => {
  it("blocks source writes during auto plan phase but allows review artifact writes", async () => {
    const harness = buildHarness();
    const ctx = buildCtx();
    planModeExtension(harness.api as unknown as ExtensionAPI);

    await harness.emit("session_start", {}, ctx);

    await expect(
      harness.runToolCall("write", { path: "x.ts" }, ctx),
    ).resolves.toMatchObject({ block: true });
    await expect(
      harness.runToolCall("edit", { path: "x.ts" }, ctx),
    ).resolves.toMatchObject({ block: true });
    await expect(
      harness.runToolCall("bash", { command: "npm test" }, ctx),
    ).resolves.toMatchObject({ block: true });
    await expect(
      harness.runToolCall(
        "write",
        { path: ".pi/plans/pi-kit/plan/2026-05-08-demo.md" },
        ctx,
      ),
    ).resolves.toBeUndefined();
    await expect(
      harness.runToolCall(
        "write",
        { path: ".pi/plans/pi-kit/specs/2026-05-08-demo-design.md" },
        ctx,
      ),
    ).resolves.toBeUndefined();

    await harness.runCommand("plan-mode", "act", ctx);
    await expect(
      harness.runToolCall("write", { path: "x.ts" }, ctx),
    ).resolves.toBeUndefined();

    await harness.runCommand("plan-mode", "fast", ctx);
    await expect(
      harness.runToolCall("bash", { command: "npm test" }, ctx),
    ).resolves.toBeUndefined();
  });

  it("allows reads outside cwd while still blocking writes outside cwd", async () => {
    const harness = buildHarness();
    const ctx = buildCtx();
    const outsidePath = "/tmp/outside-cwd.txt";
    planModeExtension(harness.api as unknown as ExtensionAPI);

    await harness.emit("session_start", {}, ctx);

    await expect(
      harness.runToolCall("read", { path: outsidePath }, ctx),
    ).resolves.toBeUndefined();

    await harness.runCommand("plan-mode", "act", ctx);
    await expect(
      harness.runToolCall("write", { path: outsidePath }, ctx),
    ).resolves.toMatchObject({
      block: true,
      reason: expect.stringContaining("path is outside cwd"),
    });
  });

  it("updates the act widget with the current in-progress step and completion counts", async () => {
    const harness = buildHarness();
    const ctx = buildCtx();
    planModeExtension(harness.api as unknown as ExtensionAPI);
    await harness.emit("session_start", {}, ctx);
    await harness.runCommand("plan-mode", "act", ctx);

    await harness.runTool(
      "plan_mode_todo",
      {
        action: "set",
        items: [
          { text: "实现状态机", status: "in_progress" },
          { text: "补充 README", status: "todo" },
        ],
      },
      ctx,
    );

    const widget = lastWidgetLines(ctx).join("\n");
    expect(widget).toContain("当前 #1/2");
    expect(widget).toContain("实现状态机");
    expect(widget).toContain("0/2 done");
  });

  it("restores mode and todos from the latest session snapshot", async () => {
    const restoredEntries: CustomEntry[] = [
      {
        type: "custom",
        customType: "plan-mode-state",
        data: {
          mode: "act",
          phase: "act",
          todos: [{ id: 1, text: "恢复后的当前步骤", status: "in_progress" }],
          nextTodoId: 2,
          readFiles: [],
          activePlanPath: null,
          reviewApprovedPlanPaths: [],
          endConversationRequested: false,
        },
      },
    ];
    const harness = buildHarness();
    const ctx = buildCtx(restoredEntries);
    planModeExtension(harness.api as unknown as ExtensionAPI);

    await harness.emit("session_start", {}, ctx);

    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "plan-mode",
      expect.stringContaining("act 0/1"),
    );
    expect(lastWidgetLines(ctx).join("\n")).toContain("恢复后的当前步骤");
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

  it("switches auto plan to act after plannotator approves the submitted plan", async () => {
    const harness = buildHarness();
    const ctx = buildCtx();
    planModeExtension(harness.api as unknown as ExtensionAPI);
    await harness.emit("session_start", {}, ctx);

    await harness.emit(
      "tool_result",
      {
        toolName: "plannotator_auto_submit_review",
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

    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "plan-mode",
      expect.stringContaining("auto:act"),
    );
    await expect(
      harness.runToolCall("write", { path: "x.ts" }, ctx),
    ).resolves.toBeUndefined();
  });

  it("blocks review submission when a plan artifact violates the policy", async () => {
    const harness = buildHarness();
    const { ctx, cleanup } = createTempCtx();
    const planPath = ".pi/plans/pi-kit/plan/2026-05-08-demo.md";
    writePlanArtifact(ctx.cwd, planPath, invalidPlanContent);
    planModeExtension(harness.api as unknown as ExtensionAPI);

    try {
      await harness.emit("session_start", {}, ctx);

      await expect(
        harness.runToolCall(
          "plannotator_auto_submit_review",
          { path: planPath },
          ctx,
        ),
      ).resolves.toMatchObject({
        block: true,
        reason: expect.stringContaining("Plan Mode artifact policy"),
      });
    } finally {
      cleanup();
    }
  });

  it("allows review submission when a plan artifact satisfies the policy", async () => {
    const harness = buildHarness();
    const { ctx, cleanup } = createTempCtx();
    const planPath = ".pi/plans/pi-kit/plan/2026-05-08-demo.md";
    writePlanArtifact(ctx.cwd, planPath, validPlanContent);
    planModeExtension(harness.api as unknown as ExtensionAPI);

    try {
      await harness.emit("session_start", {}, ctx);

      await expect(
        harness.runToolCall(
          "plannotator_auto_submit_review",
          { path: planPath },
          ctx,
        ),
      ).resolves.toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("reminds the agent to fix the latest invalid plan artifact", async () => {
    const harness = buildHarness();
    const { ctx, cleanup } = createTempCtx();
    const planPath = ".pi/plans/pi-kit/plan/2026-05-08-demo.md";
    writePlanArtifact(ctx.cwd, planPath, invalidPlanContent);
    planModeExtension(harness.api as unknown as ExtensionAPI);

    try {
      await harness.emit("session_start", {}, ctx);
      await harness.runTool(
        "plan_mode_todo",
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

      expect(harness.api.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining("Plan Mode artifact policy"),
        { deliverAs: "followUp" },
      );
    } finally {
      cleanup();
    }
  });
});
