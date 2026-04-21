import type { KanbanLocalStateStore } from "../extensions/kanban-orchestrator/local-state-store.js";
import type { KanbanOrchestratorService } from "../extensions/kanban-orchestrator/service.js";

const ACTIVE_RUNTIME_STATES = new Set([
  "queued",
  "preparing",
  "opening-session",
  "running",
  "awaiting-reconnect",
]);

const ACTIVE_BOARD_LANES = new Set(["In Progress", "Review"]);

type BoardCardLike = {
  id: string;
  lane: string;
};

function normalizeBoardCard(value: unknown): BoardCardLike | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as { id?: unknown; lane?: unknown };
  return typeof candidate.id === "string" && typeof candidate.lane === "string"
    ? { id: candidate.id, lane: candidate.lane }
    : null;
}

function findBoardCard(
  cards: unknown[],
  cardId: string,
): BoardCardLike | undefined {
  return (
    cards.map(normalizeBoardCard).find((card) => card?.id === cardId) ??
    undefined
  );
}

export function reconcileBoardRuntimeConflicts(input: {
  store: KanbanLocalStateStore;
  service: KanbanOrchestratorService;
  repoId: string;
  board: {
    cards: unknown[];
    errors: string[];
  };
  now?: () => string;
}): void {
  if (input.board.errors.length > 0) {
    return;
  }

  const now = input.now ?? (() => new Date().toISOString());
  for (const task of input.store.listTasksByRepo(input.repoId)) {
    const shouldCheckConflict = ACTIVE_RUNTIME_STATES.has(task.runtimeState);
    const boardCard = findBoardCard(input.board.cards, task.cardId);
    const nextConflict = shouldCheckConflict
      ? !boardCard || !ACTIVE_BOARD_LANES.has(boardCard.lane)
      : false;

    if (task.conflict === nextConflict) {
      continue;
    }

    const ts = now();
    input.store.upsertTask({
      ...task,
      conflict: nextConflict,
      updatedAt: ts,
    });

    const runtime = input.service.getCardRuntime(task.cardId);
    input.service.syncCardRuntime({
      cardId: task.cardId,
      requestId: runtime.requestId,
      status: runtime.status,
      summary: runtime.summary,
      startedAt: runtime.startedAt,
      completedAt: runtime.completedAt,
      terminalAvailable: runtime.terminalAvailable,
      conflict: nextConflict,
    });

    input.store.appendTaskEvent({
      eventId: `conflict:${task.taskId}:${ts}:${nextConflict ? "on" : "off"}`,
      taskId: task.taskId,
      eventType: nextConflict
        ? "board-runtime-conflict-detected"
        : "board-runtime-conflict-cleared",
      payload: nextConflict
        ? {
            cardId: task.cardId,
            lane: boardCard?.lane ?? null,
            reason: boardCard ? "lane-mismatch" : "missing-card",
          }
        : {
            cardId: task.cardId,
          },
      ts,
    });
  }
}
