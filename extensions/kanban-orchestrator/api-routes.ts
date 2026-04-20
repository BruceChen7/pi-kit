import type { ResolveKanbanCardContextResult } from "./context.js";
import type {
  KanbanActionRequestState,
  KanbanOrchestratorService,
} from "./service.js";

export type KanbanApiResponse = {
  status: number;
  body: Record<string, unknown>;
};

function trimToNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function serializeState(
  state: KanbanActionRequestState,
): Record<string, unknown> {
  return {
    requestId: state.requestId,
    action: state.action,
    cardId: state.cardId,
    worktreeKey: state.worktreeKey,
    status: state.status,
    summary: state.summary,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    durationMs: state.durationMs,
  };
}

export function handleExecuteActionRequest(
  service: KanbanOrchestratorService,
  body: Record<string, unknown>,
): KanbanApiResponse {
  const action = trimToNull(body.action);
  const cardId = trimToNull(body.cardId);
  const worktreeKey = trimToNull(body.worktreeKey);

  if (!action || !cardId || !worktreeKey) {
    return {
      status: 400,
      body: {
        error: "action, cardId, and worktreeKey are required",
      },
    };
  }

  try {
    const requestId = service.enqueueAction({
      action,
      cardId,
      worktreeKey,
      payload:
        body.payload && typeof body.payload === "object"
          ? (body.payload as Record<string, unknown>)
          : undefined,
    });

    return {
      status: 202,
      body: {
        requestId,
        status: service.getState(requestId)?.status ?? "queued",
      },
    };
  } catch (error) {
    return {
      status: 400,
      body: {
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export function handleCardContextRequest(
  cardQuery: string,
  resolveContext: (cardQuery: string) => ResolveKanbanCardContextResult,
): KanbanApiResponse {
  const result = resolveContext(cardQuery);
  if (!result.ok) {
    return {
      status: 404,
      body: { error: result.error },
    };
  }

  return {
    status: 200,
    body: result.context,
  };
}

export function handleBoardReadRequest(
  readBoard: () => {
    path: string;
    lanes: unknown[];
    cards: unknown[];
    errors: string[];
  },
): KanbanApiResponse {
  const board = readBoard();
  return {
    status: 200,
    body: {
      path: board.path,
      lanes: board.lanes,
      cards: board.cards,
      errors: board.errors,
    },
  };
}

export function handleActionStreamSubscribe(
  service: KanbanOrchestratorService,
  onEvent: (state: KanbanActionRequestState) => void,
): () => void {
  return service.subscribe(onEvent);
}

export function handleBoardPatchRequest(
  applyBoardPatch: () =>
    | { ok: true; summary: string }
    | { ok: false; error: string },
): KanbanApiResponse {
  const result = applyBoardPatch();
  if (!result.ok) {
    return {
      status: 400,
      body: { error: result.error },
    };
  }

  return {
    status: 200,
    body: { summary: result.summary },
  };
}

export function handleActionStatusRequest(
  service: KanbanOrchestratorService,
  requestId: string,
): KanbanApiResponse {
  const state = service.getState(requestId);
  if (!state) {
    return {
      status: 404,
      body: { error: "request not found" },
    };
  }

  return {
    status: 200,
    body: serializeState(state),
  };
}
