import { describe, expect, it } from "vitest";

import {
  handleActionStatusRequest,
  handleActionStreamSubscribe,
  handleBoardPatchRequest,
  handleBoardReadRequest,
  handleCardContextRequest,
  handleExecuteActionRequest,
} from "./api-routes.js";
import { KanbanOrchestratorService } from "./service.js";

describe("kanban orchestrator api routes", () => {
  it("returns 202 with requestId for execute", () => {
    const service = new KanbanOrchestratorService({
      auditLogPath: "/tmp/kanban-orchestrator-api.log",
      createRequestId: () => "req-100",
      now: () => "2026-04-20T00:00:00.000Z",
      actionExecutors: {
        apply: async () => ({ summary: "applied" }),
      },
    });

    const response = handleExecuteActionRequest(service, {
      action: "apply",
      cardId: "feat-checkout-v2",
      worktreeKey: "main--feat-checkout-v2",
    });

    expect(response).toEqual({
      status: 202,
      body: {
        requestId: "req-100",
        status: "queued",
      },
    });
  });

  it("returns 400 for malformed execute payload", () => {
    const service = new KanbanOrchestratorService({
      auditLogPath: "/tmp/kanban-orchestrator-api.log",
      actionExecutors: {},
    });

    const response = handleExecuteActionRequest(service, {
      action: "",
      cardId: "",
      worktreeKey: "",
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
});
