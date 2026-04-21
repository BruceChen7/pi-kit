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
import {
  type RequirementDetail,
  RequirementService,
} from "./requirement-service.js";
import { consumeRuntimeSessionStream } from "./runtime-stream.js";

function toRequirementErrorStatus(error: unknown): number {
  if (!(error instanceof Error)) {
    return 500;
  }

  const message = error.message.toLowerCase();
  if (message.includes("not found")) {
    return 404;
  }
  if (message.includes("required") || message.includes("not running")) {
    return 400;
  }
  return 500;
}

function respondWithRequirementDetail(
  run: () => RequirementDetail,
): KanbanApiResponse {
  try {
    return {
      status: 200,
      body: run() as unknown as Record<string, unknown>,
    };
  } catch (error) {
    return {
      status: toRequirementErrorStatus(error),
      body: {
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

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
  sendTerminalInput: (
    cardQuery: string,
    input: string,
  ) => Promise<KanbanApiResponse>;
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
  getHome: () => KanbanApiResponse;
  createRequirement: (body: Record<string, unknown>) => KanbanApiResponse;
  getRequirement: (requirementId: string) => KanbanApiResponse;
  startRequirement: (
    requirementId: string,
    body: Record<string, unknown>,
  ) => KanbanApiResponse;
  restartRequirement: (
    requirementId: string,
    body: Record<string, unknown>,
  ) => KanbanApiResponse;
  openRequirementReview: (requirementId: string) => KanbanApiResponse;
  completeRequirementReview: (requirementId: string) => KanbanApiResponse;
  reopenRequirementReview: (requirementId: string) => KanbanApiResponse;
  sendRequirementTerminalInput: (
    requirementId: string,
    input: string,
  ) => KanbanApiResponse;
  subscribeRequirementTerminalStream: (
    requirementId: string,
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
  requirementService?: RequirementService;
}): KanbanDaemon {
  const requirementService =
    input.requirementService ??
    new RequirementService({
      repoRoot: input.workspaceId,
      workspaceId: input.workspaceId,
    });
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
      sendTerminalInput(cardQuery, input) {
        return daemon.sendTerminalInput(cardQuery, input);
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
      getHome() {
        return daemon.getHome();
      },
      createRequirement(body) {
        return daemon.createRequirement(body);
      },
      getRequirement(requirementId) {
        return daemon.getRequirement(requirementId);
      },
      startRequirement(requirementId, body) {
        return daemon.startRequirement(requirementId, body);
      },
      restartRequirement(requirementId, body) {
        return daemon.restartRequirement(requirementId, body);
      },
      openRequirementReview(requirementId) {
        return daemon.openRequirementReview(requirementId);
      },
      completeRequirementReview(requirementId) {
        return daemon.completeRequirementReview(requirementId);
      },
      reopenRequirementReview(requirementId) {
        return daemon.reopenRequirementReview(requirementId);
      },
      sendRequirementTerminalInput(requirementId, terminalInput) {
        return daemon.sendRequirementTerminalInput(
          requirementId,
          terminalInput,
        );
      },
      subscribeRequirementTerminalStream(requirementId, onEvent) {
        return daemon.subscribeRequirementTerminalStream(
          requirementId,
          onEvent,
        );
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
    async sendTerminalInput(cardQuery: string, terminalInput: string) {
      const contextResult = input.resolveContext(cardQuery);
      if (!contextResult.ok) {
        return {
          status: 404,
          body: { error: contextResult.error },
        };
      }

      if (!contextResult.context.session || !recoveryContext) {
        return {
          status: 409,
          body: { error: "no active terminal session" },
        };
      }

      const runtime = input.service.getCardRuntime(
        contextResult.context.cardId,
      );
      if (!runtime.requestId) {
        return {
          status: 409,
          body: { error: "no active terminal session" },
        };
      }

      const session = recoveryContext.store.getSessionByTask(runtime.requestId);
      if (!session) {
        return {
          status: 409,
          body: { error: "no active terminal session" },
        };
      }

      const adapter = input.adapters?.[session.adapterType];
      if (!adapter) {
        return {
          status: 503,
          body: { error: "runtime adapter unavailable" },
        };
      }

      try {
        await adapter.sendPrompt({
          sessionRef: session.adapterSessionRef,
          prompt: terminalInput,
        });
      } catch (error) {
        return {
          status: 500,
          body: {
            error: error instanceof Error ? error.message : String(error),
          },
        };
      }

      return {
        status: 200,
        body: {
          accepted: true,
          mode: "line",
        },
      };
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
    getHome() {
      return {
        status: 200,
        body: requirementService.getHome() as unknown as Record<
          string,
          unknown
        >,
      };
    },
    createRequirement(body: Record<string, unknown>) {
      return respondWithRequirementDetail(() =>
        requirementService.createRequirement({
          title: typeof body.title === "string" ? body.title : "",
          prompt: typeof body.prompt === "string" ? body.prompt : "",
          projectId: typeof body.projectId === "string" ? body.projectId : null,
          projectName:
            typeof body.projectName === "string" ? body.projectName : null,
          projectPath:
            typeof body.projectPath === "string" ? body.projectPath : null,
        }),
      );
    },
    getRequirement(requirementId: string) {
      return respondWithRequirementDetail(() =>
        requirementService.getRequirementDetail(requirementId),
      );
    },
    startRequirement(requirementId: string, body: Record<string, unknown>) {
      return respondWithRequirementDetail(() =>
        requirementService.startRequirement({
          requirementId,
          command: typeof body.command === "string" ? body.command : "",
        }),
      );
    },
    restartRequirement(requirementId: string, body: Record<string, unknown>) {
      return respondWithRequirementDetail(() =>
        requirementService.restartRequirement({
          requirementId,
          command: typeof body.command === "string" ? body.command : "",
        }),
      );
    },
    openRequirementReview(requirementId: string) {
      return respondWithRequirementDetail(() =>
        requirementService.openReview(requirementId),
      );
    },
    completeRequirementReview(requirementId: string) {
      return respondWithRequirementDetail(() =>
        requirementService.completeReview(requirementId),
      );
    },
    reopenRequirementReview(requirementId: string) {
      return respondWithRequirementDetail(() =>
        requirementService.reopenReview(requirementId),
      );
    },
    sendRequirementTerminalInput(requirementId: string, terminalInput: string) {
      try {
        return {
          status: 200,
          body: requirementService.sendTerminalInput(
            requirementId,
            terminalInput,
          ) as unknown as Record<string, unknown>,
        };
      } catch (error) {
        return {
          status: toRequirementErrorStatus(error),
          body: {
            error: error instanceof Error ? error.message : String(error),
          },
        };
      }
    },
    subscribeRequirementTerminalStream(requirementId, onEvent) {
      return requirementService.subscribeTerminalStream(requirementId, onEvent);
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
