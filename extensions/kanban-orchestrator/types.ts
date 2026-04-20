export const KANBAN_ACTION_NAMES = [
  "reconcile",
  "apply",
  "open-session",
  "custom-prompt",
  "validate",
  "prune-merged",
] as const;

export type KanbanActionName = (typeof KANBAN_ACTION_NAMES)[number];

export function isKanbanActionName(value: string): value is KanbanActionName {
  return (KANBAN_ACTION_NAMES as readonly string[]).includes(value);
}

export function parseKanbanActionName(value: string): KanbanActionName | null {
  const trimmed = value.trim();
  return isKanbanActionName(trimmed) ? trimmed : null;
}

export type KanbanExecutionStatus = "queued" | "running" | "success" | "failed";

export type ExecutionAuditRecord = {
  ts: string;
  requestId: string;
  cardId: string;
  worktreeKey: string;
  action: KanbanActionName;
  executor: "orchestrator";
  status: Exclude<KanbanExecutionStatus, "queued" | "running">;
  durationMs: number;
  summary: string;
};
