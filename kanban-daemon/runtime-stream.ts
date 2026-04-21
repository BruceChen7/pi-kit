import type { AgentRuntimeEvent } from "../extensions/kanban-orchestrator/agent-runtime-adapter.js";
import type { KanbanLocalStateStore } from "../extensions/kanban-orchestrator/local-state-store.js";
import type { KanbanOrchestratorService } from "../extensions/kanban-orchestrator/service.js";

function appendRuntimeEvent(input: {
  store: KanbanLocalStateStore;
  taskId: string;
  event: AgentRuntimeEvent;
  payload: Record<string, unknown>;
  ts: string;
}): void {
  input.store.appendTaskEvent({
    eventId: `runtime:${input.taskId}:${input.event.type}:${input.ts}`,
    taskId: input.taskId,
    eventType: `runtime-${input.event.type}`,
    payload: input.payload,
    ts: input.ts,
  });
}

function upsertTaskSummary(input: {
  store: KanbanLocalStateStore;
  taskId: string;
  nextState: string;
  summary: string;
  ts: string;
}): void {
  const task = input.store.getTask(input.taskId);
  if (!task) {
    return;
  }

  input.store.upsertTask({
    ...task,
    runtimeState: input.nextState,
    summary: input.summary,
    updatedAt: input.ts,
  });
}

function toPayload(event: AgentRuntimeEvent): Record<string, unknown> {
  switch (event.type) {
    case "session-opened":
    case "agent-started":
    case "session-lost":
      return {
        sessionRef: event.sessionRef,
      };
    case "output-delta":
      return {
        sessionRef: event.sessionRef,
        chunk: event.chunk,
      };
    case "agent-completed":
      return {
        sessionRef: event.sessionRef,
        summary: event.summary ?? "agent completed",
      };
    case "agent-failed":
      return {
        sessionRef: event.sessionRef,
        error: event.error,
      };
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTerminalTaskState(runtimeState: string | undefined): boolean {
  return (
    runtimeState === "completed" ||
    runtimeState === "failed" ||
    runtimeState === "recoverable-failed" ||
    runtimeState === "cancelled"
  );
}

export async function consumeRuntimeSessionStream(input: {
  store: KanbanLocalStateStore;
  service: KanbanOrchestratorService;
  taskId: string;
  cardId: string;
  sessionRef: string;
  events: AsyncIterable<AgentRuntimeEvent>;
  now?: () => string;
}): Promise<void> {
  const now = input.now ?? (() => new Date().toISOString());
  let lastTs: string | null = null;

  try {
    for await (const event of input.events) {
      const ts = event.type === "agent-started" && lastTs ? lastTs : now();
      lastTs = ts;

      appendRuntimeEvent({
        store: input.store,
        taskId: input.taskId,
        event,
        payload: toPayload(event),
        ts,
      });

      if (event.type === "session-opened") {
        continue;
      }

      if (event.type === "agent-started") {
        upsertTaskSummary({
          store: input.store,
          taskId: input.taskId,
          nextState: "running",
          summary: "agent started",
          ts,
        });
        input.service.recordChildLifecycle({
          type: "child-running",
          cardId: input.cardId,
          summary: "agent started",
          ts,
        });
        continue;
      }

      if (event.type === "output-delta") {
        input.service.appendTerminalChunk({
          cardId: input.cardId,
          chunk: event.chunk,
          ts,
        });
        continue;
      }

      if (event.type === "agent-completed") {
        const summary = event.summary ?? "agent completed";
        upsertTaskSummary({
          store: input.store,
          taskId: input.taskId,
          nextState: "completed",
          summary,
          ts,
        });
        input.service.recordChildLifecycle({
          type: "child-completed",
          cardId: input.cardId,
          summary,
          ts,
        });
        continue;
      }

      if (event.type === "agent-failed") {
        upsertTaskSummary({
          store: input.store,
          taskId: input.taskId,
          nextState: "failed",
          summary: event.error,
          ts,
        });
        input.service.recordChildLifecycle({
          type: "child-failed",
          cardId: input.cardId,
          summary: event.error,
          ts,
        });
        continue;
      }

      upsertTaskSummary({
        store: input.store,
        taskId: input.taskId,
        nextState: "awaiting-reconnect",
        summary: "session lost",
        ts,
      });
      input.service.syncCardRuntime({
        cardId: input.cardId,
        requestId: input.taskId,
        status: "awaiting-reconnect",
        summary: "session lost",
        completedAt: null,
        terminalAvailable: true,
      });
    }
  } catch (error) {
    const ts = now();
    const message = toErrorMessage(error);

    input.store.appendTaskEvent({
      eventId: `runtime:${input.taskId}:stream-disconnected:${ts}`,
      taskId: input.taskId,
      eventType: "runtime-stream-disconnected",
      payload: {
        sessionRef: input.sessionRef,
        error: message,
      },
      ts,
    });

    const task = input.store.getTask(input.taskId);
    if (isTerminalTaskState(task?.runtimeState)) {
      return;
    }

    upsertTaskSummary({
      store: input.store,
      taskId: input.taskId,
      nextState: "awaiting-reconnect",
      summary: "stream disconnected",
      ts,
    });
    input.service.syncCardRuntime({
      cardId: input.cardId,
      requestId: input.taskId,
      status: "awaiting-reconnect",
      summary: "stream disconnected",
      completedAt: null,
      terminalAvailable: true,
    });
  }
}
