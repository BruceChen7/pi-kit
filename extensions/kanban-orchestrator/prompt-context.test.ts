import { describe, expect, it } from "vitest";

import { buildPromptWithKanbanContext } from "./prompt-context.js";

describe("buildPromptWithKanbanContext", () => {
  it("injects mandatory card/worktree/session context", () => {
    const prompt = buildPromptWithKanbanContext({
      userPrompt: "请实现 checkout 的接口改造",
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
    });

    expect(prompt).toContain("[KANBAN CARD CONTEXT]");
    expect(prompt).toContain("cardId: feat-checkout-v2");
    expect(prompt).toContain("branch: main--feat-checkout-v2");
    expect(prompt).toContain("chatJid: chat:feat-checkout-v2");
    expect(prompt).toContain("[USER PROMPT]");
    expect(prompt).toContain("请实现 checkout 的接口改造");
  });

  it("throws when user prompt exceeds max length", () => {
    expect(() => {
      buildPromptWithKanbanContext({
        userPrompt: "x".repeat(9),
        maxUserPromptChars: 8,
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
    }).toThrow(/prompt length exceeds/i);
  });
});
