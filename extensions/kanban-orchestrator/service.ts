import { appendExecutionAuditLog } from "./audit-log.js";
import {
  KanbanLocalStateStore,
  type KanbanTaskRecord,
} from "./local-state-store.js";
import { WorktreeLockManager } from "./lock-manager.js";
import {
  type KanbanCardRuntimeState,
  type KanbanChildLifecycleEvent,
  type KanbanRuntimeExecutionStatus,
  KanbanRuntimeStateStore,
  type KanbanTerminalEvent,
} from "./runtime-state.js";
import { upsertSessionRegistryCard } from "./session-registry.js";
import {
  type KanbanActionName,
  type KanbanExecutionStatus,
  parseKanbanActionName,
} from "./types.js";

export type KanbanActionExecutorResult = {
  summary: string;
  chatJid?: string;
  worktreePath?: string;
  adapterType?: string;
};

export type KanbanRuntimeProgressUpdate = {
  status: KanbanRuntimeExecutionStatus;
  summary: string;
  terminalAvailable?: boolean;
  conflict?: boolean;
};

export type KanbanActionExecutor = (input: {
  requestId: string;
  cardId: string;
  worktreeKey: string;
  payload?: Record<string, unknown>;
  reportRuntimeStatus?: (update: KanbanRuntimeProgressUpdate) => void;
}) => Promise<KanbanActionExecutorResult>;

export type KanbanActionExecutors = Partial<
  Record<KanbanActionName, KanbanActionExecutor>
>;

export type KanbanActionRequestState = {
  requestId: string;
  action: KanbanActionName;
  cardId: string;
  worktreeKey: string;
  status: KanbanExecutionStatus;
  summary: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolveRef: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    resolveRef = resolve;
  });
  return {
    promise,
    resolve: resolveRef,
  };
}

function isTerminalStatus(status: KanbanExecutionStatus): boolean {
  return status === "success" || status === "failed" || status === "cancelled";
}

