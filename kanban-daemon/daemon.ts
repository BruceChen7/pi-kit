import type { AgentRuntimeAdapter } from "../extensions/kanban-orchestrator/agent-runtime-adapter.js";
import {
  handleActionCancelRequest,
  handleActionStatusRequest,
  handleBoardPatchRequest,
  handleBoardReadRequest,
  handleCardContextRequest,
  handleCardRuntimeRequest,
  handleExecuteActionRequest,
  type KanbanApiResponse,
} from "../extensions/kanban-orchestrator/api-routes.js";
import type { ResolveKanbanCardContextResult } from "../extensions/kanban-orchestrator/context.js";
import {
  createKanbanRuntimeServer,
  type KanbanRuntimeServer,
} from "../extensions/kanban-orchestrator/runtime-server.js";
import type {
  KanbanChildLifecycleEvent,
  KanbanTerminalEvent,
} from "../extensions/kanban-orchestrator/runtime-state.js";
import type {
  KanbanActionRequestState,
  KanbanOrchestratorService,
} from "../extensions/kanban-orchestrator/service.js";
import { createKanbanBoardSource } from "./board-source.js";
import { reconcileBoardRuntimeConflicts } from "./conflict-monitor.js";
import { recoverKanbanTasks } from "./recovery.js";
import { consumeRuntimeSessionStream } from "./runtime-stream.js";

