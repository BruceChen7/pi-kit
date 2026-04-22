import fs from "node:fs";
import path from "node:path";

export type TodoStatus = "todo" | "doing" | "done";

export type TodoItem = {
  id: string;
  title: string;
  status: TodoStatus;
  createdAt: string;
  updatedAt: string;
  sourceBranch?: string;
  workBranch?: string;
  worktreePath?: string;
  startedAt?: string;
  completedAt?: string;
  lastActivatedAt?: string;
  activeSessionKey?: string;
  lastSessionActiveAt?: string;
};

export type TodoStore = {
  todos: TodoItem[];
};

const STORE_RELATIVE_PATH = path.join(".pi", "todos.json");

function getStorePath(repoRoot: string): string {
  return path.join(repoRoot, STORE_RELATIVE_PATH);
}

function ensureStoreDir(repoRoot: string): void {
  fs.mkdirSync(path.dirname(getStorePath(repoRoot)), { recursive: true });
}

function isTodoStatus(value: unknown): value is TodoStatus {
  return value === "todo" || value === "doing" || value === "done";
}

function readOptionalString(
  item: Record<string, unknown>,
  key: keyof TodoItem,
): string | undefined {
  const value = item[key];
  return typeof value === "string" ? value : undefined;
}

function toTodoItem(value: unknown, index: number): TodoItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `Failed to read ${STORE_RELATIVE_PATH}: invalid todo record at index ${index}`,
    );
  }

  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || !item.id.trim()) {
    throw new Error(
      `Failed to read ${STORE_RELATIVE_PATH}: invalid todo record at index ${index}`,
    );
  }
  if (typeof item.title !== "string" || !item.title.trim()) {
    throw new Error(
      `Failed to read ${STORE_RELATIVE_PATH}: invalid todo record at index ${index}`,
    );
  }
  if (!isTodoStatus(item.status)) {
    throw new Error(
      `Failed to read ${STORE_RELATIVE_PATH}: invalid todo record at index ${index}`,
    );
  }
  if (
    typeof item.createdAt !== "string" ||
    typeof item.updatedAt !== "string"
  ) {
    throw new Error(
      `Failed to read ${STORE_RELATIVE_PATH}: invalid todo record at index ${index}`,
    );
  }

  return {
    id: item.id,
    title: item.title,
    status: item.status,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    sourceBranch: readOptionalString(item, "sourceBranch"),
    workBranch: readOptionalString(item, "workBranch"),
    worktreePath: readOptionalString(item, "worktreePath"),
    startedAt: readOptionalString(item, "startedAt"),
    completedAt: readOptionalString(item, "completedAt"),
    lastActivatedAt: readOptionalString(item, "lastActivatedAt"),
    activeSessionKey: readOptionalString(item, "activeSessionKey"),
    lastSessionActiveAt: readOptionalString(item, "lastSessionActiveAt"),
  };
}

function readStore(repoRoot: string): TodoStore {
  const storePath = getStorePath(repoRoot);
  if (!fs.existsSync(storePath)) {
    return { todos: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(storePath, "utf-8")) as unknown;
  } catch (error) {
    throw new Error(
      `Failed to read ${STORE_RELATIVE_PATH}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Failed to read ${STORE_RELATIVE_PATH}: invalid store shape`,
    );
  }

  const todosValue = (parsed as { todos?: unknown }).todos;
  if (typeof todosValue === "undefined") {
    return { todos: [] };
  }
  if (!Array.isArray(todosValue)) {
    throw new Error(
      `Failed to read ${STORE_RELATIVE_PATH}: todos must be an array`,
    );
  }

  return {
    todos: todosValue.map((item, index) => toTodoItem(item, index)),
  };
}

function writeStore(repoRoot: string, store: TodoStore): void {
  ensureStoreDir(repoRoot);
  fs.writeFileSync(
    getStorePath(repoRoot),
    `${JSON.stringify(store, null, 2)}\n`,
    "utf-8",
  );
}

function updateTodo(
  repoRoot: string,
  id: string,
  updater: (todo: TodoItem) => TodoItem,
): TodoItem {
  const store = readStore(repoRoot);
  const index = store.todos.findIndex((todo) => todo.id === id);
  if (index === -1) {
    throw new Error(`Unknown TODO: ${id}`);
  }

  const updated = updater(store.todos[index] as TodoItem);
  store.todos[index] = updated;
  writeStore(repoRoot, store);
  return updated;
}

