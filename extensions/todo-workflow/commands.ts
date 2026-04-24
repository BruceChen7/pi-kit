import type { AutocompleteItem } from "@mariozechner/pi-tui";

const TODO_TOP_LEVEL_COMMAND_SPECS = [
  {
    value: "add",
    label: "add",
    description: "create a new todo",
  },
  {
    value: "start",
    label: "start",
    description: "start a queued todo",
  },
  {
    value: "resume",
    label: "resume",
    description: "resume a doing todo",
  },
  {
    value: "finish",
    label: "finish",
    description: "finish a doing todo",
  },
  {
    value: "cleanup",
    label: "cleanup",
    description: "cleanup merged todo resources",
  },
  {
    value: "remove",
    label: "remove",
    description: "remove a todo",
  },
  {
    value: "list",
    label: "list",
    description: "list todos",
  },
  {
    value: "show",
    label: "show",
    description: "show todo details",
  },
] as const satisfies readonly AutocompleteItem[];

const TODO_COMPLETION_ACTION_SPECS = [
  {
    value: "finish",
    label: "finish",
    description: "finish current or selected todo",
  },
  {
    value: "cleanup",
    label: "cleanup",
    description: "cleanup merged todo resources",
  },
] as const satisfies readonly AutocompleteItem[];

export const TODO_DIRECT_ID_COMMAND_SPECS = [
  { command: "show", kind: "show" },
  { command: "remove", kind: "remove" },
  { command: "start", kind: "start" },
  { command: "resume", kind: "resume" },
] as const;

export const TODO_ID_ARGUMENT_COMMANDS: ReadonlySet<string> = new Set(
  TODO_DIRECT_ID_COMMAND_SPECS.map((spec) => spec.command),
);

export const TODO_COMPLETION_ACTION_COMMANDS: ReadonlySet<string> = new Set(
  TODO_COMPLETION_ACTION_SPECS.map((spec) => spec.value),
);

export function getTopLevelTodoCommandItems(): AutocompleteItem[] {
  return [...TODO_TOP_LEVEL_COMMAND_SPECS];
}

export function getTodoCompletionActionItems(): AutocompleteItem[] {
  return [...TODO_COMPLETION_ACTION_SPECS];
}

export function isTodoIdArgumentCommand(command: string): boolean {
  return TODO_ID_ARGUMENT_COMMANDS.has(command);
}

export function isTodoCompletionActionCommand(command: string): boolean {
  return TODO_COMPLETION_ACTION_COMMANDS.has(command);
}
