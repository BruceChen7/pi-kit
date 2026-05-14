import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadSettings } from "../shared/settings.ts";
import {
  DEFAULT_CONFIG,
  EXPLICIT_PLAN_MODE_REQUEST_PATTERN,
  MODE_SELECTION_OPTIONS,
  RECENT_RUN_LIMIT,
  STATE_ENTRY_TYPE,
} from "./constants.ts";
import type {
  PlanArtifactFormat,
  PlanDecisionSummary,
  PlanMode,
  PlanModeConfig,
  PlanModeSnapshot,
  PlanPhase,
  PlanRun,
  PlanRunStatus,
  TodoInput,
  TodoItem,
  TodoPatch,
  TodoStatus,
  TodoStatusInput,
} from "./types.ts";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const stringProperty = (value: unknown, key: string): string | null => {
  if (!isRecord(value)) {
    return null;
  }
  const property = value[key];
  return typeof property === "string" ? property : null;
};

export const isPlanMode = (value: unknown): value is PlanMode =>
  typeof value === "string" &&
  MODE_SELECTION_OPTIONS.includes(value as PlanMode);

export const isPlanArtifactFormat = (
  value: unknown,
): value is PlanArtifactFormat => value === "markdown" || value === "html";

export const promptRequestsPlanMode = (prompt: string): boolean =>
  EXPLICIT_PLAN_MODE_REQUEST_PATTERN.test(prompt);

export const isPhaseValue = (value: unknown): value is PlanPhase =>
  value === "plan" || value === "act";

export const isTodoStatus = (value: unknown): value is TodoStatus =>
  value === "todo" ||
  value === "in_progress" ||
  value === "done" ||
  value === "blocked";

export const normalizeTodoStatus = (status: TodoStatusInput): TodoStatus =>
  status === "pending" ? "todo" : status;

export const sanitizeStringArray = (
  value: unknown,
  fallback: string[],
): string[] => {
  if (!Array.isArray(value)) {
    return fallback;
  }
  return value.filter((entry): entry is string => typeof entry === "string");
};

export const applyBooleanOverride = <T extends string>(
  target: Record<T, boolean>,
  raw: Record<string, unknown>,
  key: T,
): void => {
  if (typeof raw[key] === "boolean") {
    target[key] = raw[key];
  }
};

export const finiteNumberOr = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

export const phaseForMode = (mode: PlanMode): PlanPhase =>
  mode === "act" ? "act" : "plan";

export const hasCompletedAllTodos = (todos: TodoItem[]): boolean =>
  todos.length > 0 && todos.every((todo) => todo.status === "done");

export const isPlanRunStatus = (value: unknown): value is PlanRunStatus =>
  value === "draft" ||
  value === "approved" ||
  value === "executing" ||
  value === "completed" ||
  value === "archived";

export const todoFromSnapshot = (value: unknown): TodoItem | null => {
  if (
    !isRecord(value) ||
    typeof value.text !== "string" ||
    !isTodoStatus(value.status)
  ) {
    return null;
  }

  const id = finiteNumberOr(value.id, 0);
  if (id <= 0) {
    return null;
  }

  return {
    id,
    text: value.text,
    status: value.status,
    ...(typeof value.notes === "string" ? { notes: value.notes } : {}),
  };
};

export const todosFromSnapshot = (value: unknown): TodoItem[] =>
  Array.isArray(value)
    ? value.flatMap((todo): TodoItem[] => {
        const parsed = todoFromSnapshot(todo);
        return parsed ? [parsed] : [];
      })
    : [];

export const planDecisionFromSnapshot = (
  value: unknown,
): PlanDecisionSummary | null => {
  if (!isRecord(value) || value.outcome !== "plan_required") {
    return null;
  }

  return {
    outcome: value.outcome,
    reason: typeof value.reason === "string" ? value.reason : "unknown",
  };
};

