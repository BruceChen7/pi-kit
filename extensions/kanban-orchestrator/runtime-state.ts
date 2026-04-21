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

export type KanbanCardRuntimeState = {
  cardId: string;
  status: "idle" | "running" | "completed" | "failed";
  summary: string | null;
  requestId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  terminalAvailable: boolean;
  terminalChunks: string[];
  terminalProtocol: "sse-text-stream";
};

export type RuntimeActionStateLike = {
  requestId: string;
  cardId: string;
  status: "queued" | "running" | "success" | "failed";
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
      if (state.status === "completed") {
        listener({
          type: "done",
          cardId,
          ts: state.completedAt ?? state.startedAt ?? new Date(0).toISOString(),
          summary: state.summary ?? "completed",
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

    const runtime = this.getOrCreate(state.cardId);
    runtime.requestId = state.requestId;

    if (state.status === "failed") {
      runtime.status = "failed";
      runtime.summary = state.summary;
      runtime.startedAt = state.startedAt;
      runtime.completedAt = state.finishedAt;
      this.emitLifecycle({
        type: "child-failed",
        cardId: state.cardId,
        summary: state.summary,
        ts: state.finishedAt ?? state.startedAt ?? new Date(0).toISOString(),
      });
    }
  }

  recordChildLifecycle(event: KanbanChildLifecycleEvent): void {
    const state = this.getOrCreate(event.cardId);
    if (event.type === "child-running") {
      if (state.status === "running") {
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
    return state ? { ...state, terminalChunks: [...state.terminalChunks] } : createEmptyCardRuntime(cardId);
  }
}