export type KanbanDaemon = {
  readonly host: string;
  readonly token: string;
  readonly baseUrl: string;
  acceptsRuntimeWorktree: (worktreePath: string) => boolean;
  executeAction: (body: Record<string, unknown>) => KanbanApiResponse;
  getActionStatus: (requestId: string) => KanbanApiResponse;
  cancelAction: (requestId: string) => Promise<KanbanApiResponse>;
  getCardContext: (cardQuery: string) => KanbanApiResponse;
  getCardRuntime: (cardQuery: string) => KanbanApiResponse;
  readBoard: () => KanbanApiResponse;
  patchBoard: (nextBoardText: string) => KanbanApiResponse;
  subscribeActionStream: (
    onEvent: (state: KanbanActionRequestState) => void,
  ) => () => void;
  subscribeLifecycleStream: (
    onEvent: (event: KanbanChildLifecycleEvent) => void,
  ) => () => void;
  subscribeTerminalStream: (
    cardId: string,
    onEvent: (event: KanbanTerminalEvent) => void,
  ) => () => void;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

export function createKanbanDaemon(input: {
  host: string;
  port: number;
  token: string;
  workspaceId: string;
  service: KanbanOrchestratorService;
  adapters?: Record<string, AgentRuntimeAdapter>;
  boardPath?: string;
  recover?: typeof recoverKanbanTasks;
  resolveContext: (cardQuery: string) => ResolveKanbanCardContextResult;
  resolveContextByWorktreePath?: (
    worktreePath: string,
  ) => ResolveKanbanCardContextResult;
  applyBoardPatch: (
    nextBoardText: string,
  ) => { ok: true; summary: string } | { ok: false; error: string };
  readBoard: () => {
    path: string;
    lanes: unknown[];
    cards: unknown[];
    errors: string[];
  };
}): KanbanDaemon {
  const recoveryContext = input.service.getRecoveryContext();
  if (recoveryContext && input.adapters) {
    input.service.setSessionStreamHandler(async (target) => {
      const adapter = input.adapters?.[target.adapterType];
      if (!adapter) {
        return;
      }

      await consumeRuntimeSessionStream({
        store: recoveryContext.store,
        service: input.service,
        taskId: target.taskId,
        cardId: target.cardId,
        sessionRef: target.sessionRef,
        events: adapter.streamEvents(target.sessionRef),
      });
    });
  }

  const boardSource = input.boardPath
    ? createKanbanBoardSource({
        boardPath: input.boardPath,
        readBoard: input.readBoard,
      })
    : null;

  const stopConflictSubscription =
    recoveryContext && boardSource
      ? boardSource.subscribe((snapshot) => {
          reconcileBoardRuntimeConflicts({
            store: recoveryContext.store,
            service: input.service,
            repoId: recoveryContext.repoId,
            board: snapshot,
          });
        })
      : null;

  let daemon: KanbanDaemon;
  const server: KanbanRuntimeServer = createKanbanRuntimeServer({
    host: input.host,
    port: input.port,
    token: input.token,
    workspaceId: input.workspaceId,
    backend: {
      executeAction(body) {
        return daemon.executeAction(body);
      },
      getActionStatus(requestId) {
        return daemon.getActionStatus(requestId);
      },
      cancelAction(requestId) {
        return daemon.cancelAction(requestId);
      },
      getCardContext(cardQuery) {
        return daemon.getCardContext(cardQuery);
      },
      getCardRuntime(cardQuery) {
        return daemon.getCardRuntime(cardQuery);
      },
      readBoard() {
        return daemon.readBoard();
      },
      patchBoard(nextBoardText) {
        return daemon.patchBoard(nextBoardText);
      },
      subscribeActionStream(onEvent) {
        return daemon.subscribeActionStream(onEvent);
      },
      subscribeLifecycleStream(onEvent) {
        return daemon.subscribeLifecycleStream(onEvent);
      },
      subscribeTerminalStream(cardId, onEvent) {
        return daemon.subscribeTerminalStream(cardId, onEvent);
      },
    },
  });

  daemon = {
    host: input.host,
    token: input.token,
    get baseUrl() {
      return server.baseUrl;
    },
    acceptsRuntimeWorktree(worktreePath: string) {
      const result = input.resolveContextByWorktreePath?.(worktreePath);
      if (!result?.ok) {
        return false;
      }

      return (
        result.context.kind === "child" && result.context.lane === "In Progress"
      );
    },
    executeAction(body: Record<string, unknown>) {
      return handleExecuteActionRequest(input.service, body, {
        resolveContext: input.resolveContext,
      });
    },
    getActionStatus(requestId: string) {
      return handleActionStatusRequest(input.service, requestId);
    },
    async cancelAction(requestId: string) {
      const state = input.service.getState(requestId);
      if (!state) {
        return {
          status: 404,
          body: { error: "request not found" },
        };
      }

      const session =
        recoveryContext?.store.getSessionByTask(requestId) ?? null;
      if (session) {
        const adapter = input.adapters?.[session.adapterType];
        try {
          await adapter?.interrupt(session.adapterSessionRef);
        } catch {
          // phase 1 keeps local cancellation authoritative even when interrupt is unavailable
        }
        if (recoveryContext) {
          const ts = new Date().toISOString();
          recoveryContext.store.upsertSession({
            ...session,
            status: "cancelled",
            resumable: false,
            lastEventAt: ts,
            updatedAt: ts,
          });
        }
      }

      return handleActionCancelRequest(input.service, requestId);
    },
    getCardContext(cardQuery: string) {
      return handleCardContextRequest(cardQuery, input.resolveContext);
    },
    getCardRuntime(cardQuery: string) {
      return handleCardRuntimeRequest(
        cardQuery,
        input.service,
        input.resolveContext,
        (cardId) =>
          `/kanban/cards/${encodeURIComponent(cardId)}/terminal/stream`,
      );
    },
    readBoard() {
      return handleBoardReadRequest(
        () => boardSource?.getSnapshot() ?? input.readBoard(),
      );
    },
    patchBoard(nextBoardText: string) {
      const response = handleBoardPatchRequest(() =>
        input.applyBoardPatch(nextBoardText),
      );
      if (response.status === 200) {
        boardSource?.refresh();
      }
      return response;
    },
    subscribeActionStream(onEvent) {
      return input.service.subscribe(onEvent);
    },
    subscribeLifecycleStream(onEvent) {
      return input.service.subscribeLifecycle(onEvent);
    },
    subscribeTerminalStream(cardId, onEvent) {
      return input.service.subscribeTerminal(cardId, onEvent);
    },
    async start() {
      boardSource?.start();
      if (recoveryContext && input.adapters) {
        await (input.recover ?? recoverKanbanTasks)({
          store: recoveryContext.store,
          repoId: recoveryContext.repoId,
          adapters: input.adapters,
        });
        input.service.refreshPersistedRuntimeStates();
      }
      if (recoveryContext) {
        const snapshot = boardSource?.getSnapshot();
        if (snapshot) {
          reconcileBoardRuntimeConflicts({
            store: recoveryContext.store,
            service: input.service,
            repoId: recoveryContext.repoId,
            board: snapshot,
          });
        }
      }
      await server.start();
    },
    async stop() {
      stopConflictSubscription?.();
      boardSource?.stop();
      input.service.setSessionStreamHandler(null);
      await server.stop();
    },
  };

  return daemon;
}