export const runFromSnapshot = (value: unknown): PlanRun | null => {
  if (!isRecord(value) || !isPlanRunStatus(value.status)) {
    return null;
  }

  const todos = todosFromSnapshot(value.todos);

  return {
    id: typeof value.id === "string" ? value.id : `run-${Date.now()}`,
    status: value.status,
    planPath: typeof value.planPath === "string" ? value.planPath : null,
    todos,
    nextTodoId: finiteNumberOr(value.nextTodoId, todos.length + 1),
    createdAt:
      typeof value.createdAt === "string"
        ? value.createdAt
        : new Date(0).toISOString(),
    ...(typeof value.approvedAt === "string"
      ? { approvedAt: value.approvedAt }
      : {}),
    ...(typeof value.completedAt === "string"
      ? { completedAt: value.completedAt }
      : {}),
    ...(typeof value.archivedAt === "string"
      ? { archivedAt: value.archivedAt }
      : {}),
  };
};

export const createPlanRun = (
  todos: TodoItem[],
  nextTodoId: number,
  status: PlanRunStatus = "draft",
  planPath: string | null = null,
): PlanRun => ({
  id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  status,
  planPath,
  todos,
  nextTodoId,
  createdAt: new Date().toISOString(),
});

export const loadPlanModeConfig = (cwd: string): PlanModeConfig => {
  const { merged } = loadSettings(cwd);
  const raw = isRecord(merged.planMode) ? merged.planMode : {};
  const config: PlanModeConfig = {
    defaultMode: DEFAULT_CONFIG.defaultMode,
    planArtifactFormat: DEFAULT_CONFIG.planArtifactFormat,
    planArtifactFormatSource: DEFAULT_CONFIG.planArtifactFormatSource,
    preserveExternalTools: DEFAULT_CONFIG.preserveExternalTools,
    requireReview: DEFAULT_CONFIG.requireReview,
    guards: { ...DEFAULT_CONFIG.guards },
    artifactPolicy: { ...DEFAULT_CONFIG.artifactPolicy },
  };

  if (raw.preset === "solo") {
    config.requireReview = false;
  }
  if (isPlanMode(raw.defaultMode)) {
    config.defaultMode = raw.defaultMode;
  }
  if (isPlanArtifactFormat(raw.planArtifactFormat)) {
    config.planArtifactFormat = raw.planArtifactFormat;
    config.planArtifactFormatSource = "config";
  }
  if (typeof raw.preserveExternalTools === "boolean") {
    config.preserveExternalTools = raw.preserveExternalTools;
  }
  if (typeof raw.requireReview === "boolean") {
    config.requireReview = raw.requireReview;
  }
  if (isRecord(raw.guards)) {
    applyBooleanOverride(config.guards, raw.guards, "cwdOnly");
    applyBooleanOverride(config.guards, raw.guards, "readBeforeWrite");
    config.guards.allowedPaths = sanitizeStringArray(
      raw.guards.allowedPaths,
      config.guards.allowedPaths,
    );
  }
  if (isRecord(raw.artifactPolicy)) {
    const artifactPolicy = raw.artifactPolicy;
    applyBooleanOverride(config.artifactPolicy, artifactPolicy, "enabled");
    applyBooleanOverride(
      config.artifactPolicy,
      artifactPolicy,
      "allowExtraSections",
    );
    applyBooleanOverride(
      config.artifactPolicy,
      artifactPolicy,
      "requireSectionOrder",
    );
    applyBooleanOverride(
      config.artifactPolicy,
      artifactPolicy,
      "requireChinese",
    );
    applyBooleanOverride(
      config.artifactPolicy,
      artifactPolicy,
      "requireReviewDetails",
    );
    if (artifactPolicy.planFormat === "pi-standard") {
      config.artifactPolicy.planFormat = artifactPolicy.planFormat;
    }
  }

  return config;
};

