import { describe, expect, it, vi } from "vitest";

import { createKanbanDaemonActionExecutors } from "./action-executors.js";

describe("createKanbanDaemonActionExecutors", () => {
  it("opens a session through the selected adapter", async () => {
    const runtimeAdapter = {
      kind: "pi",
      openSession: vi.fn(async () => ({
        sessionRef: "chat:feat-checkout-v2",
        resumable: false,
      })),
      resumeSession: vi.fn(),
      sendPrompt: vi.fn(),
      interrupt: vi.fn(),
      closeSession: vi.fn(),
      getSessionStatus: vi.fn(),
      streamEvents: vi.fn(async function* () {}),
    };

    const executors = createKanbanDaemonActionExecutors({
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
      buildPromptWithContext: vi.fn(),
      selectRuntimeAdapter: vi.fn(() => runtimeAdapter),
    });

    const openSession = executors["open-session"];
    expect(openSession).toBeTypeOf("function");
    if (!openSession) throw new Error("missing open-session executor");

    const reportRuntimeStatus = vi.fn();
    const result = await openSession({
      requestId: "req-1",
      cardId: "feat-checkout-v2",
      worktreeKey: "main--feat-checkout-v2",
      reportRuntimeStatus,
    });

    expect(reportRuntimeStatus.mock.calls).toEqual([
      [
        {
          status: "opening-session",
          summary: "opening session for main--feat-checkout-v2",
        },
      ],
    ]);
    expect(runtimeAdapter.openSession).toHaveBeenCalledWith({
      repoPath: "/tmp/wt/main--feat-checkout-v2",
      worktreePath: "/tmp/wt/main--feat-checkout-v2",
      taskId: "req-1",
      metadata: {
        branch: "main--feat-checkout-v2",
        sessionRef: null,
      },
    });
    expect(result).toMatchObject({
      summary: "session opened for main--feat-checkout-v2",
      chatJid: "chat:feat-checkout-v2",
      worktreePath: "/tmp/wt/main--feat-checkout-v2",
      adapterType: "pi",
    });
  });

  it("opens a session before dispatching a custom prompt when no session exists", async () => {
    const runtimeAdapter = {
      kind: "pi",
      openSession: vi.fn(async () => ({
        sessionRef: "chat:new-session",
        resumable: false,
      })),
      resumeSession: vi.fn(),
      sendPrompt: vi.fn(async () => {}),
      interrupt: vi.fn(),
      closeSession: vi.fn(),
      getSessionStatus: vi.fn(),
      streamEvents: vi.fn(async function* () {}),
    };
    const buildPrompt = vi.fn(() => "[CTX]\nhello");

    const executors = createKanbanDaemonActionExecutors({
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
      selectRuntimeAdapter: vi.fn(() => runtimeAdapter),
    });

    const customPrompt = executors["custom-prompt"];
    expect(customPrompt).toBeTypeOf("function");
    if (!customPrompt) throw new Error("missing custom-prompt executor");

    const reportRuntimeStatus = vi.fn();
    const result = await customPrompt({
      requestId: "req-2",
      cardId: "feat-checkout-v2",
      worktreeKey: "main--feat-checkout-v2",
      payload: { prompt: "hello" },
      reportRuntimeStatus,
    });

    expect(reportRuntimeStatus.mock.calls).toEqual([
      [
        {
          status: "opening-session",
          summary: "opening session for custom prompt",
        },
      ],
    ]);
    expect(runtimeAdapter.openSession).toHaveBeenCalledTimes(1);
    expect(runtimeAdapter.sendPrompt).toHaveBeenCalledWith({
      sessionRef: "chat:new-session",
      prompt: "[CTX]\nhello",
    });
    expect(result).toMatchObject({
      summary: "custom prompt dispatched",
      chatJid: "chat:new-session",
      adapterType: "pi",
    });
  });
});
