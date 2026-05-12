import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import type { PlanModeController } from "./controller.ts";
import type { PlanModeState } from "./state.ts";
import { clonePlanRun } from "./state.ts";
import { symbolForStatus } from "./ui.ts";

const todoStatusSchema = Type.Union([
  Type.Literal("todo"),
  Type.Literal("pending"),
  Type.Literal("in_progress"),
  Type.Literal("done"),
  Type.Literal("blocked"),
]);

const todoInputSchema = Type.Object({
  text: Type.String({ description: "TODO text" }),
  status: Type.Optional(todoStatusSchema),
  notes: Type.Optional(Type.String({ description: "Optional note" })),
});

const todoParamsSchema = Type.Object({
  action: Type.Union([
    Type.Literal("list"),
    Type.Literal("set"),
    Type.Literal("add"),
    Type.Literal("update"),
    Type.Literal("remove"),
    Type.Literal("clear"),
  ]),
  items: Type.Optional(Type.Array(todoInputSchema)),
  id: Type.Optional(Type.Number()),
  text: Type.Optional(Type.String()),
  status: Type.Optional(todoStatusSchema),
  notes: Type.Optional(Type.String()),
});

type TodoParams = Static<typeof todoParamsSchema>;
type TodoToolOptions = {
  name: string;
  label: string;
  displayName: string;
  phaseName: "Plan" | "Act";
};

const formatTodoResult = (
  state: PlanModeState,
  displayName: string,
): string => {
  if (state.todos.length === 0) {
    return `Current ${displayName} TODO list: empty.`;
  }
  return `Current ${displayName} TODO list:\n${state.todos
    .map((todo) => `#${todo.id} [${symbolForStatus(todo.status)}] ${todo.text}`)
    .join("\n")}`;
};

const todoToolError = (text: string) => ({
  content: [{ type: "text" as const, text }],
  details: undefined,
});

export const registerTodoTool = (
  pi: ExtensionAPI,
  controller: PlanModeController,
  options: TodoToolOptions,
): void => {
  const { name, label, displayName, phaseName } = options;
  pi.registerTool({
    name,
    label,
    description:
      "Create, list, update, remove, or clear the active " +
      `${displayName} TODO list.`,
    promptSnippet: `Manage the ${displayName} TODO list and current execution step`,
    promptGuidelines: [
      `Use ${name} to create concrete TODOs during ` +
        `${phaseName} phase before implementation.`,
      'Use action "set" to replace the TODO list, or action "add" to append ' +
        'one TODO. Do not use action "create"; it is not supported.',
      `Update ${name} items to in_progress before starting a step and ` +
        "done after finishing it so the widget shows the current step.",
    ],
    parameters: todoParamsSchema,
    async execute(_toolCallId, params: TodoParams, _signal, _onUpdate, ctx) {
      switch (params.action) {
        case "set":
          controller.state.replaceTodos(
            params.items ?? [],
            controller.getPlanPathForNewRun(),
          );
          break;
        case "add":
          if (!params.text) {
            return todoToolError("Error: text is required for add.");
          }
          controller.state.addTodo(
            params.text,
            params.status ?? "todo",
            params.notes,
            controller.getPlanPathForNewRun(),
          );
          break;
        case "update":
          if (params.id === undefined) {
            return todoToolError("Error: id is required for update.");
          }
          if (
            !controller.state.updateTodo(params.id, {
              ...(params.text !== undefined ? { text: params.text } : {}),
              ...(params.status !== undefined ? { status: params.status } : {}),
              ...(params.notes !== undefined ? { notes: params.notes } : {}),
            })
          ) {
            return todoToolError(`Error: TODO #${params.id} not found.`);
          }
          break;
        case "remove":
          if (params.id === undefined) {
            return todoToolError("Error: id is required for remove.");
          }
          controller.state.removeTodo(params.id);
          break;
        case "clear":
          controller.state.clearTodos();
          break;
        case "list":
          break;
      }

      controller.updateUi(ctx);
      controller.persist();
      return {
        content: [
          {
            type: "text",
            text: formatTodoResult(controller.state, displayName),
          },
        ],
        details: {
          todos: controller.state.todos.map((todo) => ({ ...todo })),
          activeRun: controller.state.activeRun
            ? clonePlanRun(controller.state.activeRun)
            : null,
          recentRuns: controller.state.recentRuns.map(clonePlanRun),
        },
      };
    },
  });
};