export const snapshotFromEntry = (entry: unknown): PlanModeSnapshot | null => {
  if (
    !isRecord(entry) ||
    entry.type !== "custom" ||
    entry.customType !== STATE_ENTRY_TYPE
  ) {
    return null;
  }
  const data = entry.data;
  if (!isRecord(data) || !isPlanMode(data.mode) || !isPhaseValue(data.phase)) {
    return null;
  }

  const todos = todosFromSnapshot(data.todos);
  const activeRun = runFromSnapshot(data.activeRun);
  const recentRuns = Array.isArray(data.recentRuns)
    ? data.recentRuns.flatMap((run): PlanRun[] => {
        const parsed = runFromSnapshot(run);
        return parsed ? [parsed] : [];
      })
    : [];

  return {
    mode: data.mode,
    phase: data.phase,
    todos: activeRun ? activeRun.todos : todos,
    nextTodoId: activeRun
      ? activeRun.nextTodoId
      : finiteNumberOr(data.nextTodoId, todos.length + 1),
    activeRun:
      activeRun ??
      (todos.length > 0
        ? createPlanRun(
            todos,
            finiteNumberOr(data.nextTodoId, todos.length + 1),
            hasCompletedAllTodos(todos) ? "completed" : "draft",
          )
        : null),
    recentRuns: recentRuns.slice(0, RECENT_RUN_LIMIT),
    readFiles: sanitizeStringArray(data.readFiles, []),
    activePlanPath:
      typeof data.activePlanPath === "string" ? data.activePlanPath : null,
    latestReviewArtifactPath:
      typeof data.latestReviewArtifactPath === "string"
        ? data.latestReviewArtifactPath
        : null,
    reviewApprovedPlanPaths: sanitizeStringArray(
      data.reviewApprovedPlanPaths,
      [],
    ),
    pendingApprovedPlanContinuationPath:
      typeof data.pendingApprovedPlanContinuationPath === "string"
        ? data.pendingApprovedPlanContinuationPath
        : null,
    confirmedApprovedContinuationPath:
      typeof data.confirmedApprovedContinuationPath === "string"
        ? data.confirmedApprovedContinuationPath
        : null,
    resumableApprovedPlanPath:
      typeof data.resumableApprovedPlanPath === "string"
        ? data.resumableApprovedPlanPath
        : null,
    endConversationRequested: data.endConversationRequested === true,
    planArtifactFormatOverride: isPlanArtifactFormat(
      data.planArtifactFormatOverride,
    )
      ? data.planArtifactFormatOverride
      : null,
    lastAutoDecision: planDecisionFromSnapshot(data.lastAutoDecision),
  };
};

export const clonePlanRun = (run: PlanRun): PlanRun => ({
  ...run,
  todos: run.todos.map((todo) => ({ ...todo })),
});

export const latestSnapshot = (entries: unknown[]): PlanModeSnapshot | null => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const snapshot = snapshotFromEntry(entries[index]);
    if (snapshot) {
      return snapshot;
    }
  }
  return null;
};

export const getSessionStateEntries = (ctx: ExtensionContext): unknown[] => {
  const sessionManager = ctx.sessionManager as {
    getBranch?: () => unknown[];
    getEntries: () => unknown[];
  };

  return typeof sessionManager.getBranch === "function"
    ? sessionManager.getBranch()
    : sessionManager.getEntries();
};

export class PlanModeState {
  mode: PlanMode;
  phase: PlanPhase = "plan";
  todos: TodoItem[] = [];
  nextTodoId = 1;
  activeRun: PlanRun | null = null;
  recentRuns: PlanRun[] = [];
  readFiles = new Set<string>();
  activePlanPath: string | null = null;
  latestReviewArtifactPath: string | null = null;
  reviewApprovedPlanPaths = new Set<string>();
  pendingApprovedPlanContinuationPath: string | null = null;
  confirmedApprovedContinuationPath: string | null = null;
  resumableApprovedPlanPath: string | null = null;
  endConversationRequested = false;
  planArtifactFormatOverride: PlanArtifactFormat | null = null;
  lastAutoDecision: PlanDecisionSummary | null = null;