function toSummary(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

function toPersistedRuntimeState(status: KanbanExecutionStatus): string {
  return status === "success" ? "completed" : status;
}

function fromPersistedTask(
  task: KanbanTaskRecord,
): KanbanActionRequestState | null {
  const action =
    typeof task.request?.action === "string"
      ? parseKanbanActionName(task.request.action)
      : null;
  const worktreeKey =
    typeof task.request?.worktreeKey === "string"
      ? task.request.worktreeKey
      : null;
  if (!action || !worktreeKey) {
    return null;
  }

  const status =
    task.runtimeState === "completed"
      ? "success"
      : task.runtimeState === "queued"
        ? "queued"
        : task.runtimeState === "preparing" ||
            task.runtimeState === "opening-session" ||
            task.runtimeState === "running" ||
            task.runtimeState === "awaiting-reconnect"
          ? "running"
          : task.runtimeState === "failed" ||
              task.runtimeState === "recoverable-failed"
            ? "failed"
            : task.runtimeState === "cancelled"
              ? "cancelled"
              : null;
  if (!status) {
    return null;
  }

  const startedAt =
    typeof task.request?.startedAt === "string" ? task.request.startedAt : null;
  const finishedAt =
    typeof task.request?.finishedAt === "string"
      ? task.request.finishedAt
      : null;

  return {
    requestId: task.taskId,
    action,
    cardId: task.cardId,
    worktreeKey,
    status,
    summary: task.summary ?? status,
    startedAt,
    finishedAt,
    durationMs: null,
  };
}

function toPersistedRuntimeStatus(
  value: string,
): KanbanRuntimeExecutionStatus | null {
  switch (value) {
    case "idle":
    case "queued":
    case "preparing":
    case "opening-session":
    case "running":
    case "awaiting-reconnect":
    case "completed":
    case "failed":
    case "recoverable-failed":
    case "cancelled":
      return value;
    default:
      return null;
  }
}

function syncCardRuntimeFromTask(
  runtimeState: KanbanRuntimeStateStore,
  task: KanbanTaskRecord,
): void {
  const status = toPersistedRuntimeStatus(task.runtimeState);
  if (!status) {
    return;
  }

  const startedAt =
    typeof task.request?.startedAt === "string" ? task.request.startedAt : null;
  const finishedAt =
    typeof task.request?.finishedAt === "string"
      ? task.request.finishedAt
      : status === "completed" ||
          status === "failed" ||
          status === "recoverable-failed" ||
          status === "cancelled"
        ? task.updatedAt
        : null;

  runtimeState.upsertCardRuntime({
    cardId: task.cardId,
    requestId: task.taskId,
    status,
    summary: task.summary,
    startedAt,
    completedAt: finishedAt,
    conflict: task.conflict,
  });
}

type SessionStreamTarget = {
  taskId: string;
  cardId: string;
  sessionRef: string;
  adapterType: string;
  worktreePath: string;
};

export class KanbanOrchestratorService {
  private readonly lockManager: WorktreeLockManager;

  private actionExecutors: KanbanActionExecutors;

  private readonly states = new Map<string, KanbanActionRequestState>();

  private readonly waiters = new Map<
    string,
    Deferred<KanbanActionRequestState>
  >();

  private readonly listeners = new Set<
    (state: KanbanActionRequestState) => void
  >();

  private readonly createdAtByRequest = new Map<string, string>();

  private readonly cancelledRequests = new Set<string>();

  private sessionStreamHandler:
    | ((target: SessionStreamTarget) => Promise<void>)
    | null = null;

  private readonly now: () => string;

  private readonly createRequestId: () => string;

  private readonly runtimeState = new KanbanRuntimeStateStore();

  private readonly auditLogPath: string;

  private readonly sessionRegistryPath: string | null;

  private readonly localState: KanbanLocalStateStore | null;

  private readonly repoId: string | null;

  constructor(input: {
    actionExecutors: KanbanActionExecutors;
    auditLogPath: string;
    lockManager?: WorktreeLockManager;
    now?: () => string;
    createRequestId?: () => string;
    sessionRegistryPath?: string;
    localStatePath?: string;
    repoRoot?: string;
    boardPath?: string;
    defaultAdapter?: string;
  }) {
    this.actionExecutors = input.actionExecutors;
    this.auditLogPath = input.auditLogPath;
    this.lockManager = input.lockManager ?? new WorktreeLockManager();
    this.now = input.now ?? (() => new Date().toISOString());
    this.sessionRegistryPath = input.sessionRegistryPath ?? null;
    this.createRequestId =
      input.createRequestId ??
      (() =>
        `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    this.localState = input.localStatePath
      ? new KanbanLocalStateStore({ dbPath: input.localStatePath })
      : null;
    this.repoId = input.repoRoot ?? null;

    if (this.localState && input.repoRoot) {
      const existingRepo = this.localState.getRepo(input.repoRoot);
      const registeredAt = existingRepo?.createdAt ?? new Date().toISOString();
      this.localState.registerRepo({
        repoId: input.repoRoot,
        repoPath: input.repoRoot,
        boardPath: input.boardPath ?? "workitems/features.kanban.md",
        defaultAdapter: input.defaultAdapter ?? "pi",
        createdAt: registeredAt,
        updatedAt: new Date().toISOString(),
      });
      this.restorePersistedStates(input.repoRoot);
    }
  }

  private restorePersistedStates(repoId: string): void {
    if (!this.localState) {
      return;
    }

    for (const task of this.localState.listTasksByRepo(repoId)) {
      const restored = fromPersistedTask(task);
      if (restored) {
        this.states.set(restored.requestId, restored);
        this.runtimeState.recordActionState(restored);
      }
      syncCardRuntimeFromTask(this.runtimeState, task);
    }
  }

  private persistState(state: KanbanActionRequestState): void {
    if (!this.localState || !this.repoId) {
      return;
    }

    const existing = this.localState.getTask(state.requestId);
    const createdAt =
      existing?.createdAt ??
      this.createdAtByRequest.get(state.requestId) ??
      state.startedAt ??
      state.finishedAt ??
      new Date().toISOString();
    const updatedAt =
      state.finishedAt ?? state.startedAt ?? existing?.updatedAt ?? createdAt;

    this.localState.upsertTask({
      taskId: state.requestId,
      repoId: this.repoId,
      cardId: state.cardId,
      intentType: state.action,
      runtimeState: toPersistedRuntimeState(state.status),
      conflict:
        existing?.conflict ??
        this.runtimeState.getCardRuntime(state.cardId).conflict,
      attempt: existing?.attempt ?? 1,
      createdAt,
      updatedAt,
      request: {
        action: state.action,
        worktreeKey: state.worktreeKey,
        startedAt: state.startedAt,
        finishedAt: state.finishedAt,
      },
      summary: state.summary,
    });
    this.localState.appendTaskEvent({
      eventId: `${state.requestId}:${state.status}:${updatedAt}`,
      taskId: state.requestId,
      eventType: "action-state-changed",
      payload: {
        status: state.status,
        summary: state.summary,
      },
      ts: updatedAt,
    });
  }

  private persistSession(input: {
    taskId: string;
    chatJid: string;
    worktreePath: string;
    adapterType: string;
    ts: string;
  }): void {
    if (!this.localState || !this.repoId) {
      return;
    }

    this.localState.upsertSession({
      sessionId: input.taskId,
      taskId: input.taskId,
      adapterType: input.adapterType,
      adapterSessionRef: input.chatJid,
      repoPath: this.repoId,
      worktreePath: input.worktreePath,
      status: "active",
      resumable: true,
      lastEventAt: input.ts,
      createdAt: input.ts,
      updatedAt: input.ts,
    });
  }

  private reportRuntimeStatus(
    requestId: string,
    update: KanbanRuntimeProgressUpdate,
  ): void {
    const state = this.states.get(requestId);
    if (!state) {
      return;
    }

    const ts = this.now();
    this.runtimeState.upsertCardRuntime({
      cardId: state.cardId,
      requestId,
      status: update.status,
      summary: update.summary,
      startedAt: state.startedAt,
      completedAt: null,
      terminalAvailable: update.terminalAvailable,
      conflict: update.conflict,
    });

    if (!this.localState || !this.repoId) {
      return;
    }

    const existing = this.localState.getTask(requestId);
    const createdAt =
      existing?.createdAt ??
      this.createdAtByRequest.get(requestId) ??
      state.startedAt ??
      ts;

    this.localState.upsertTask({
      taskId: requestId,
      repoId: this.repoId,
      cardId: state.cardId,
      intentType: state.action,
      runtimeState: update.status,
      conflict: update.conflict ?? existing?.conflict ?? false,
      attempt: existing?.attempt ?? 1,
      createdAt,
      updatedAt: ts,
      request: {
        action: state.action,
        worktreeKey: state.worktreeKey,
        startedAt: state.startedAt,
        finishedAt: null,
      },
      summary: update.summary,
    });
    this.localState.appendTaskEvent({
      eventId: `${requestId}:runtime:${update.status}:${ts}`,
      taskId: requestId,
      eventType: "runtime-state-changed",
      payload: {
        status: update.status,
        summary: update.summary,
      },
      ts,
    });
  }

  private setState(state: KanbanActionRequestState): void {
    this.states.set(state.requestId, state);
    this.runtimeState.recordActionState(state);
    this.persistState(state);
    for (const listener of this.listeners) {
      listener(state);
    }
  }

  cancelAction(
    requestId: string,
    summary: string = "cancelled",
  ): KanbanActionRequestState | null {
    const state = this.states.get(requestId);
    if (!state) {
      return null;
    }
    if (isTerminalStatus(state.status)) {
      return state;
    }

    this.cancelledRequests.add(requestId);
    const finishedAt = this.now();
    const durationMs = state.startedAt
      ? Math.max(0, Date.parse(finishedAt) - Date.parse(state.startedAt))
      : null;
    const cancelled: KanbanActionRequestState = {
      ...state,
      status: "cancelled",
      summary,
      finishedAt,
      durationMs,
    };
    this.setState(cancelled);

    appendExecutionAuditLog(this.auditLogPath, {
      ts: finishedAt,
      requestId,
      cardId: state.cardId,
      worktreeKey: state.worktreeKey,
      action: state.action,
      executor: "orchestrator",
      status: "cancelled",
      durationMs: durationMs ?? 0,
      summary,
    });

    this.waiters.get(requestId)?.resolve(cancelled);
    return cancelled;
  }

  subscribe(listener: (state: KanbanActionRequestState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setSessionStreamHandler(
    handler: ((target: SessionStreamTarget) => Promise<void>) | null,
  ): void {
    this.sessionStreamHandler = handler;
  }

  setActionExecutors(nextExecutors: KanbanActionExecutors): void {
    this.actionExecutors = nextExecutors;
  }

  subscribeLifecycle(
    listener: (event: KanbanChildLifecycleEvent) => void,
  ): () => void {
    return this.runtimeState.subscribeLifecycle(listener);
  }

  subscribeTerminal(
    cardId: string,
    listener: (event: KanbanTerminalEvent) => void,
  ): () => void {
    return this.runtimeState.subscribeTerminal(cardId, listener);
  }

  recordChildLifecycle(event: KanbanChildLifecycleEvent): void {
    this.runtimeState.recordChildLifecycle(event);
  }

  appendTerminalChunk(input: {
    cardId: string;
    chunk: string;
    ts: string;
  }): void {
    this.runtimeState.appendTerminalChunk(input);
  }

  syncCardRuntime(input: {
    cardId: string;
    requestId?: string | null;
    status: KanbanRuntimeExecutionStatus;
    summary?: string | null;
    startedAt?: string | null;
    completedAt?: string | null;
    terminalAvailable?: boolean;
    conflict?: boolean;
  }): void {
    this.runtimeState.upsertCardRuntime(input);
  }

  refreshPersistedRuntimeStates(): void {
    if (!this.repoId) {
      return;
    }

    this.restorePersistedStates(this.repoId);
  }

  getCardRuntime(cardId: string): KanbanCardRuntimeState {
    return this.runtimeState.getCardRuntime(cardId);
  }

  enqueueAction(input: {
    action: string;
    cardId: string;
    worktreeKey: string;
    payload?: Record<string, unknown>;
  }): string {
    const action = parseKanbanActionName(input.action);
    if (!action) {
      throw new Error(`Unsupported action: ${input.action}`);
    }

    const executor = this.actionExecutors[action];
    if (!executor) {
      throw new Error(`Unsupported action: ${input.action}`);
    }

    const requestId = this.createRequestId();
    const queuedAt = this.now();
    const initialState: KanbanActionRequestState = {
      requestId,
      action,
      cardId: input.cardId,
      worktreeKey: input.worktreeKey,
      status: "queued",
      summary: `queued at ${queuedAt}`,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
    };

    this.createdAtByRequest.set(requestId, queuedAt);
    this.setState(initialState);
    const deferred = createDeferred<KanbanActionRequestState>();
    this.waiters.set(requestId, deferred);

    void this.lockManager
      .run(input.worktreeKey, async () => {
        if (this.cancelledRequests.has(requestId)) {
          return;
        }

        const startedAt = this.now();
        this.setState({
          ...initialState,
          status: "running",
          summary: "running",
          startedAt,
        });

        const startedMs = Date.parse(startedAt);

        try {
          const result = await executor({
            requestId,
            cardId: input.cardId,
            worktreeKey: input.worktreeKey,
            payload: input.payload,
            reportRuntimeStatus: (update) => {
              this.reportRuntimeStatus(requestId, update);
            },
          });

          if (this.cancelledRequests.has(requestId)) {
            return;
          }

          const finishedAt = this.now();
          const durationMs = Math.max(0, Date.parse(finishedAt) - startedMs);
          const completed: KanbanActionRequestState = {
            requestId,
            action,
            cardId: input.cardId,
            worktreeKey: input.worktreeKey,
            status: "success",
            summary: result.summary,
            startedAt,
            finishedAt,
            durationMs,
          };
          this.setState(completed);

          if (
            this.sessionRegistryPath &&
            typeof result.chatJid === "string" &&
            result.chatJid.trim().length > 0
          ) {
            upsertSessionRegistryCard(this.sessionRegistryPath, {
              cardId: input.cardId,
              chatJid: result.chatJid,
              worktreePath:
                typeof result.worktreePath === "string" &&
                result.worktreePath.trim().length > 0
                  ? result.worktreePath
                  : input.worktreeKey,
              nowIso: finishedAt,
            });
          }

          if (
            typeof result.chatJid === "string" &&
            result.chatJid.trim().length > 0
          ) {
            const worktreePath =
              typeof result.worktreePath === "string" &&
              result.worktreePath.trim().length > 0
                ? result.worktreePath
                : input.worktreeKey;
            const adapterType =
              typeof result.adapterType === "string" &&
              result.adapterType.trim().length > 0
                ? result.adapterType
                : "pi";

            this.persistSession({
              taskId: requestId,
              chatJid: result.chatJid,
              worktreePath,
              adapterType,
              ts: finishedAt,
            });

            void this.sessionStreamHandler?.({
              taskId: requestId,
              cardId: input.cardId,
              sessionRef: result.chatJid,
              adapterType,
              worktreePath,
            }).catch(() => {
              // best effort background session streaming in phase 1
            });
          }

          appendExecutionAuditLog(this.auditLogPath, {
            ts: finishedAt,
            requestId,
            cardId: input.cardId,
            worktreeKey: input.worktreeKey,
            action,
            executor: "orchestrator",
            status: "success",
            durationMs,
            summary: result.summary,
          });

          deferred.resolve(completed);
        } catch (error) {
          if (this.cancelledRequests.has(requestId)) {
            return;
          }

          const finishedAt = this.now();
          const durationMs = Math.max(0, Date.parse(finishedAt) - startedMs);
          const summary = toSummary(error);
          const failed: KanbanActionRequestState = {
            requestId,
            action,
            cardId: input.cardId,
            worktreeKey: input.worktreeKey,
            status: "failed",
            summary,
            startedAt,
            finishedAt,
            durationMs,
          };
          this.setState(failed);

          appendExecutionAuditLog(this.auditLogPath, {
            ts: finishedAt,
            requestId,
            cardId: input.cardId,
            worktreeKey: input.worktreeKey,
            action,
            executor: "orchestrator",
            status: "failed",
            durationMs,
            summary,
          });

          deferred.resolve(failed);
        }
      })
      .finally(() => {
        const state = this.states.get(requestId);
        if (state && isTerminalStatus(state.status)) {
          this.waiters.delete(requestId);
          this.createdAtByRequest.delete(requestId);
          this.cancelledRequests.delete(requestId);
        }
      });

    return requestId;
  }

  getRecoveryContext(): {
    store: KanbanLocalStateStore;
    repoId: string;
  } | null {
    if (!this.localState || !this.repoId) {
      return null;
    }

    return {
      store: this.localState,
      repoId: this.repoId,
    };
  }

  getState(requestId: string): KanbanActionRequestState | null {
    return this.states.get(requestId) ?? null;
  }

  async waitFor(requestId: string): Promise<KanbanActionRequestState> {
    const existing = this.states.get(requestId);
    if (existing && isTerminalStatus(existing.status)) {
      return existing;
    }

    const waiter = this.waiters.get(requestId);
    if (!waiter) {
      throw new Error(`Unknown request id: ${requestId}`);
    }

    return waiter.promise;
  }
}
