import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import type { PlanModeController } from "./controller.ts";
import { todoDisciplineGuidance } from "./guidance.ts";
import type { PlanModeState } from "./state.ts";
import { clonePlanRun } from "./state.ts";
import type { TodoItem, TodoPatch } from "./types.ts";
import { symbolForStatus } from "./ui.ts";

type TodoPatchInput = TodoPatch & { id: number };

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

/**
 * One patch in a batch update. `text` is optional here, unlike `set` items,
 * because a status-only change must not have to restate the item text.
 */
const todoPatchSchema = Type.Object({
  id: Type.Number(),
  text: Type.Optional(Type.String()),
  status: Type.Optional(todoStatusSchema),
  notes: Type.Optional(Type.String()),
});

/**
 * Decides whether a batch of patches may land, without touching state. All or
 * nothing: one unknown id rejects the batch, so a half-applied status change
 * cannot leave the list describing work that did not happen.
 */
export const planTodoPatchApplication = (
  existingIds: readonly number[],
  patches: readonly TodoPatchInput[],
):
  | { kind: "apply"; patches: readonly TodoPatchInput[] }
  | { kind: "missing"; id: number } => {
  const known = new Set(existingIds);
  const missing = patches.find((patch) => !known.has(patch.id));
  if (missing) {
    return { kind: "missing", id: missing.id };
  }
  return { kind: "apply", patches };
};

const describePatch = (patch: TodoPatchInput): string =>
  patch.status !== undefined
    ? `#${patch.id} → ${patch.status}`
    : `#${patch.id} → edited`;

/**
 * One-line confirmation for a status change. The full list stays behind
 * `list` / `set`: repeating it on every update was the bulk of this tool's
 * output in the sessions that motivated batching.
 */
export const formatTodoUpdateSummary = (
  patches: readonly TodoPatchInput[],
  todos: readonly TodoItem[],
): string => {
  const open = todos.filter((todo) => todo.status !== "done");
  const inProgress = open.filter((todo) => todo.status === "in_progress");
  const changed =
    patches.length > 0 ? patches.map(describePatch).join(", ") : "nothing";
  const inProgressLabel =
    inProgress.length > 0
      ? `in_progress: ${inProgress.map((todo) => `#${todo.id}`).join(", ")}`
      : "in_progress: none";
  return `Updated ${changed}. Open: ${open.length} (${inProgressLabel}).`;
};

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
    updates: Type.Optional(Type.Array(todoPatchSchema)),
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
      `For action "update", pass id plus the fields to patch, or updates: ` +
        `[{id, status}] to change several items in one call. Do not send one ` +
        `update per item; keep the list itself on "set".`,
      todoDisciplineGuidance(name),
    ],
    parameters: todoParamsSchema,
    async execute(_toolCallId, params: TodoParams, _signal, _onUpdate, ctx) {
      let updatedPatches: readonly TodoPatchInput[] | undefined;
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
        case "update": {
          if (params.id !== undefined && params.updates !== undefined) {
            return todoToolError(
              "Error: pass either id or updates for update, not both.",
            );
          }
          const patches: TodoPatchInput[] =
            params.updates ??
            (params.id === undefined
              ? []
              : [
                  {
                    id: params.id,
                    ...(params.text?.trim() ? { text: params.text } : {}),
                    ...(params.status !== undefined
                      ? { status: params.status }
                      : {}),
                    ...(params.notes !== undefined
                      ? { notes: params.notes }
                      : {}),
                  },
                ]);
          if (patches.length === 0) {
            return todoToolError(
              "Error: id or updates is required for update.",
            );
          }
          const plan = planTodoPatchApplication(
            controller.state.todos.map((todo) => todo.id),
            patches,
          );
          if (plan.kind === "missing") {
            return todoToolError(`Error: TODO #${plan.id} not found.`);
          }
          for (const patch of plan.patches) {
            controller.state.updateTodo(patch.id, {
              ...(patch.text?.trim() ? { text: patch.text } : {}),
              ...(patch.status !== undefined ? { status: patch.status } : {}),
              ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
            });
          }
          updatedPatches = plan.patches;
          break;
        }
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
            text:
              updatedPatches === undefined
                ? formatTodoResult(controller.state, displayName)
                : formatTodoUpdateSummary(
                    updatedPatches,
                    controller.state.todos,
                  ),
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