  constructor(defaultMode: PlanMode) {
    this.mode = defaultMode;
    this.phase = phaseForMode(defaultMode);
  }

  reset(defaultMode: PlanMode): void {
    this.mode = defaultMode;
    this.phase = phaseForMode(defaultMode);
    this.todos = [];
    this.nextTodoId = 1;
    this.activeRun = null;
    this.recentRuns = [];
    this.readFiles = new Set();
    this.activePlanPath = null;
    this.latestReviewArtifactPath = null;
    this.reviewApprovedPlanPaths = new Set();
    this.pendingApprovedPlanContinuationPath = null;
    this.confirmedApprovedContinuationPath = null;
    this.resumableApprovedPlanPath = null;
    this.endConversationRequested = false;
    this.planArtifactFormatOverride = null;
    this.lastAutoDecision = null;
  }

  restore(snapshot: PlanModeSnapshot | null, defaultMode: PlanMode): void {
    if (!snapshot) {
      this.reset(defaultMode);
      return;
    }

    this.mode = snapshot.mode;
    this.phase = snapshot.phase;
    this.activeRun = snapshot.activeRun
      ? clonePlanRun(snapshot.activeRun)
      : null;
    this.recentRuns = snapshot.recentRuns
      .map(clonePlanRun)
      .slice(0, RECENT_RUN_LIMIT);
    this.todos = this.activeRun
      ? this.activeRun.todos
      : snapshot.todos.map((todo) => ({ ...todo }));
    this.nextTodoId = this.activeRun
      ? this.activeRun.nextTodoId
      : snapshot.nextTodoId;
    this.readFiles = new Set(snapshot.readFiles);
    this.activePlanPath = snapshot.activePlanPath;
    this.latestReviewArtifactPath = snapshot.latestReviewArtifactPath;
    this.reviewApprovedPlanPaths = new Set(snapshot.reviewApprovedPlanPaths);
    this.pendingApprovedPlanContinuationPath =
      snapshot.pendingApprovedPlanContinuationPath;
    this.confirmedApprovedContinuationPath =
      snapshot.confirmedApprovedContinuationPath;
    this.resumableApprovedPlanPath = snapshot.resumableApprovedPlanPath;
    this.endConversationRequested = snapshot.endConversationRequested;
    this.planArtifactFormatOverride =
      snapshot.planArtifactFormatOverride ?? null;
    this.lastAutoDecision = snapshot.lastAutoDecision ?? null;
  }

  setMode(mode: PlanMode): void {
    const previousPhase = this.phase;
    this.mode = mode;
    this.phase = phaseForMode(mode);
    this.endConversationRequested = false;
    if (previousPhase === "act" && this.phase === "plan") {
      this.clearReviewTracking();
    }
  }

  setPlanArtifactFormatOverride(format: PlanArtifactFormat): void {
    this.planArtifactFormatOverride = format;
  }

  getPlanArtifactFormat(config: PlanModeConfig): PlanArtifactFormat {
    return this.planArtifactFormatOverride ?? config.planArtifactFormat;
  }

  getPlanArtifactFormatSource(
    config: PlanModeConfig,
  ): "session" | "config" | "default" {
    if (this.planArtifactFormatOverride) {
      return "session";
    }
    return config.planArtifactFormatSource;
  }

  clearReviewTracking(): void {
    this.activePlanPath = null;
    this.latestReviewArtifactPath = null;
    this.reviewApprovedPlanPaths = new Set();
  }

  switchApprovedPlanToAct(): void {
    this.mode = "plan";
    this.phase = "act";
  }

  shouldReturnPlanActToPlan(): boolean {
    return (
      this.mode === "plan" && this.phase === "act" && !this.hasUnfinishedTodos()
    );
  }

