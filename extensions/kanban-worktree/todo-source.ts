import {
  createRepoGitRunner,
  getCurrentBranchName,
  listLocalBranches,
} from "../shared/git.ts";
import {
  createTodo,
  findTodoById,
  listTodos,
  removeTodo,
  type TodoItem,
  updateTodoStart,
} from "../todo-workflow/todo-store.ts";

export const TODO_WORKFLOW_PROVIDER = "todo-workflow";

export type KanbanStatus = "in-box" | "doing" | "done" | "archived";
export type IssueOriginProvider = typeof TODO_WORKFLOW_PROVIDER;

export type KanbanIssue = {
  issueId: string;
  originProvider: IssueOriginProvider;
  originId: string;
  title: string;
  description: string;
  status: KanbanStatus;
  repoRoot: string;
  baseBranch: string;
  slug: string;
  workBranch?: string;
  worktreePath?: string;
  createdAt: string;
  updatedAt: string;
};

export type MarkStartedInput = {
  originId: string;
  sourceBranch: string;
  workBranch: string;
  worktreePath: string;
};

export type CreateIssueInput = {
  baseBranch?: string;
  workBranch?: string;
};

export type IssueSource = {
  list(repoRoot: string): Promise<KanbanIssue[]>;
  get(repoRoot: string, originId: string): Promise<KanbanIssue | null>;
  create(
    repoRoot: string,
    title: string,
    input?: CreateIssueInput,
  ): Promise<KanbanIssue>;
  remove(repoRoot: string, originId: string): Promise<KanbanIssue>;
  markStarted(repoRoot: string, input: MarkStartedInput): Promise<KanbanIssue>;
};

export type BaseBranchResolver = (repoRoot: string) => string;

export type TodoWorkflowSourceOptions = {
  resolveBaseBranch?: BaseBranchResolver;
};

function statusFromTodo(todo: TodoItem): KanbanStatus {
  if (todo.status === "todo") return "in-box";
  return todo.status;
}

function chooseLocalFallbackBranch(branches: string[]): string | null {
  for (const branch of ["main", "master"]) {
    if (branches.includes(branch)) return branch;
  }
  return branches.find((branch) => branch.startsWith("release")) ?? null;
}

function resolveDefaultBaseBranch(repoRoot: string): string {
  const run = createRepoGitRunner(repoRoot);
  return (
    getCurrentBranchName(run) ??
    chooseLocalFallbackBranch(listLocalBranches(run)) ??
    "main"
  );
}

function issueFromTodo(
  repoRoot: string,
  todo: TodoItem,
  fallbackBaseBranch: string,
): KanbanIssue {
  return {
    issueId: `${TODO_WORKFLOW_PROVIDER}:${todo.id}`,
    originProvider: TODO_WORKFLOW_PROVIDER,
    originId: todo.id,
    title: todo.description,
    description: todo.description,
    status: statusFromTodo(todo),
    repoRoot,
    baseBranch: todo.sourceBranch ?? fallbackBaseBranch,
    slug: todo.id,
    workBranch: todo.workBranch,
    worktreePath: todo.worktreePath,
    createdAt: todo.createdAt,
    updatedAt: todo.updatedAt,
  };
}

export class TodoWorkflowSource implements IssueSource {
  private readonly resolveBaseBranch: BaseBranchResolver;

  constructor(options: TodoWorkflowSourceOptions = {}) {
    this.resolveBaseBranch =
      options.resolveBaseBranch ?? resolveDefaultBaseBranch;
  }

  private fallbackBaseBranch(repoRoot: string): string {
    return this.resolveBaseBranch(repoRoot);
  }

  async list(repoRoot: string): Promise<KanbanIssue[]> {
    const fallbackBaseBranch = this.fallbackBaseBranch(repoRoot);
    return listTodos(repoRoot, { includeDone: true }).map((todo) =>
      issueFromTodo(repoRoot, todo, fallbackBaseBranch),
    );
  }

  async get(repoRoot: string, originId: string): Promise<KanbanIssue | null> {
    const todo = findTodoById(repoRoot, originId);
    return todo
      ? issueFromTodo(repoRoot, todo, this.fallbackBaseBranch(repoRoot))
      : null;
  }

  async create(
    repoRoot: string,
    title: string,
    input: CreateIssueInput = {},
  ): Promise<KanbanIssue> {
    const fallbackBaseBranch = this.fallbackBaseBranch(repoRoot);
    return issueFromTodo(
      repoRoot,
      createTodo(repoRoot, title, {
        sourceBranch: input.baseBranch ?? fallbackBaseBranch,
        workBranch: input.workBranch,
      }),
      fallbackBaseBranch,
    );
  }

  async remove(repoRoot: string, originId: string): Promise<KanbanIssue> {
    return issueFromTodo(
      repoRoot,
      removeTodo(repoRoot, { id: originId }),
      this.fallbackBaseBranch(repoRoot),
    );
  }

  async markStarted(
    repoRoot: string,
    input: MarkStartedInput,
  ): Promise<KanbanIssue> {
    return issueFromTodo(
      repoRoot,
      updateTodoStart(repoRoot, {
        id: input.originId,
        sourceBranch: input.sourceBranch,
        workBranch: input.workBranch,
        worktreePath: input.worktreePath,
      }),
      this.fallbackBaseBranch(repoRoot),
    );
  }
}
