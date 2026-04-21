import { describe, expect, it } from "vitest";

import {
  handleActionStatusRequest,
  handleActionStreamSubscribe,
  handleBoardPatchRequest,
  handleBoardReadRequest,
  handleCardContextRequest,
  handleCardRuntimeRequest,
  handleExecuteActionRequest,
  handleTerminalStreamSubscribe,
} from "./api-routes.js";
import { KanbanOrchestratorService } from "./service.js";
import { KanbanRuntimeStateStore } from "./runtime-state.js";

describe("kanban orchestrator api routes", () => {
  it("returns 202 with requestId for execute when backend derives worktreeKey", () => {
    const service = new KanbanOrchestratorService({
      auditLogPath: "/tmp/kanban-orchestrator-api.log",
      createRequestId: () => "req-100",
      now: () => "2026-04-20T00:00:00.000Z",
      actionExecutors: {
        apply: async () => ({ summary: "applied" }),
      },
    });

    const response = handleExecuteActionRequest(
      service,
      {
        action: "apply",
        cardId: "feat-checkout-v2",
      },
      {
        resolveContext: () => ({
          ok: true,
          context: {
            cardId: "feat-checkout-v2",
            worktreePath: "/tmp/wt/main--feat-checkout-v2",
            branch: "main--feat-checkout-v2",
          },
        }),
      },
    );

    expect(response).toEqual({
      status: 202,
      body: {
        requestId: "req-100",
        status: "queued",
      },
    });
    expect(service.getState("req-100")?.worktreeKey).toBe(
      "/tmp/wt/main--feat-checkout-v2",
    );
  });

  it("returns 202 for global execute without worktreeKey", () => {
    const service = new KanbanOrchestratorService({
      auditLogPath: "/tmp/kanban-orchestrator-api.log",
      createRequestId: () => "req-global-100",
      now: () => "2026-04-20T00:00:00.000Z",
      actionExecutors: {
        reconcile: async () => ({ summary: "reconciled" }),
      },
    });

    const response = handleExecuteActionRequest(service, {
      action: "reconcile",
      cardId: "__global__",
    });

    expect(response).toEqual({
      status: 202,
      body: {
        requestId: "req-global-100",
        status: "queued",
      },
    });
    expect(service.getState("req-global-100")?.worktreeKey).toBe("__global__");
  });

  it("returns 400 for malformed execute payload", () => {
    const service = new KanbanOrchestratorService({
      auditLogPath: "/tmp/kanban-orchestrator-api.log",
      actionExecutors: {},
    });

    const response = handleExecuteActionRequest(service, {
      action: "",
      cardId: "",
    });

    expect(response.status).toBe(400);
  });

  it("returns card context from resolver", () => {
    const response = handleCardContextRequest("feat-checkout-v2", () => ({
      ok: true,
      context: {
        cardId: "feat-checkout-v2",
        branch: "main--feat-checkout-v2",
      },
    }));

    expect(response).toEqual({
      status: 200,
      body: {
        cardId: "feat-checkout-v2",
        branch: "main--feat-checkout-v2",
      },
    });
  });

  it("returns 404 for unknown request id", () => {
    const service = new KanbanOrchestratorService({
      auditLogPath: "/tmp/kanban-orchestrator-api.log",
      actionExecutors: {},
    });

    const response = handleActionStatusRequest(service, "req-missing");

    expect(response).toEqual({
      status: 404,
      body: { error: "request not found" },
    });
  });

  it("returns 404 when context resolver fails", () => {
    const response = handleCardContextRequest("feat-missing", () => ({
      ok: false,
      error: "Unknown board card: feat-missing",
    }));

    expect(response).toEqual({
      status: 404,
      body: { error: "Unknown board card: feat-missing" },
    });
  });

  it("returns board snapshot", () => {
    const response = handleBoardReadRequest(() => ({
      path: "workitems/features.kanban.md",
      lanes: [],
      cards: [],
      errors: [],
    }));

    expect(response).toEqual({
      status: 200,
      body: {
        path: "workitems/features.kanban.md",
        lanes: [],
        cards: [],
        errors: [],
      },
    });
  });

  it("returns 200 when board patch succeeds", () => {
    const response = handleBoardPatchRequest(() => ({
      ok: true,
      summary: "board updated",
    }));

    expect(response).toEqual({
      status: 200,
      body: { summary: "board updated" },
    });
  });

  it("returns 400 when board patch fails", () => {
    const response = handleBoardPatchRequest(() => ({
      ok: false,
      error: "invalid lane transition",
    }));

    expect(response).toEqual({
      status: 400,
      body: { error: "invalid lane transition" },
    });
  });

  it("returns card runtime detail with terminal metadata", () => {
    const runtimeState = new KanbanRuntimeStateStore();
    runtimeState.recordChildLifecycle({
      type: "child-running",
      cardId: "child-pricing-widget",
      summary: "agent started",
      ts: "2026-04-20T00:00:00.000Z",
    });

    const response = handleCardRuntimeRequest(
      "child-pricing-widget",
      runtimeState,
      () => ({
        ok: true,
        context: {
          cardId: "child-pricing-widget",
          title: "Split pricing widget",
          kind: "child",
          lane: "In Progress",
          parentCardId: "feat-checkout-v2",
          branch: "main--feat-checkout-v2--child-pricing-widget",
          baseBranch: "main--feat-checkout-v2",
          mergeTarget: "main--feat-checkout-v2",
          worktreePath: "/tmp/wt/main--feat-checkout-v2--child-pricing-widget",
          session: {
            chatJid: "chat:child-pricing-widget",
            worktreePath:
              "/tmp/wt/main--feat-checkout-v2--child-pricing-widget",
            lastActiveAt: "2026-04-20T00:00:00.000Z",
          },
        },
      }),
      (cardId) => `/kanban/cards/${cardId}/terminal/stream`,
    );

    expect(response).toEqual({
      status: 200,
      body: {
        cardId: "child-pricing-widget",
        lane: "In Progress",
        session: {
          chatJid: "chat:child-pricing-widget",
          worktreePath: "/tmp/wt/main--feat-checkout-v2--child-pricing-widget",
        },
        execution: {
          status: "running",
          summary: "agent started",
          requestId: null,
        },
        completion: {
          readyForReview: false,
          completedAt: null,
        },
        terminal: {
          available: true,
          protocol: "sse-text-stream",
          streamUrl: "/kanban/cards/child-pricing-widget/terminal/stream",
        },
      },
    });
  });

  it("subscribes to action stream and forwards events", async () => {
    const service = new KanbanOrchestratorService({
      auditLogPath: "/tmp/kanban-orchestrator-api.log",
      createRequestId: () => "req-stream",
      now: () => "2026-04-20T00:00:00.000Z",
      actionExecutors: {
        apply: async () => ({ summary: "ok" }),
      },
    });

    const statuses: string[] = [];
    const unsubscribe = handleActionStreamSubscribe(service, (event) => {
      statuses.push(event.status);
    });

    const requestId = service.enqueueAction({
      action: "apply",
      cardId: "feat-checkout-v2",
      worktreeKey: "main--feat-checkout-v2",
    });
    await service.waitFor(requestId);

    unsubscribe();
    expect(statuses).toEqual(["queued", "running", "success"]);
  });

  it("subscribes to terminal stream and replays buffered chunks", () => {
    const runtimeState = new KanbanRuntimeStateStore();
    runtimeState.recordChildLifecycle({
      type: "child-running",
      cardId: "child-pricing-widget",
      summary: "agent started",
      ts: "2026-04-20T00:00:00.000Z",
    });
    runtimeState.appendTerminalChunk({
      cardId: "child-pricing-widget",
      chunk: "hello world",
      ts: "2026-04-20T00:00:01.000Z",
    });

    const events: string[] = [];
    const unsubscribe = handleTerminalStreamSubscribe(
      runtimeState,
      "child-pricing-widget",
      (event) => {
        events.push(
          event.type === "chunk" ? `${event.type}:${event.chunk}` : event.type,
        );
      },
    );
    unsubscribe();

    expect(events).toEqual(["ready", "status", "chunk:hello world"]);
  });
});
