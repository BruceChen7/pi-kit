import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  ACT_TODO_TOOL_NAME,
  PLAN_MODE_COMMAND_OPTIONS,
  PLAN_MODE_TOGGLE_SHORTCUT,
  TODO_TOOL_NAME,
} from "./constants.ts";
import { PlanModeController } from "./controller.ts";
import { isPlanMode } from "./state.ts";
import {
  buildTodoReminder,
  createTodoReminderCadence,
  drainTodoReminderForContext,
  noteToolResult,
  noteTurnEnd,
  onTurnStart,
  resetTodoReminderCadence,
} from "./todo-reminder.ts";
import { registerTodoTool } from "./todo-tool.ts";
import type { PlanMode } from "./types.ts";
import { formatPlanModeStatus } from "./ui.ts";

export type CommandCompletion = {
  label: string;
  value: string;
};

export type PlanModeCommandDecision =
  | { kind: "status" }
  | { kind: "mode"; value: PlanMode }
  | { kind: "invalid-mode"; value: string };

const toCompletions = (
  options: readonly string[],
  prefix: string,
  completionValuePrefix = "",
): CommandCompletion[] =>
  options
    .filter((option) => option.startsWith(prefix))
    .map((option) => ({
      label: option,
      value: `${completionValuePrefix}${option}`,
    }));

export const getPlanModeArgumentCompletions = (
  prefix: string,
): CommandCompletion[] => {
  const trimmedPrefix = prefix.trimStart();
  const firstSeparatorIndex = trimmedPrefix.search(/\s/u);
  if (firstSeparatorIndex === -1) {
    return toCompletions(PLAN_MODE_COMMAND_OPTIONS, trimmedPrefix);
  }

  const command = trimmedPrefix.slice(0, firstSeparatorIndex);
  return toCompletions(PLAN_MODE_COMMAND_OPTIONS, command);
};

export const parsePlanModeCommand = (args: string): PlanModeCommandDecision => {
  const requested = args.trim();
  if (requested === "status" || requested.length === 0) {
    return { kind: "status" };
  }

  return isPlanMode(requested)
    ? { kind: "mode", value: requested }
    : { kind: "invalid-mode", value: requested };
};

export default function planModeExtension(pi: ExtensionAPI): void {
  const controller = new PlanModeController(pi);
  // Cadence for the "agent drifted off the list" reminder. Session-scoped and
  // transient: nothing here is persisted, and the reminder itself is injected
  // into one request via the `context` hook.
  const reminderCadence = createTodoReminderCadence();
  const isActPhase = (): boolean => controller.state.phase === "act";
  const hasInProgressTodo = (): boolean =>
    controller.state.todos.some((todo) => todo.status === "in_progress");
  const hasTodo = (): boolean => controller.state.todos.length > 0;

  pi.registerFlag?.("plan-mode", {
    description: "Start with Plan Mode workflow enabled",
    type: "boolean",
    default: false,
  });

  pi.registerCommand("plan-mode", {
    description: "Switch Plan Mode workflow: plan, act, status",
    getArgumentCompletions: getPlanModeArgumentCompletions,
    handler: async (args, ctx) => {
      const decision = parsePlanModeCommand(args);
      switch (decision.kind) {
        case "status":
          ctx.ui.notify(
            formatPlanModeStatus(controller.state, controller.config),
            "info",
          );
          controller.updateUi(ctx);
          return;
        case "mode":
          controller.setMode(ctx, decision.value);
          return;
        case "invalid-mode":
          ctx.ui.notify(`Unknown plan-mode: ${decision.value}`, "error");
          return;
      }
    },
  });

  pi.registerShortcut?.(PLAN_MODE_TOGGLE_SHORTCUT, {
    description: "Toggle Plan Mode between Act and Plan",
    handler: (ctx) => {
      controller.toggleMode(ctx);
    },
  });

  registerTodoTool(pi, controller, {
    name: TODO_TOOL_NAME,
    label: "Plan Mode TODO",
    displayName: "Plan Mode",
    phaseName: "Plan",
  });
  registerTodoTool(pi, controller, {
    name: ACT_TODO_TOOL_NAME,
    label: "Act Mode TODO",
    displayName: "Act Mode",
    phaseName: "Act",
  });

  pi.on("session_start", async (_event, ctx) => {
    controller.restore(ctx);
    resetTodoReminderCadence(reminderCadence);
    if (pi.getFlag?.("plan-mode") === true) {
      controller.state.setMode("plan");
    }
    controller.applyMode(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    controller.restore(ctx);
    resetTodoReminderCadence(reminderCadence);
    controller.applyMode(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    // 清空 UI 与复位 widget 跟踪状态都在 controller.clearUi；状态本身由 restore() 重建。
    resetTodoReminderCadence(reminderCadence);
    controller.clearUi(ctx);
  });

  pi.on("input", async (event) => {
    controller.handleInput(event);
    return { action: "continue" };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    await controller.handleAgentStart(event, ctx);
    return {
      systemPrompt: `${event.systemPrompt ?? ""}\n\n${controller.buildModePrompt()}`,
    };
  });

  pi.on("tool_call", async (event, ctx) =>
    controller.maybeBlockTool(event, ctx),
  );

  pi.on("tool_result", async (event, ctx) => {
    const result = controller.handleToolResult(event, ctx);
    controller.updateUi(ctx);
    if (isActPhase()) {
      noteToolResult(reminderCadence, {
        toolName: event.toolName,
        hasTodos: hasTodo(),
        hasInProgress: hasInProgressTodo(),
      });
    } else {
      resetTodoReminderCadence(reminderCadence);
    }
    return result;
  });

  pi.on("turn_start", async () => {
    if (!isActPhase()) {
      resetTodoReminderCadence(reminderCadence);
      return;
    }
    onTurnStart(reminderCadence);
  });

  pi.on("turn_end", async (event) => {
    if (!isActPhase()) {
      return;
    }
    // A text-only turn that leaves work in_progress is invisible to the
    // tool_result path: no tool fires, so the idle window alone would never
    // catch "answered, but did not finish".
    noteTurnEnd(reminderCadence, {
      toolResultCount: event.toolResults.length,
      hasInProgress: hasInProgressTodo(),
    });
  });

  pi.on("context", async (event) => {
    if (!isActPhase() || !hasTodo()) {
      return {};
    }
    const reason = reminderCadence.reason ?? "idle";
    if (!drainTodoReminderForContext(reminderCadence)) {
      return {};
    }
    const reminder = buildTodoReminder({
      todos: controller.state.todos,
      reason,
      toolName: ACT_TODO_TOOL_NAME,
    });
    if (!reminder) {
      return {};
    }
    // Transient: appended to this request's messages only, never persisted and
    // never merged into a tool result.
    return {
      messages: [
        ...event.messages,
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: reminder }],
          timestamp: Date.now(),
        },
      ],
    };
  });

  pi.on("agent_end", async (event, ctx) => {
    await controller.handleAgentEnd(event, ctx);
  });
}
