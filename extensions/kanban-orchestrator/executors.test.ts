import { describe, expect, it, vi } from "vitest";

import { createKanbanActionExecutorsWithDeps } from "./executors.js";

describe("kanban action executors", () => {
  it("injects context and dispatches custom prompt", async () => {
    const sendUserMessage = vi.fn();
    const buildPrompt = vi.fn(() => "[CTX]\nhello");

    const executors = createKanbanActionExecutorsWithDeps({
      runBoardApply: vi.fn(),
      runBoardReconcile: vi.fn(),
      runFeatureValidate: vi.fn(),
      runPruneMerged: vi.fn(),
      runFeatureSwitch: vi.fn(),
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
      sendUserMessage,
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
    expect(sendUserMessage).toHaveBeenCalledWith("[CTX]\nhello", {
      deliverAs: "followUp",
    });
    expect(result).toMatchObject({
      summary: "custom prompt dispatched",
      chatJid: "chat:feat-checkout-v2",
      worktreePath: "/tmp/wt/main--feat-checkout-v2",
    });
  });

  it("open-session applies card first when branch is missing", async () => {
    const runBoardApply = vi.fn(async () => {});
    const runFeatureSwitch = vi.fn(async () => {});

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
      runFeatureSwitch,
      resolveContext,
      buildPromptWithContext: vi.fn(),
      sendUserMessage: vi.fn(),
    });

    const openSessionExecutor = executors["open-session"];
    expect(openSessionExecutor).toBeTypeOf("function");
    if (!openSessionExecutor) {
      throw new Error("open-session executor missing");
    }

    const result = await openSessionExecutor({
      requestId: "req-2",
      cardId: "feat-checkout-v2",
      worktreeKey: "main--feat-checkout-v2",
    });

    expect(runBoardApply).toHaveBeenCalledWith("feat-checkout-v2");
    expect(runFeatureSwitch).toHaveBeenCalledWith("main--feat-checkout-v2");
    expect(result.summary).toContain("session opened");
  });
});