  returnPlanActToPlan(): void {
    this.archiveCompletedActiveRun();
    this.phase = "plan";
    this.clearReviewTracking();
  }

  completePlanActRun(): void {
    this.archiveCompletedActiveRun();
    this.clearTodos();
    this.clearReviewTracking();
    this.pendingApprovedPlanContinuationPath = null;
    this.confirmedApprovedContinuationPath = null;
    this.resumableApprovedPlanPath = null;
    this.mode = "act";
    this.phase = "act";
  }

  isPlanPhase(): boolean {
    return this.mode === "plan" && this.phase === "plan";
  }

  hasUnfinishedTodos(): boolean {
    return this.todos.some((todo) => todo.status !== "done");
  }

  getNewRunStatus(hasTodos: boolean, planPath: string | null): PlanRunStatus {
    return hasTodos && planPath && this.phase === "act" ? "executing" : "draft";
  }

  getApprovedActivePlanPath(): string | null {
    if (!this.activePlanPath) {
      return null;
    }
    return this.reviewApprovedPlanPaths.has(this.activePlanPath)
      ? this.activePlanPath
      : null;
  }

  hasApprovedActivePlan(): boolean {
    return this.getApprovedActivePlanPath() !== null;
  }

  getApprovedContinuationPlanPath(): string | null {
    return this.getApprovedActivePlanPath() ?? this.resumableApprovedPlanPath;
  }

  clearPendingApprovedPlanContinuation(): void {
    this.pendingApprovedPlanContinuationPath = null;
  }

  confirmApprovedContinuation(planPath: string): void {
    this.confirmedApprovedContinuationPath = planPath;
  }

  clearConfirmedApprovedContinuation(): void {
    this.confirmedApprovedContinuationPath = null;
  }

  consumeConfirmedApprovedContinuation(): string | null {
    const planPath = this.confirmedApprovedContinuationPath;
    this.confirmedApprovedContinuationPath = null;
    if (!planPath || this.mode !== "plan") {
      return null;
    }

    this.activePlanPath = planPath;
    this.latestReviewArtifactPath = planPath;
    this.reviewApprovedPlanPaths.add(planPath);
    this.switchApprovedPlanToAct();
    return planPath;
  }

  getLatestReviewArtifactPath(): string | null {
    return this.latestReviewArtifactPath ?? this.getApprovedActivePlanPath();
  }

  isApprovedReviewArtifactPath(planPath: string | null): boolean {
    return planPath !== null && this.reviewApprovedPlanPaths.has(planPath);
  }

  canStartFirstRunForApprovedPlan(): boolean {
    return (
      !this.activeRun &&
      this.todos.length === 0 &&
      this.recentRuns.length === 0 &&
      this.phase === "act"
    );
  }

  getUnfinishedRunPlanPath(): string | null {
    if (this.activeRun?.status === "completed") {
      return null;
    }
    return this.activeRun?.planPath ?? null;
  }

  isApprovedCompletedPlanActRun(): boolean {
    return (
      this.mode === "plan" &&
      this.phase === "act" &&
      this.activeRun?.status === "completed" &&
      this.activeRun.planPath === this.activePlanPath &&
      this.hasApprovedActivePlan()
    );
  }

  replaceTodos(items: TodoInput[], newRunPlanPath: string | null = null): void {
    this.archiveCompletedActiveRun();
    this.activeRun = createPlanRun(
      [],
      1,
      this.getNewRunStatus(items.length > 0, newRunPlanPath),
      newRunPlanPath,
    );
    this.todos = this.activeRun.todos;
    this.nextTodoId = 1;
    for (const item of items) {
      this.addTodo(item.text, item.status ?? "todo", item.notes);
    }
    this.refreshActiveRunStatus();
  }

