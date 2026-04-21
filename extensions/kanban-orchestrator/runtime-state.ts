export type KanbanChildLifecycleEvent = {
  type: "child-running" | "child-completed" | "child-failed";
  cardId: string;
  summary: string;
  ts: string;
};

export type KanbanTerminalEvent =
  | {
      type: "ready";
      cardId: string;
      ts: string;
      protocol: "sse-text-stream";
    }
  | {
      type: "status";
      cardId: string;
      ts: string;
      status: "running";
      summary: string;
    }
  | {
      type: "chunk";
      cardId: string;
      ts: string;
      chunk: string;
    }
  | {
      type: "done";
      cardId: string;
      ts: string;
      summary: string;
    }
  | {
      type: "error";
      cardId: string;
      ts: string;
      error: string;
    };

export type KanbanRuntimeExecutionStatus =
  | "idle"
  | "queued"
  | "preparing"
  | "opening-session"
  | "running"
  | "awaiting-reconnect"
  | "completed"
  | "failed"
  | "recoverable-failed"
  | "cancelled";

export type KanbanCardRuntimeState = {
  cardId: string;
  status: KanbanRuntimeExecutionStatus;
  summary: string | null;
  requestId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  terminalAvailable: boolean;
  terminalChunks: string[];
  terminalProtocol: "sse-text-stream";
  conflict: boolean;
};

export type RuntimeActionStateLike = {
  requestId: string;
  cardId: string;
  status: "queued" | "running" | "success" | "failed" | "cancelled";
  summary: string;
  startedAt: string | null;
  finishedAt: string | null;
};

function createEmptyCardRuntime(cardId: string): KanbanCardRuntimeState {
  return {
    cardId,
    status: "idle",
    summary: null,
    requestId: null,
    startedAt: null,
    completedAt: null,
    terminalAvailable: false,
    terminalChunks: [],
    terminalProtocol: "sse-text-stream",
    conflict: false,
  };
}

export class KanbanRuntimeStateStore {
  private readonly byCardId = new Map<string, KanbanCardRuntimeState>();

  private readonly lifecycleListeners = new Set<
    (event: KanbanChildLifecycleEvent) => void
  >();

  private readonly terminalListeners = new Map<
    string,
    Set<(event: KanbanTerminalEvent) => void>
  >();

  private getOrCreate(cardId: string): KanbanCardRuntimeState {
    const existing = this.byCardId.get(cardId);
    if (existing) {
      return existing;
    }

    const created = createEmptyCardRuntime(cardId);
    this.byCardId.set(cardId, created);
    return created;
  }

  private emitLifecycle(event: KanbanChildLifecycleEvent): void {
    for (const listener of this.lifecycleListeners) {
      listener(event);
    }
  }

  private emitTerminal(cardId: string, event: KanbanTerminalEvent): void {
    const listeners = this.terminalListeners.get(cardId);
    if (!listeners) {
      return;
    }

    for (const listener of listeners) {
      listener(event);
    }
  }

  private ensureTerminalReady(cardId: string, ts: string): void {
    const state = this.getOrCreate(cardId);
    if (state.terminalAvailable) {
      return;
    }

    state.terminalAvailable = true;
    this.emitTerminal(cardId, {
      type: "ready",
      cardId,
      ts,
      protocol: "sse-text-stream",
    });
  }

  subscribeLifecycle(
    listener: (event: KanbanChildLifecycleEvent) => void,
  ): () => void {
    this.lifecycleListeners.add(listener);
    return () => {
      this.lifecycleListeners.delete(listener);
    };
  }

  subscribeTerminal(
    cardId: string,
    listener: (event: KanbanTerminalEvent) => void,
  ): () => void {
    const state = this.getOrCreate(cardId);

    if (state.terminalAvailable) {
      listener({
        type: "ready",
        cardId,
        ts: state.startedAt ?? state.completedAt ?? new Date(0).toISOString(),
        protocol: state.terminalProtocol,
      });
      if (state.status === "running") {
        listener({
          type: "status",
          cardId,
          ts: state.startedAt ?? new Date(0).toISOString(),
          status: "running",
          summary: state.summary ?? "running",
        });
      }
      for (const chunk of state.terminalChunks) {
        listener({
          type: "chunk",
          cardId,
          ts: state.startedAt ?? new Date(0).toISOString(),
          chunk,
        });
      }
      if (state.status === "completed" || state.status === "cancelled") {
        listener({
          type: "done",
          cardId,
          ts: state.completedAt ?? state.startedAt ?? new Date(0).toISOString(),
          summary:
            state.summary ??
            (state.status === "cancelled" ? "cancelled" : "completed"),
        });
      }
      if (state.status === "failed") {
        listener({
          type: "error",
          cardId,
          ts: state.completedAt ?? state.startedAt ?? new Date(0).toISOString(),
          error: state.summary ?? "failed",
        });
      }
    }

    let listeners = this.terminalListeners.get(cardId);
    if (!listeners) {
      listeners = new Set();
      this.terminalListeners.set(cardId, listeners);
    }
    listeners.add(listener);

    return () => {
      const current = this.terminalListeners.get(cardId);
      current?.delete(listener);
      if (current && current.size === 0) {
        this.terminalListeners.delete(cardId);
      }
    };
  }

