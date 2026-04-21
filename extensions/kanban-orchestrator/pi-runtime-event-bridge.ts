import type { AgentRuntimeEvent } from "./agent-runtime-adapter.js";

type PiRuntimeEventWithoutSessionRef =
  | { type: "agent-started" }
  | { type: "output-delta"; chunk: string }
  | { type: "agent-completed"; summary?: string }
  | { type: "agent-failed"; error: string }
  | { type: "session-lost" };

type SessionQueue = {
  pending: AgentRuntimeEvent[];
  waiters: Array<(event: AgentRuntimeEvent | null) => void>;
  attached: boolean;
};

function isTerminalEvent(event: AgentRuntimeEvent): boolean {
  return (
    event.type === "agent-completed" ||
    event.type === "agent-failed" ||
    event.type === "session-lost"
  );
}

export function createPiRuntimeEventBridge() {
  const sessionRefsByWorktreePath = new Map<string, Set<string>>();
  const worktreePathBySessionRef = new Map<string, string>();
  const queuesBySessionRef = new Map<string, SessionQueue>();

  function getOrCreateQueue(sessionRef: string): SessionQueue {
    const existing = queuesBySessionRef.get(sessionRef);
    if (existing) {
      return existing;
    }

    const created: SessionQueue = {
      pending: [],
      waiters: [],
      attached: false,
    };
    queuesBySessionRef.set(sessionRef, created);
    return created;
  }

  function pushEvent(sessionRef: string, event: AgentRuntimeEvent): void {
    const queue = getOrCreateQueue(sessionRef);
    const waiter = queue.waiters.shift();
    if (waiter) {
      waiter(event);
      return;
    }
    queue.pending.push(event);
  }

  return {
    attachSession(sessionRef: string, worktreePath: string): void {
      worktreePathBySessionRef.set(sessionRef, worktreePath);
      let refs = sessionRefsByWorktreePath.get(worktreePath);
      if (!refs) {
        refs = new Set();
        sessionRefsByWorktreePath.set(worktreePath, refs);
      }
      refs.add(sessionRef);
      getOrCreateQueue(sessionRef).attached = true;
    },

    emitForWorktreePath(
      worktreePath: string,
      event: PiRuntimeEventWithoutSessionRef,
    ): void {
      const refs = sessionRefsByWorktreePath.get(worktreePath);
      if (!refs) {
        return;
      }

      for (const sessionRef of refs) {
        pushEvent(sessionRef, {
          ...event,
          sessionRef,
        } as AgentRuntimeEvent);
      }
    },

    async *streamEvents(sessionRef: string): AsyncIterable<AgentRuntimeEvent> {
      const queue = getOrCreateQueue(sessionRef);
      if (queue.attached) {
        yield {
          type: "session-opened",
          sessionRef,
        };
      }

      while (true) {
        const next = queue.pending.shift();
        const event = next
          ? next
          : await new Promise<AgentRuntimeEvent | null>((resolve) => {
              queue.waiters.push(resolve);
            });
        if (!event) {
          return;
        }

        yield event;
        if (isTerminalEvent(event)) {
          return;
        }
      }
    },

    clear(): void {
      for (const queue of queuesBySessionRef.values()) {
        for (const waiter of queue.waiters.splice(0)) {
          waiter(null);
        }
      }
      queuesBySessionRef.clear();
      worktreePathBySessionRef.clear();
      sessionRefsByWorktreePath.clear();
    },
  };
}

export type PiRuntimeEventBridge = ReturnType<
  typeof createPiRuntimeEventBridge
>;
