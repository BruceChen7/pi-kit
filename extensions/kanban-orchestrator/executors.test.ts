import { describe, expect, it, vi } from "vitest";

import { createKanbanActionExecutorsWithDeps } from "./executors.js";

describe("kanban action executors", () => {
  it("injects context and dispatches custom prompt through the runtime adapter", async () => {
    const buildPrompt = vi.fn(() => "[CTX]\nhello");
    const runtimeAdapter = {
      kind: "pi",
      openSession: vi.fn(),
      resumeSession: vi.fn(),
      sendPrompt: vi.fn(async () => {}),
      interrupt: vi.fn(async () => {}),
      closeSession: vi.fn(async () => {}),
      getSessionStatus: vi.fn(async () => ({
        status: "unknown",
        resumable: true,
      })),
      streamEvents: vi.fn(async function* () {}),
    };

    const executors = createKanbanActionExecutorsWithDeps({
      runBoardApply: vi.fn(),
      runBoardReconcile: vi.fn(),
      runFeatureValidate: vi.fn(),
      runPruneMerged: vi.fn(),
      resolveContext: vi.fn(() => ({
        ok: true,
        context: {
          cardId: "feat-checkout-v2",
          title: "Checkout V2",
          kind: "feature",
          lane: "In Progress",
          parentCardId: null,
          branch: "main--feat-checkout-v2",
          baseBranch: "main",
          mergeTarget: "main",
          worktreePath: "/tmp/wt/main--feat-checkout-v2",
          session: {
            chatJid: "chat:feat-checkout-v2",
            worktreePath: "/tmp/wt/main--feat-checkout-v2",
            lastActiveAt: "2026-04-20T00:00:00.000Z",
          },
        },
      })),
      buildPromptWithContext: buildPrompt,
      runtimeAdapter,
    });

    const customPromptExecutor = executors["custom-prompt"];
    expect(customPromptExecutor).toBeTypeOf("function");
    if (!customPromptExecutor) {
      throw new Error("custom-prompt executor missing");
    }

    const result = await customPromptExecutor({
      requestId: "req-1",
      cardId: "feat-checkout-v2",
      worktreeKey: "main--feat-checkout-v2",
      payload: {
        prompt: "hello",
      },
    });

    expect(buildPrompt).toHaveBeenCalledTimes(1);
    expect(runtimeAdapter.sendPrompt).toHaveBeenCalledWith({
      sessionRef: "chat:feat-checkout-v2",
      prompt: "[CTX]\nhello",
    });
    expect(result).toMatchObject({
      summary: "custom prompt dispatched",
      chatJid: "chat:feat-checkout-v2",
      worktreePath: "/tmp/wt/main--feat-checkout-v2",
    });
  });

  it("opens a session before dispatching a custom prompt when one is missing", async () => {
    const buildPrompt = vi.fn(() => "[CTX]\nhello");
    const runtimeAdapter = {
      kind: "pi",
      openSession: vi.fn(async () => ({
        sessionRef: "chat:new-session",
        resumable: false,
      })),
      resumeSession: vi.fn(),
      sendPrompt: vi.fn(async () => {}),
      interrupt: vi.fn(async () => {}),
      closeSession: vi.fn(async () => {}),
      getSessionStatus: vi.fn(async () => ({
        status: "unknown",
        resumable: true,
      })),
      streamEvents: vi.fn(async function* () {}),
    };

    const executors = createKanbanActionExecutorsWithDeps({
      runBoardApply: vi.fn(),
      runBoardReconcile: vi.fn(),
      runFeatureValidate: vi.fn(),
      runPruneMerged: vi.fn(),
      resolveContext: vi.fn(() => ({
        ok: true,
        context: {
          cardId: "feat-checkout-v2",
          title: "Checkout V2",
          kind: "feature",
          lane: "In Progress",
          parentCardId: null,
          branch: "main--feat-checkout-v2",
          baseBranch: "main",
          mergeTarget: "main",
          worktreePath: "/tmp/wt/main--feat-checkout-v2",
          session: null,
        },
      })),
      buildPromptWithContext: buildPrompt,
      runtimeAdapter,
    });

    const customPromptExecutor = executors["custom-prompt"];
    expect(customPromptExecutor).toBeTypeOf("function");
    if (!customPromptExecutor) {
      throw new Error("custom-prompt executor missing");
    }

    const result = await customPromptExecutor({
      requestId: "req-1b",
      cardId: "feat-checkout-v2",
      worktreeKey: "main--feat-checkout-v2",
      payload: {
        prompt: "hello",
      },
    });

    expect(runtimeAdapter.openSession).toHaveBeenCalledWith({
      repoPath: "/tmp/wt/main--feat-checkout-v2",
      worktreePath: "/tmp/wt/main--feat-checkout-v2",
      taskId: "req-1b",
      metadata: {
        branch: "main--feat-checkout-v2",
        sessionRef: null,
      },
    });
    expect(runtimeAdapter.sendPrompt).toHaveBeenCalledWith({
      sessionRef: "chat:new-session",
      prompt: "[CTX]\nhello",
    });
    expect(result).toMatchObject({
      summary: "custom prompt dispatched",
      chatJid: "chat:new-session",
      worktreePath: "/tmp/wt/main--feat-checkout-v2",
    });
  });

  it("open-session applies card first when branch is missing", async () => {
    const runBoardApply = vi.fn(async () => {});
    const runtimeAdapter = {
      kind: "pi",
      openSession: vi.fn(async () => ({
        sessionRef: "chat:feat-checkout-v2",
        resumable: true,
      })),
      resumeSession: vi.fn(),
      sendPrompt: vi.fn(async () => {}),
      interrupt: vi.fn(async () => {}),
      closeSession: vi.fn(async () => {}),
      getSessionStatus: vi.fn(async () => ({
        status: "unknown",
        resumable: true,
      })),
      streamEvents: vi.fn(async function* () {}),
    };

    const resolveContext = vi
      .fn()
      .mockReturnValueOnce({
        ok: true,
        context: {
          cardId: "feat-checkout-v2",
          title: "Checkout V2",
          kind: "feature",
          lane: "In Progress",
          parentCardId: null,
          branch: null,
          baseBranch: null,
          mergeTarget: null,
          worktreePath: null,
          session: null,
        },
      })
      .mockReturnValueOnce({
        ok: true,
        context: {
          cardId: "feat-checkout-v2",
          title: "Checkout V2",
          kind: "feature",
          lane: "In Progress",
          parentCardId: null,
          branch: "main--feat-checkout-v2",
          baseBranch: "main",
          mergeTarget: "main",
          worktreePath: "/tmp/wt/main--feat-checkout-v2",
          session: null,
        },
      });

    const executors = createKanbanActionExecutorsWithDeps({
      runBoardApply,
      runBoardReconcile: vi.fn(),
      runFeatureValidate: vi.fn(),
      runPruneMerged: vi.fn(),
      resolveContext,
      buildPromptWithContext: vi.fn(),
      runtimeAdapter,
    });

    const openSessionExecutor = executors["open-session"];
    expect(openSessionExecutor).toBeTypeOf("function");
    if (!openSessionExecutor) {
      throw new Error("open-session executor missing");
    }

    const reportRuntimeStatus = vi.fn();
    const result = await openSessionExecutor({
      requestId: "req-2",
      cardId: "feat-checkout-v2",
      worktreeKey: "main--feat-checkout-v2",
      reportRuntimeStatus,
    });

    expect(reportRuntimeStatus.mock.calls).toEqual([
      [
        {
          status: "preparing",
          summary: "preparing session context for feat-checkout-v2",
        },
      ],
      [
        {
          status: "opening-session",
          summary: "opening session for main--feat-checkout-v2",
        },
      ],
    ]);
    expect(runBoardApply).toHaveBeenCalledWith("feat-checkout-v2");
    expect(runtimeAdapter.openSession).toHaveBeenCalledWith({
      repoPath: "/tmp/wt/main--feat-checkout-v2",
      worktreePath: "/tmp/wt/main--feat-checkout-v2",
      taskId: "req-2",
      metadata: {
        branch: "main--feat-checkout-v2",
        sessionRef: null,
      },
    });
    expect(result).toMatchObject({
      summary: "session opened for main--feat-checkout-v2",
      chatJid: "chat:feat-checkout-v2",
      worktreePath: "/tmp/wt/main--feat-checkout-v2",
    });
  });
});
