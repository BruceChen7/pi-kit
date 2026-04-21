import type { ResolveKanbanCardContextResult } from "./context.js";
import type {
  KanbanActionRequestState,
  KanbanOrchestratorService,
} from "./service.js";

const GLOBAL_ACTIONS = new Set(["reconcile", "validate", "prune-merged"]);

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

function deriveExecuteWorktreeKey(input: {
  action: string;
  cardId: string;
  worktreeKey: string | null;
  resolveContext?: (cardQuery: string) => ResolveKanbanCardContextResult;
}):
  | { ok: true; worktreeKey: string }
  | { ok: false; status: number; error: string } {
  if (input.worktreeKey) {
    return {
      ok: true,
      worktreeKey: input.worktreeKey,
    };
  }

  if (GLOBAL_ACTIONS.has(input.action)) {
    return {
      ok: true,
      worktreeKey: "__global__",
    };
  }

  if (!input.resolveContext) {
    return {
      ok: false,
      status: 400,
      error: "worktreeKey is required when card context cannot be resolved",
    };
  }

  const contextResult = input.resolveContext(input.cardId);
  if (!contextResult.ok) {
    return {
      ok: false,
      status: 404,
      error: contextResult.error,
    };
  }

  const worktreeKey =
    trimToNull(contextResult.context.worktreePath) ??
    trimToNull(contextResult.context.branch) ??
    contextResult.context.cardId;

  return {
    ok: true,
    worktreeKey,
  };
}

export function handleExecuteActionRequest(
  service: KanbanOrchestratorService,
  body: Record<string, unknown>,
  options?: {
    resolveContext?: (cardQuery: string) => ResolveKanbanCardContextResult;
  },
): KanbanApiResponse {
  const action = trimToNull(body.action);
  const cardId = trimToNull(body.cardId);
  const worktreeKey = trimToNull(body.worktreeKey);

  if (!action || !cardId) {
    return {
      status: 400,
      body: {
        error: "action and cardId are required",
      },
    };
  }

  const derived = deriveExecuteWorktreeKey({
    action,
    cardId,
    worktreeKey,
    resolveContext: options?.resolveContext,
  });
  if (!derived.ok) {
    return {
      status: derived.status,
      body: {
        error: derived.error,
      },
    };
  }

  try {
    const requestId = service.enqueueAction({
      action,
      cardId,
      worktreeKey: derived.worktreeKey,
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

export function handleBootstrapRequest(input: {
  workspaceId: string;
}): KanbanApiResponse {
  const workspaceId = input.workspaceId.trim();
  return {
    status: 200,
    body: {
      status: "ready",
      workspaceId,
      sessionId: `workspace:${workspaceId}`,
      capabilities: {
        stream: true,
        actions: true,
      },
    },
  };
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

export function handleCardRuntimeRequest(
  cardQuery: string,
  service: KanbanOrchestratorService,
  resolveContext: (cardQuery: string) => ResolveKanbanCardContextResult,
  buildTerminalStreamUrl: (cardId: string) => string,
): KanbanApiResponse {
  const contextResult = resolveContext(cardQuery);
  if (!contextResult.ok) {
    return {
      status: 404,
      body: { error: contextResult.error },
    };
  }

  const runtime = service.getCardRuntime(contextResult.context.cardId);
  return {
    status: 200,
    body: {
      cardId: contextResult.context.cardId,
      lane: contextResult.context.lane,
      session: contextResult.context.session
        ? {
            chatJid: contextResult.context.session.chatJid,
            worktreePath: contextResult.context.session.worktreePath,
          }
        : null,
      execution: {
        status: runtime.status,
        summary: runtime.summary,
        requestId: runtime.requestId,
      },
      conflict: runtime.conflict,
      completion: {
        readyForReview: runtime.status === "completed",
        completedAt: runtime.completedAt,
      },
      terminal: {
        available:
          runtime.terminalAvailable || Boolean(contextResult.context.session),
        protocol: runtime.terminalProtocol,
        streamUrl: buildTerminalStreamUrl(contextResult.context.cardId),
      },
    },
  };
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

export function handleActionCancelRequest(
  service: KanbanOrchestratorService,
  requestId: string,
): KanbanApiResponse {
  const state = service.cancelAction(requestId);
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