  recordActionState(state: RuntimeActionStateLike): void {
    if (!state.cardId || state.cardId === "__global__") {
      return;
    }

    if (state.status === "queued") {
      this.upsertCardRuntime({
        cardId: state.cardId,
        requestId: state.requestId,
        status: "queued",
        summary: state.summary,
      });
      return;
    }

    if (state.status === "running") {
      this.upsertCardRuntime({
        cardId: state.cardId,
        requestId: state.requestId,
        status: "running",
        summary: state.summary,
        startedAt: state.startedAt,
        completedAt: null,
      });
      return;
    }

    if (state.status === "success") {
      this.upsertCardRuntime({
        cardId: state.cardId,
        requestId: state.requestId,
        status: "completed",
        summary: state.summary,
        startedAt: state.startedAt,
        completedAt: state.finishedAt,
      });
      return;
    }

    if (state.status === "cancelled") {
      this.upsertCardRuntime({
        cardId: state.cardId,
        requestId: state.requestId,
        status: "cancelled",
        summary: state.summary,
        startedAt: state.startedAt,
        completedAt: state.finishedAt,
      });
      if (this.getOrCreate(state.cardId).terminalAvailable) {
        this.emitTerminal(state.cardId, {
          type: "done",
          cardId: state.cardId,
          ts: state.finishedAt ?? state.startedAt ?? new Date(0).toISOString(),
          summary: state.summary,
        });
      }
      return;
    }

    this.upsertCardRuntime({
      cardId: state.cardId,
      requestId: state.requestId,
      status: "failed",
      summary: state.summary,
      startedAt: state.startedAt,
      completedAt: state.finishedAt,
    });
    this.emitLifecycle({
      type: "child-failed",
      cardId: state.cardId,
      summary: state.summary,
      ts: state.finishedAt ?? state.startedAt ?? new Date(0).toISOString(),
    });
  }

  upsertCardRuntime(input: {
    cardId: string;
    requestId?: string | null;
    status: KanbanRuntimeExecutionStatus;
    summary?: string | null;
    startedAt?: string | null;
    completedAt?: string | null;
    terminalAvailable?: boolean;
    conflict?: boolean;
  }): void {
    const state = this.getOrCreate(input.cardId);
    if (input.requestId !== undefined) {
      state.requestId = input.requestId;
    }
    state.status = input.status;
    if (input.summary !== undefined) {
      state.summary = input.summary;
    }
    if (input.startedAt !== undefined) {
      state.startedAt = input.startedAt;
    }
    if (input.completedAt !== undefined) {
      state.completedAt = input.completedAt;
    }
    if (input.conflict !== undefined) {
      state.conflict = input.conflict;
    }
    if (input.terminalAvailable) {
      this.ensureTerminalReady(
        input.cardId,
        input.startedAt ?? state.startedAt ?? new Date(0).toISOString(),
      );
    }
  }

  recordChildLifecycle(event: KanbanChildLifecycleEvent): void {
    const state = this.getOrCreate(event.cardId);
    if (event.type === "child-running") {
      if (state.status === "running" && state.startedAt) {
        return;
      }

      state.status = "running";
      state.summary = event.summary;
      state.startedAt = event.ts;
      state.completedAt = null;
      this.ensureTerminalReady(event.cardId, event.ts);
      this.emitLifecycle(event);
      this.emitTerminal(event.cardId, {
        type: "status",
        cardId: event.cardId,
        ts: event.ts,
        status: "running",
        summary: event.summary,
      });
      return;
    }

    if (event.type === "child-completed") {
      state.status = "completed";
      state.summary = event.summary;
      state.completedAt = event.ts;
      this.ensureTerminalReady(event.cardId, state.startedAt ?? event.ts);
      this.emitLifecycle(event);
      this.emitTerminal(event.cardId, {
        type: "done",
        cardId: event.cardId,
        ts: event.ts,
        summary: event.summary,
      });
      return;
    }

    state.status = "failed";
    state.summary = event.summary;
    state.completedAt = event.ts;
    this.emitLifecycle(event);
    this.emitTerminal(event.cardId, {
      type: "error",
      cardId: event.cardId,
      ts: event.ts,
      error: event.summary,
    });
  }

  appendTerminalChunk(input: {
    cardId: string;
    chunk: string;
    ts: string;
  }): void {
    const state = this.getOrCreate(input.cardId);
    this.ensureTerminalReady(input.cardId, input.ts);
    state.terminalChunks = [...state.terminalChunks, input.chunk].slice(-500);
    this.emitTerminal(input.cardId, {
      type: "chunk",
      cardId: input.cardId,
      ts: input.ts,
      chunk: input.chunk,
    });
  }

  getCardRuntime(cardId: string): KanbanCardRuntimeState {
    const state = this.byCardId.get(cardId);
    return state
      ? { ...state, terminalChunks: [...state.terminalChunks] }
      : createEmptyCardRuntime(cardId);
  }
}
