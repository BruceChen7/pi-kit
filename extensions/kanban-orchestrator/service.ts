import { appendExecutionAuditLog } from "./audit-log.js";
import { WorktreeLockManager } from "./lock-manager.js";
import {
  type KanbanChildLifecycleEvent,
  type KanbanCardRuntimeState,
  type KanbanTerminalEvent,
  KanbanRuntimeStateStore,
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
};

export type KanbanActionExecutor = (input: {
  requestId: string;
  cardId: string;
  worktreeKey: string;
  payload?: Record<string, unknown>;
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
  return status === "success" || status === "failed";
}

function toSummary(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

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

  private readonly now: () => string;

  private readonly createRequestId: () => string;

  private readonly runtimeState = new KanbanRuntimeStateStore();

  private readonly auditLogPath: string;

  private readonly sessionRegistryPath: string | null;

  constructor(input: {
    actionExecutors: KanbanActionExecutors;
    auditLogPath: string;
    lockManager?: WorktreeLockManager;
    now?: () => string;
    createRequestId?: () => string;
    sessionRegistryPath?: string;
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
  }

  private setState(state: KanbanActionRequestState): void {
    this.states.set(state.requestId, state);
    this.runtimeState.recordActionState(state);
    for (const listener of this.listeners) {
      listener(state);
    }
  }

  subscribe(listener: (state: KanbanActionRequestState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
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

    this.setState(initialState);
    const deferred = createDeferred<KanbanActionRequestState>();
    this.waiters.set(requestId, deferred);

    void this.lockManager
      .run(input.worktreeKey, async () => {
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
          });

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
        }
      });

    return requestId;
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