  addTodo(
    text: string,
    status: TodoStatusInput = "todo",
    notes?: string,
    newRunPlanPath: string | null = null,
  ): TodoItem {
    const todo: TodoItem = {
      id: this.nextTodoId,
      text,
      status: normalizeTodoStatus(status),
      ...(notes ? { notes } : {}),
    };
    if (!this.activeRun || this.activeRun.status === "archived") {
      this.activeRun = createPlanRun(
        [],
        this.nextTodoId,
        this.getNewRunStatus(true, newRunPlanPath),
        newRunPlanPath,
      );
      this.todos = this.activeRun.todos;
    }
    this.nextTodoId += 1;
    this.todos.push(todo);
    this.activeRun.nextTodoId = this.nextTodoId;
    this.refreshActiveRunStatus();
    return todo;
  }

  updateTodo(id: number, patch: TodoPatch): boolean {
    const todo = this.todos.find((item) => item.id === id);
    if (!todo) {
      return false;
    }
    if (patch.text !== undefined) {
      todo.text = patch.text;
    }
    if (patch.status !== undefined) {
      todo.status = normalizeTodoStatus(patch.status);
    }
    if (patch.notes !== undefined) {
      if (patch.notes) {
        todo.notes = patch.notes;
      } else {
        delete todo.notes;
      }
    }
    this.refreshActiveRunStatus();
    return true;
  }

  removeTodo(id: number): boolean {
    const before = this.todos.length;
    this.todos = this.todos.filter((item) => item.id !== id);
    if (this.activeRun) {
      this.activeRun.todos = this.todos;
    }
    this.refreshActiveRunStatus();
    return before !== this.todos.length;
  }

  clearTodos(): void {
    this.todos = [];
    this.nextTodoId = 1;
    this.activeRun = null;
  }

  archiveCompletedActiveRun(): void {
    if (!this.activeRun || this.activeRun.status !== "completed") {
      return;
    }
    const archived = clonePlanRun({
      ...this.activeRun,
      status: "archived",
      archivedAt: new Date().toISOString(),
    });
    this.recentRuns = [archived, ...this.recentRuns].slice(0, RECENT_RUN_LIMIT);
    this.activeRun = null;
  }

  refreshActiveRunStatus(): void {
    if (!this.activeRun) {
      return;
    }
    this.activeRun.todos = this.todos;
    this.activeRun.nextTodoId = this.nextTodoId;

    const completed = hasCompletedAllTodos(this.todos);
    if (completed && this.activeRun.status !== "completed") {
      this.activeRun.status = "completed";
      this.activeRun.completedAt = new Date().toISOString();
      return;
    }
    if (!completed && this.activeRun.status === "completed") {
      this.activeRun.status = this.activeRun.planPath ? "executing" : "draft";
      delete this.activeRun.completedAt;
    }
  }

  snapshot(): PlanModeSnapshot {
    return {
      mode: this.mode,
      phase: this.phase,
      todos: this.todos.map((todo) => ({ ...todo })),
      nextTodoId: this.nextTodoId,
      activeRun: this.activeRun ? clonePlanRun(this.activeRun) : null,
      recentRuns: this.recentRuns.map(clonePlanRun).slice(0, RECENT_RUN_LIMIT),
      readFiles: [...this.readFiles],
      activePlanPath: this.activePlanPath,
      latestReviewArtifactPath: this.latestReviewArtifactPath,
      reviewApprovedPlanPaths: [...this.reviewApprovedPlanPaths],
      pendingApprovedPlanContinuationPath:
        this.pendingApprovedPlanContinuationPath,
      confirmedApprovedContinuationPath: this.confirmedApprovedContinuationPath,
      resumableApprovedPlanPath: this.resumableApprovedPlanPath,
      endConversationRequested: this.endConversationRequested,
      planArtifactFormatOverride: this.planArtifactFormatOverride,
      lastAutoDecision: this.lastAutoDecision
        ? { ...this.lastAutoDecision }
        : null,
    };
  }
}