function createId(title: string, existing: TodoItem[]): string {
  const slug =
    title
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "todo";
  let candidate = slug;
  let counter = 2;
  const existingIds = new Set(existing.map((todo) => todo.id));
  while (existingIds.has(candidate)) {
    candidate = `${slug}-${counter}`;
    counter += 1;
  }
  return candidate;
}

export function loadTodoStore(repoRoot: string): TodoStore {
  return readStore(repoRoot);
}

export function createTodo(
  repoRoot: string,
  title: string,
  now?: string,
): TodoItem {
  const store = readStore(repoRoot);
  const timestamp = now ?? new Date().toISOString();
  const todo: TodoItem = {
    id: createId(title, store.todos),
    title: title.trim(),
    status: "todo",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  store.todos.push(todo);
  writeStore(repoRoot, store);
  return todo;
}

export function updateTodoStart(
  repoRoot: string,
  input: {
    id: string;
    sourceBranch: string;
    workBranch: string;
    worktreePath: string;
    now?: string;
  },
): TodoItem {
  const timestamp = input.now ?? new Date().toISOString();
  return updateTodo(repoRoot, input.id, (todo) => ({
    ...todo,
    status: "doing",
    sourceBranch: input.sourceBranch,
    workBranch: input.workBranch,
    worktreePath: input.worktreePath,
    startedAt: todo.startedAt ?? timestamp,
    updatedAt: timestamp,
    lastActivatedAt: timestamp,
  }));
}

export function updateTodoActivation(
  repoRoot: string,
  input: {
    id: string;
    sessionKey: string;
    activeInSession: boolean;
    now?: string;
  },
): TodoItem {
  const timestamp = input.now ?? new Date().toISOString();
  const store = readStore(repoRoot);
  const todos = store.todos.map((todo) => {
    if (todo.id !== input.id) {
      if (input.activeInSession && todo.activeSessionKey === input.sessionKey) {
        return {
          ...todo,
          activeSessionKey: undefined,
        };
      }
      return todo;
    }

    return {
      ...todo,
      lastActivatedAt: timestamp,
      updatedAt: timestamp,
      activeSessionKey: input.activeInSession
        ? input.sessionKey
        : todo.activeSessionKey,
      lastSessionActiveAt: input.activeInSession
        ? timestamp
        : todo.lastSessionActiveAt,
    };
  });
  writeStore(repoRoot, { todos });
  const updated = todos.find((todo) => todo.id === input.id);
  if (!updated) {
    throw new Error(`Unknown TODO: ${input.id}`);
  }
  return updated;
}

export function syncTodoDone(
  repoRoot: string,
  input: { id: string; now?: string },
): TodoItem {
  const timestamp = input.now ?? new Date().toISOString();
  return updateTodo(repoRoot, input.id, (todo) => ({
    ...todo,
    status: "done",
    updatedAt: timestamp,
    completedAt: todo.completedAt ?? timestamp,
    activeSessionKey: undefined,
  }));
}

export function markTodoDone(
  repoRoot: string,
  input: { id: string; now?: string },
): TodoItem {
  return syncTodoDone(repoRoot, input);
}

export function listTodos(
  repoRoot: string,
  input: { includeDone: boolean; sessionKey?: string },
): TodoItem[] {
  const store = readStore(repoRoot);
  const filtered = store.todos.filter(
    (todo) => input.includeDone || todo.status !== "done",
  );

  const rank = (todo: TodoItem): number => {
    const isSessionActive = Boolean(
      input.sessionKey &&
        todo.activeSessionKey === input.sessionKey &&
        todo.status === "doing",
    );
    if (isSessionActive) return 0;
    if (todo.status === "doing") return 1;
    if (todo.status === "todo") return 2;
    return 3;
  };

  return [...filtered].sort((left, right) => {
    const rankDiff = rank(left) - rank(right);
    if (rankDiff !== 0) return rankDiff;

    const leftTime = left.lastActivatedAt ?? left.updatedAt;
    const rightTime = right.lastActivatedAt ?? right.updatedAt;
    return rightTime.localeCompare(leftTime);
  });
}

export function findTodoById(repoRoot: string, id: string): TodoItem | null {
  return readStore(repoRoot).todos.find((todo) => todo.id === id) ?? null;
}

export function getDoingTodos(repoRoot: string): TodoItem[] {
  return readStore(repoRoot).todos.filter((todo) => todo.status === "doing");
}
