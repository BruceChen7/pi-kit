export type AgentRuntimeStatus =
  | "idle"
  | "running"
  | "completed"
  | "failed"
  | "unknown";

export type AgentRuntimeEvent =
  | { type: "session-opened"; sessionRef: string }
  | { type: "agent-started"; sessionRef: string }
  | { type: "output-delta"; sessionRef: string; chunk: string }
  | { type: "agent-completed"; sessionRef: string; summary?: string }
  | { type: "agent-failed"; sessionRef: string; error: string }
  | { type: "session-lost"; sessionRef: string };

export type AgentRuntimeAdapter = {
  kind: string;
  openSession(input: {
    repoPath: string;
    worktreePath: string | null;
    taskId: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ sessionRef: string; resumable: boolean }>;
  resumeSession(sessionRef: string): Promise<{
    sessionRef: string;
    attached: boolean;
    resumable: boolean;
  }>;
  sendPrompt(input: { sessionRef: string; prompt: string }): Promise<void>;
  interrupt(sessionRef: string): Promise<void>;
  closeSession(sessionRef: string): Promise<void>;
  getSessionStatus(sessionRef: string): Promise<{
    status: AgentRuntimeStatus;
    resumable: boolean;
  }>;
  streamEvents(sessionRef: string): AsyncIterable<AgentRuntimeEvent>;
};
