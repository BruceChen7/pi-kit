import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import type { PlanModeController } from "./controller.ts";
import { todoDisciplineGuidance } from "./guidance.ts";
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
  text: Type.String({ minLength: 1, description: "TODO text" }),
  status: Type.Optional(todoStatusSchema),
  notes: Type.Optional(Type.String({ description: "Optional note" })),
});

// Console Go (DeepSeek) requires top-level `type: "object"` for function parameters.
// Type.Union of objects yields top-level `anyOf` without `type`, which fails strict validation
// (Error: schema must be a JSON Schema of 'type: \"object\"', got 'type: null').
// Use a single object schema to satisfy the provider; per-action required checks remain in execute().
const todoParamsSchema = Type.Object(
  {
    action: Type.Union([
      Type.Literal("list"),
      Type.Literal("set"),
      Type.Literal("add"),
      Type.Literal("update"),
      Type.Literal("remove"),
      Type.Literal("clear"),
    ]),
    items: Type.Optional(Type.Array(todoInputSchema)),
    text: Type.Optional(Type.String({ minLength: 1 })),
    id: Type.Optional(Type.Number()),
    status: Type.Optional(todoStatusSchema),
    notes: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

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
      `For action "update", pass only id plus the fields to patch; do not pass ` +
        'items. Use action "set" when replacing the whole list.',
      todoDisciplineGuidance(name),
    ],
    parameters: todoParamsSchema,
    async execute(_toolCallId, params: TodoParams, _signal, _onUpdate, ctx) {
      switch (params.action) {
        case "set": {
          const items = params.items ?? [];
          controller.state.replaceTodos(
            items,
            controller.getPlanPathForNewRun(),
          );
          break;
        }
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
              ...(params.text?.trim() ? { text: params.text } : {}),
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
          // Read-only.
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
