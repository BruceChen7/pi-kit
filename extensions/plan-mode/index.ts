import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  ACT_TODO_TOOL_NAME,
  PLAN_MODE_COMMAND_OPTIONS,
  STATUS_KEY,
  TODO_TOOL_NAME,
  TODO_WIDGET_KEY,
} from "./constants.ts";
import { PlanModeController } from "./controller.ts";
import { isPlanArtifactFormat, isPlanMode } from "./state.ts";
import { registerTodoTool } from "./todo-tool.ts";
import { formatPlanModeStatus } from "./ui.ts";

export default function planModeExtension(pi: ExtensionAPI): void {
  const controller = new PlanModeController(pi);

  pi.registerFlag?.("plan-mode", {
    description: "Start with Plan Mode workflow enabled",
    type: "boolean",
    default: false,
  });

  pi.registerCommand("plan-mode", {
    description: "Switch Plan Mode workflow: plan, act, status",
    getArgumentCompletions: (prefix: string) =>
      PLAN_MODE_COMMAND_OPTIONS.filter((mode) => mode.startsWith(prefix)).map(
        (mode) => ({ label: mode, value: mode }),
      ),
    handler: async (args, ctx) => {
      const requested = args.trim();
      if (requested === "status" || requested.length === 0) {
        ctx.ui.notify(
          formatPlanModeStatus(controller.state, controller.config),
          "info",
        );
        controller.updateUi(ctx);
        return;
      }

      const [command, value] = requested.split(/\s+/u);
      if (command === "format") {
        if (!isPlanArtifactFormat(value)) {
          ctx.ui.notify("Usage: /plan-mode format html|markdown", "error");
          return;
        }
        controller.setPlanArtifactFormat(ctx, value);
        return;
      }

      if (!isPlanMode(requested)) {
        ctx.ui.notify(`Unknown plan-mode: ${requested}`, "error");
        return;
      }
      controller.setMode(ctx, requested);
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
    if (pi.getFlag?.("plan-mode") === true) {
      controller.state.setMode("plan");
    }
    controller.applyMode(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    controller.restore(ctx);
    controller.applyMode(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!ctx.hasUI) {
      return;
    }
    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.setWidget(TODO_WIDGET_KEY, undefined);
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
    controller.handleToolResult(event, ctx);
    controller.updateUi(ctx);
  });

  pi.on("agent_end", async (event, ctx) => {
    await controller.handleAgentEnd(event, ctx);
  });
}
