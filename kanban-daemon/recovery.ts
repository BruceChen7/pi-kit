import type { AgentRuntimeAdapter } from "../extensions/kanban-orchestrator/agent-runtime-adapter.js";
import type {
  KanbanLocalStateStore,
  KanbanSessionRecord,
  KanbanTaskRecord,
} from "../extensions/kanban-orchestrator/local-state-store.js";

const ACTIVE_RUNTIME_STATES = new Set([
  "queued",
  "preparing",
  "opening-session",
  "running",
  "awaiting-reconnect",
]);

function upsertTaskState(input: {
  store: KanbanLocalStateStore;
  task: KanbanTaskRecord;
  runtimeState: string;
  summary: string;
  ts: string;
}): void {
  input.store.upsertTask({
    ...input.task,
    runtimeState: input.runtimeState,
    updatedAt: input.ts,
    summary: input.summary,
  });
}

function upsertSessionState(input: {
  store: KanbanLocalStateStore;
  session: KanbanSessionRecord;
  status: string;
  resumable: boolean;
  sessionRef?: string;
  ts: string;
}): void {
  input.store.upsertSession({
    ...input.session,
    adapterSessionRef: input.sessionRef ?? input.session.adapterSessionRef,
    status: input.status,
    resumable: input.resumable,
    lastEventAt: input.ts,
    updatedAt: input.ts,
  });
}

function appendRecoveryEvent(input: {
  store: KanbanLocalStateStore;
  taskId: string;
  eventType: string;
  payload: Record<string, unknown>;
  ts: string;
}): void {
  input.store.appendTaskEvent({
    eventId: `recovery:${input.taskId}:${input.ts}`,
    taskId: input.taskId,
    eventType: input.eventType,
    payload: input.payload,
    ts: input.ts,
  });
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function recoverTask(input: {
  store: KanbanLocalStateStore;
  task: KanbanTaskRecord;
  adapters: Record<string, AgentRuntimeAdapter>;
  now: () => string;
}): Promise<void> {
  if (!ACTIVE_RUNTIME_STATES.has(input.task.runtimeState)) {
    return;
  }

  const session = input.store.getSessionByTask(input.task.taskId);
  const ts = input.now();
  if (!session) {
    upsertTaskState({
      store: input.store,
      task: input.task,
      runtimeState: "failed",
      summary: "session missing during recovery",
      ts,
    });
    appendRecoveryEvent({
      store: input.store,
      taskId: input.task.taskId,
      eventType: "recovery-failed",
      payload: {
        reason: "missing-session",
      },
      ts,
    });
    return;
  }

  const adapter = input.adapters[session.adapterType];
  if (!adapter) {
    upsertTaskState({
      store: input.store,
      task: input.task,
      runtimeState: "recoverable-failed",
      summary: `missing adapter: ${session.adapterType}`,
      ts,
    });
    appendRecoveryEvent({
      store: input.store,
      taskId: input.task.taskId,
      eventType: "recovery-failed",
      payload: {
        adapterType: session.adapterType,
        reason: "missing-adapter",
      },
      ts,
    });
    return;
  }

  let resumed: Awaited<ReturnType<AgentRuntimeAdapter["resumeSession"]>>;
  try {
    resumed = await adapter.resumeSession(session.adapterSessionRef);
  } catch (error) {
    upsertTaskState({
      store: input.store,
      task: input.task,
      runtimeState: "recoverable-failed",
      summary: "adapter attach failed",
      ts,
    });
    upsertSessionState({
      store: input.store,
      session,
      status: "attach-failed",
      resumable: session.resumable,
      ts,
    });
    appendRecoveryEvent({
      store: input.store,
      taskId: input.task.taskId,
      eventType: "recovery-attach-failed",
      payload: {
        adapterType: session.adapterType,
        reason: "attach-failed",
        error: toErrorMessage(error),
      },
      ts,
    });
    return;
  }

  if (resumed.attached && resumed.resumable) {
    upsertTaskState({
      store: input.store,
      task: input.task,
      runtimeState: "running",
      summary: "session resumed",
      ts,
    });
    upsertSessionState({
      store: input.store,
      session,
      status: "running",
      resumable: resumed.resumable,
      sessionRef: resumed.sessionRef,
      ts,
    });
    appendRecoveryEvent({
      store: input.store,
      taskId: input.task.taskId,
      eventType: "recovery-resumed",
      payload: {
        adapterType: session.adapterType,
        sessionRef: resumed.sessionRef,
      },
      ts,
    });
    return;
  }

  const status = await adapter.getSessionStatus(session.adapterSessionRef);
  upsertTaskState({
    store: input.store,
    task: input.task,
    runtimeState: status.resumable ? "failed" : "recoverable-failed",
    summary: "session could not be resumed",
    ts,
  });
  upsertSessionState({
    store: input.store,
    session,
    status: status.status,
    resumable: status.resumable,
    ts,
  });
  appendRecoveryEvent({
    store: input.store,
    taskId: input.task.taskId,
    eventType: "recovery-failed",
    payload: {
      adapterType: session.adapterType,
      resumable: status.resumable,
    },
    ts,
  });
}

export async function recoverKanbanTasks(input: {
  store: KanbanLocalStateStore;
  repoId: string;
  adapters: Record<string, AgentRuntimeAdapter>;
  now?: () => string;
}): Promise<void> {
  const now = input.now ?? (() => new Date().toISOString());
  for (const task of input.store.listTasksByRepo(input.repoId)) {
    await recoverTask({
      store: input.store,
      task,
      adapters: input.adapters,
      now,
    });
  }
}
